// Alerts + decision-journal review. Runs inside the cron job.
//
// Alerts: the states worth catching happen on days nobody is looking.
// The alerts table's PRIMARY KEY (date, kind, key) IS the rate limit —
// at most one alert per state per day, by construction. Delivery is
// webhook (ALERT_WEBHOOK_URL) and/or email (RESEND_API_KEY +
// ALERT_EMAIL_TO/FROM); with neither configured, alerts still land in the
// table and surface on the page — never silently dropped.

import { KPIS, kpiById } from '../registry/kpis.ts';
import type { Point } from '../sources/types.ts';
import type { BarometerResult } from '../compute/barometer.ts';
import { isoDaysAgo, valueOnOrBefore } from '../compute/stats.ts';
import type { Env } from './index.ts';

const RESPONSE_GAP_ALERT = 2.0;
const PCTL_HI = 95;
const PCTL_LO = 5;

interface Candidate {
  kind: string;
  key: string;
  message: string; // states what changed, what drove it, what it was before
  detail?: unknown;
}

export async function runAlerts(
  env: Env,
  result: BarometerResult,
  seriesMap: Map<string, Point[]>,
  prevFlags: Map<string, string | null>,
  currFlags: Map<string, string | null>,
  nowIso: string,
): Promise<string[]> {
  const log: string[] = [];
  const today = nowIso.slice(0, 10);
  const hist = result.history;
  if (!hist.length) return log;
  const lastDate = hist[hist.length - 1].date;
  const candidates: Candidate[] = [];

  // 1. regime change on either gauge (fresh transitions only)
  for (const c of result.changes) {
    if (c.date !== lastDate) continue;
    const top = c.drivers.slice(0, 3).map((d) => `${d.id} z=${d.z.toFixed(1)}`).join(', ');
    candidates.push({
      kind: 'regime',
      key: `${c.layer}:${c.window}`,
      message: `${c.layer.toUpperCase()} (${c.window}) ${c.from_regime} → ${c.to_regime} at ${c.score.toFixed(2)} — drivers: ${top}`,
      detail: c,
    });
  }

  // 2. divergence configuration opening or closing
  const prevRow = hist.length >= 2 ? hist[hist.length - 2] : null;
  for (const w of ['2y', '5y'] as const) {
    const now = result.divergenceNow[w];
    const was = prevRow ? (w === '2y' ? prevRow.div_2y : prevRow.div_5y) === 1 : false;
    if (now.active && !was) {
      candidates.push({ kind: 'divergence', key: `${w}:open`, message: `DIVERGENCE OPENED (${w}) — altitude high while pressure falls; the pre-bust configuration. Was: no divergence.`, detail: now });
    } else if (!now.active && was) {
      candidates.push({ kind: 'divergence', key: `${w}:close`, message: `DIVERGENCE CLOSED (${w}) — the high-altitude/low-pressure configuration has resolved.`, detail: now });
    }
  }

  // 3. any signal input crossing its 95th (or 5th) percentile
  for (const def of KPIS.filter((k) => k.subIndex)) {
    const pts = seriesMap.get(def.id) ?? [];
    if (pts.length < 120) continue;
    const now = pctile(pts, pts.length - 1);
    const was = pctile(pts, pts.length - 2);
    const v = pts[pts.length - 1];
    if (now >= PCTL_HI && was < PCTL_HI) {
      candidates.push({ kind: 'input95', key: `${def.id}:hi`, message: `${def.label} crossed its ${PCTL_HI}th percentile — ${v.value.toFixed(2)} on ${v.date} (was ${ordinal(was)} pct the day before).` });
    } else if (now <= PCTL_LO && was > PCTL_LO) {
      candidates.push({ kind: 'input95', key: `${def.id}:lo`, message: `${def.label} crossed its ${PCTL_LO}th percentile — ${v.value.toFixed(2)} on ${v.date} (was ${ordinal(was)} pct the day before).` });
    }
  }

  // 4. the Response Gap breaching its threshold
  const rg = seriesMap.get('response_gap') ?? [];
  if (rg.length >= 2) {
    const [prev, cur] = [rg[rg.length - 2], rg[rg.length - 1]];
    if (cur.value >= RESPONSE_GAP_ALERT && prev.value < RESPONSE_GAP_ALERT) {
      candidates.push({ kind: 'response_gap', key: 'breach', message: `THE RESPONSE GAP breached ${RESPONSE_GAP_ALERT.toFixed(1)}z — credit stress rising without a balance-sheet response (${cur.value.toFixed(2)}z, was ${prev.value.toFixed(2)}z). This is the configuration Hunter's thesis names.` });
    }
  }

  // 5. thesis levels: IGV H&S state change; any distance-to-target crossing 0
  for (const def of KPIS) {
    if (def.flagLevels) {
      const was = prevFlags.get(def.id) ?? null;
      const now = currFlags.get(def.id) ?? null;
      if (was && now && was !== now) {
        candidates.push({ kind: 'thesis', key: `${def.id}:flag`, message: `${def.label}: ${was} → ${now}.`, detail: { was, now } });
      }
    }
    if (def.derive?.type === 'target_distance') {
      const pts = seriesMap.get(def.id) ?? [];
      if (pts.length >= 2) {
        const [prev, cur] = [pts[pts.length - 2], pts[pts.length - 1]];
        if ((prev.value > 0) !== (cur.value > 0)) {
          candidates.push({ kind: 'thesis', key: `${def.id}:target`, message: `${def.label}: target level crossed (distance ${prev.value.toFixed(1)}% → ${cur.value.toFixed(1)}%).` });
        }
      }
    }
  }

  // insert (PK dedupes = one per state per day) and deliver the new ones
  for (const c of candidates) {
    const res = await env.DB.prepare(
      `INSERT INTO alerts (date, kind, key, message, detail, delivered, created_at)
       VALUES (?,?,?,?,?,NULL,?) ON CONFLICT(date, kind, key) DO NOTHING`,
    ).bind(today, c.kind, c.key, c.message, JSON.stringify(c.detail ?? null), nowIso).run();
    const isNew = (res.meta?.changes ?? 0) > 0;
    if (!isNew) continue;
    const delivered = await deliver(env, c);
    await env.DB.prepare('UPDATE alerts SET delivered = ? WHERE date = ? AND kind = ? AND key = ?')
      .bind(JSON.stringify(delivered), today, c.kind, c.key).run();
    log.push(`alert [${c.kind}/${c.key}] via ${delivered.join('+') || 'log-only'}: ${c.message}`);
  }
  return log;
}

async function deliver(env: Env, c: Candidate): Promise<string[]> {
  const channels: string[] = [];
  if (env.ALERT_WEBHOOK_URL) {
    try {
      const res = await fetch(env.ALERT_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: `JM FINANCIAL CONDITIONS BAROMETER — ${c.message}`, kind: c.kind, key: c.key, detail: c.detail ?? null }),
      });
      if (res.ok) channels.push('webhook');
    } catch { /* recorded as undelivered */ }
  }
  if (env.RESEND_API_KEY && env.ALERT_EMAIL_TO) {
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${env.RESEND_API_KEY}` },
        body: JSON.stringify({
          from: env.ALERT_EMAIL_FROM ?? 'barometer@resend.dev',
          to: [env.ALERT_EMAIL_TO],
          subject: `JM BAROMETER · ${c.kind}: ${c.key}`,
          text: c.message,
        }),
      });
      if (res.ok) channels.push('email');
    } catch { /* recorded as undelivered */ }
  }
  return channels;
}

/** Percentile rank of pts[i] against the whole history up to i. */
function pctile(pts: Point[], i: number): number {
  if (i < 0) return 50;
  let below = 0;
  for (let j = 0; j <= i; j++) if (pts[j].value <= pts[i].value) below++;
  return (below / (i + 1)) * 100;
}

function ordinal(n: number): string {
  const v = Math.round(n);
  const s = ['th', 'st', 'nd', 'rd'], k = v % 100;
  return v + (s[(k - 20) % 10] || s[k] || s[0]);
}

// ── decision-journal review: fill in what actually happened ─────────────

export async function reviewJournal(env: Env, seriesMap: Map<string, Point[]>): Promise<string[]> {
  const log: string[] = [];
  const rows = await env.DB.prepare(
    'SELECT id, created_at, stance, instruments, realized FROM journal_entries',
  ).all<{ id: number; created_at: string; stance: string | null; instruments: string | null; realized: string | null }>();

  const spx = seriesMap.get('spx') ?? [];
  const HORIZONS = { m1: 30, m3: 91, m6: 182 } as const;

  for (const row of rows.results ?? []) {
    const prev = row.realized ? JSON.parse(row.realized) : null;
    if (prev?.spx?.m6 !== null && prev?.spx?.m6 !== undefined) continue; // fully settled
    const entryDate = row.created_at.slice(0, 10);
    const spxFwd: Record<string, number | null> = {};
    for (const [h, days] of Object.entries(HORIZONS)) spxFwd[h] = fwd(spx, entryDate, days);
    const instruments: Record<string, Record<string, number | null>> = {};
    for (const id of safeIds(row.instruments)) {
      const pts = seriesMap.get(id);
      if (!pts?.length) continue;
      instruments[id] = {};
      for (const [h, days] of Object.entries(HORIZONS)) instruments[id][h] = fwd(pts, entryDate, days);
    }
    // calibration: did the stated stance match what the S&P then did (3m)?
    let hit3m: boolean | null = null;
    if (spxFwd.m3 !== null && (row.stance === 'bullish' || row.stance === 'bearish')) {
      hit3m = row.stance === 'bullish' ? spxFwd.m3 > 0 : spxFwd.m3 < 0;
    }
    const realized = { spx: spxFwd, instruments, hit3m, reviewed_at: new Date().toISOString() };
    if (JSON.stringify(realized.spx) !== JSON.stringify(prev?.spx ?? null) || prev === null) {
      await env.DB.prepare('UPDATE journal_entries SET realized = ? WHERE id = ?')
        .bind(JSON.stringify(realized), row.id).run();
      log.push(`journal #${row.id}: realized updated (spx 3m=${spxFwd.m3 ?? 'pending'})`);
    }
  }
  return log;
}

function fwd(pts: Point[], from: string, days: number): number | null {
  const start = valueOnOrBefore(pts, from);
  const targetDate = isoDaysAgo(from, -days); // negative = forward
  if (!pts.length || pts[pts.length - 1].date < targetDate) return null; // horizon not elapsed
  const end = valueOnOrBefore(pts, targetDate);
  if (!start || !end || end.date <= start.date) return null;
  return Math.abs(start.value) > 1e-12
    ? Math.round(((end.value - start.value) / start.value) * 10000) / 100
    : null;
}

function safeIds(json: string | null): string[] {
  if (!json) return [];
  try {
    const arr = JSON.parse(json);
    return Array.isArray(arr) ? arr.filter((x) => typeof x === 'string' && kpiById.has(x)).slice(0, 10) : [];
  } catch { return []; }
}
