// Alerts + decision-journal review. Runs inside the cron job.
//
// Alerts: the states worth catching happen on days nobody is looking.
// Two dedup mechanisms, because one is not enough. The alerts table's
// PRIMARY KEY (date, kind, key) allows at most one alert per state per
// day. On top of that, LEVEL conditions carry a latch in `meta` so they
// fire once on becoming true and stay silent until they clear — without
// it, a condition that simply persists re-fires every single day. Delivery is
// webhook (ALERT_WEBHOOK_URL) and/or email (RESEND_API_KEY +
// ALERT_EMAIL_TO/FROM); with neither configured, alerts still land in the
// table and surface on the page — never silently dropped.

import { KPIS, kpiById } from '../registry/kpis.ts';
import type { Point } from '../sources/types.ts';
import type { BarometerResult } from '../compute/barometer.ts';
import { isoDaysAgo, valueOnOrBefore } from '../compute/stats.ts';
import type { Env } from './index.ts';
import TH from '../../config/thresholds.json' with { type: 'json' };
import TG from '../../config/hunter_targets.json' with { type: 'json' };

const RESPONSE_GAP_ALERT = 2.0;
const PCTL_HI = 95;
const PCTL_LO = 5;

interface Candidate {
  kind: string;
  key: string;
  message: string; // states what changed, what drove it, what it was before
  detail?: unknown;
  /** True for LEVEL conditions ("HY above 6%") as opposed to EDGE events
   *  ("regime changed today"). A stateful candidate fires once when the
   *  condition becomes true and stays silent while it remains true — the
   *  (date, kind, key) primary key alone cannot do that, because the date
   *  differs every day and the same condition re-fires indefinitely. */
  stateful?: boolean;
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
  const regimeNow = new Map<string, string>();

  // 1. regime change on either gauge.
  //
  //    Fires on the ADOPTED regime differing from the one last alerted,
  //    not on a change appearing at the end of a freshly recomputed
  //    history. The barometer rebuilds its whole regime path every run, so
  //    a marginal input revision can move where a transition lands and
  //    re-present it as new — which is how ALTITUDE (5y) produced eight
  //    near-identical alerts in a fortnight. Comparing against the stored
  //    last-alerted regime is immune to that, because it asks the only
  //    question that matters to a reader: is the regime now different from
  //    the one I was last told about?
  const lastAlerted = new Map<string, string>();
  const regimeRows = await env.DB.prepare("SELECT key, value FROM meta WHERE key LIKE 'alert_regime:%'")
    .all<{ key: string; value: string }>();
  for (const r of regimeRows.results ?? []) lastAlerted.set(r.key.slice(14), r.value);

  for (const layer of ['pressure', 'altitude'] as const) {
    for (const w of ['2y', '5y'] as const) {
      const adopted = result.detail[layer][w].regime;
      if (!adopted) continue;
      const id = `${layer}:${w}`;
      const was = lastAlerted.get(id) ?? null;
      regimeNow.set(id, adopted);
      if (was === adopted) continue;
      if (was === null) continue;            // first sighting is not a change
      const c = [...result.changes].reverse().find((x) => x.layer === layer && x.window === w && x.to_regime === adopted);
      const top = (c?.drivers ?? []).slice(0, 3).map((d) => `${d.id} z=${d.z.toFixed(1)}`).join(', ');
      candidates.push({
        kind: 'regime',
        key: id,
        message: `${layer.toUpperCase()} (${w}) ${was} → ${adopted}`
          + (c ? ` at ${c.score.toFixed(2)}, adopted ${c.date}` : '')
          + (top ? ` — drivers: ${top}` : ''),
        detail: { layer, window: w, from: was, to: adopted, change: c ?? null },
      });
    }
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
    // Evaluated on the LEVEL and marked stateful. The previous version
    // fired on a day-over-day transition, which a series that has stopped
    // advancing re-satisfies every single run: the same HY OAS alert fired
    // six times over twelve days from one unchanged observation.
    if (now >= PCTL_HI) {
      candidates.push({ kind: 'input95', key: `${def.id}:hi`, stateful: true, message: `${def.label} is at or above its ${PCTL_HI}th percentile — ${v.value.toFixed(2)} on ${v.date} (${ordinal(now)} pct).` });
    } else if (now <= PCTL_LO) {
      candidates.push({ kind: 'input95', key: `${def.id}:lo`, stateful: true, message: `${def.label} is at or below its ${PCTL_LO}th percentile — ${v.value.toFixed(2)} on ${v.date} (${ordinal(now)} pct).` });
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

  // 6. ordered state bands crossing — a named level being reached (the
  //    real-yield impulse entering APPROACHING at 50bp or DANGER at 75bp).
  //    Compared on band identity, never on the tile's flag string, which
  //    carries a days-held counter and would therefore differ every day.
  for (const def of KPIS) {
    if (!def.stateBands?.length) continue;
    const pts = seriesMap.get(def.id) ?? [];
    if (pts.length < 2) continue;
    const bandOf = (v: number) => {
      let name = def.stateBands![0].label;
      for (const b of def.stateBands!) if (v >= b.atLeast) name = b.label;
      return name;
    };
    const cur = pts[pts.length - 1], prev = pts[pts.length - 2];
    const now = bandOf(cur.value), was = bandOf(prev.value);
    if (now === was) continue;
    const unit = def.unit ? ` ${def.unit}` : '';
    candidates.push({
      kind: 'state',
      key: `${def.id}:${now}`,
      message: `${def.label}: ${was} → ${now} at ${cur.value.toFixed(def.decimals)}${unit} on ${cur.date}`
        + ` (was ${prev.value.toFixed(def.decimals)}${unit}).`
        + (def.stateBandsCaveat ? ` ${def.stateBandsCaveat}` : ''),
      detail: { was, now, value: cur.value, date: cur.date },
    });
  }

  // § 17 cockpit thresholds, all stateful: these are levels, not events.
  candidates.push(...cockpitAlerts(seriesMap));

  log.push(...await fire(env, candidates, today, nowIso));

  // Record what the reader has now been told, so the next run compares
  // against it rather than against a rebuilt history.
  for (const [id, regime] of regimeNow) {
    await env.DB.prepare(
      "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    ).bind(`alert_regime:${id}`, regime).run();
  }
  return log;
}

/** Insert, dedupe and deliver.
 *
 *  Two mechanisms, because one is not enough. The (date, kind, key) primary
 *  key stops the same alert appearing twice in one day. It does NOT stop a
 *  LEVEL condition re-firing tomorrow, and the day after, for as long as it
 *  holds — which is how one unchanged HY OAS observation produced six
 *  identical alerts over twelve days. So a stateful candidate also carries a
 *  latch in `meta`: it fires on the false→true edge and stays silent until
 *  the condition clears. Keys that are no longer active are unlatched here,
 *  which is what re-arms them. */
async function fire(env: Env, candidates: Candidate[], today: string, nowIso: string): Promise<string[]> {
  const log: string[] = [];
  const rows = await env.DB.prepare("SELECT key FROM meta WHERE key LIKE 'alert_on:%'").all<{ key: string }>();
  const latched = new Set((rows.results ?? []).map((r) => r.key.slice(9)));
  const activeNow = new Set(candidates.filter((c) => c.stateful).map((c) => `${c.kind}:${c.key}`));

  for (const c of candidates) {
    const id = `${c.kind}:${c.key}`;
    if (c.stateful && latched.has(id)) continue;  // condition already reported

    const res = await env.DB.prepare(
      `INSERT INTO alerts (date, kind, key, message, detail, delivered, created_at)
       VALUES (?,?,?,?,?,NULL,?) ON CONFLICT(date, kind, key) DO NOTHING`,
    ).bind(today, c.kind, c.key, c.message, JSON.stringify(c.detail ?? null), nowIso).run();
    if ((res.meta?.changes ?? 0) === 0) continue;

    if (c.stateful) {
      await env.DB.prepare(
        "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      ).bind(`alert_on:${id}`, today).run();
    }
    const delivered = await deliver(env, c);
    await env.DB.prepare('UPDATE alerts SET delivered = ? WHERE date = ? AND kind = ? AND key = ?')
      .bind(JSON.stringify(delivered), today, c.kind, c.key).run();
    log.push(`alert [${id}] via ${delivered.join('+') || 'log-only'}: ${c.message}`);
  }

  // re-arm anything that has cleared
  for (const id of latched) {
    if (activeNow.has(id)) continue;
    await env.DB.prepare('DELETE FROM meta WHERE key = ?').bind(`alert_on:${id}`).run();
    log.push(`alert cleared [${id}] — condition no longer holds, re-armed`);
  }
  return log;
}

/** The thresholds named in section 17 of the brief, read straight from
 *  config/thresholds.json. All level conditions, so all latched. */
function cockpitAlerts(m: Map<string, Point[]>): Candidate[] {
  const A = TH.alerts;
  const out: Candidate[] = [];
  const last = (id: string) => { const p = m.get(id); return p?.length ? p[p.length - 1] : null; };
  const chg = (id: string, days: number) => {
    const p = m.get(id); if (!p?.length) return null;
    const end = p[p.length - 1];
    const then = valueOnOrBefore(p, isoDaysAgo(end.date, days));
    return !then || then.date >= end.date ? null : end.value - then.value;
  };
  const pctChg = (id: string, days: number) => {
    const p = m.get(id); if (!p?.length) return null;
    const end = p[p.length - 1];
    const then = valueOnOrBefore(p, isoDaysAgo(end.date, days));
    return !then || then.date >= end.date || Math.abs(then.value) < 1e-12
      ? null : ((end.value - then.value) / Math.abs(then.value)) * 100;
  };

  const spx6 = pctChg('spx', 182);
  if (spx6 !== null && spx6 >= A.ret6m_pct) {
    out.push({ kind: 'meltup', key: 'ret6m', stateful: true,
      message: `S&P six-month return +${spx6.toFixed(1)}% — at or past the ${A.ret6m_pct}% melt-up alert level.` });
  }

  const t10 = last('us10y');
  if (t10 && t10.value >= A.us10y_pct) {
    out.push({ kind: 'rates', key: 'us10y', stateful: true,
      message: `10Y Treasury ${t10.value.toFixed(2)}% on ${t10.date} — at or above ${A.us10y_pct}%.` });
  }

  const hy = last('hy_oas');
  if (hy && hy.value >= A.hy_level_pct) {
    out.push({ kind: 'credit', key: 'hy_level', stateful: true,
      message: `HY OAS ${hy.value.toFixed(2)}% on ${hy.date} — at or above the ${A.hy_level_pct}% stress level.` });
  }
  const hyRoc = chg('hy_oas', 28);
  if (hyRoc !== null && hyRoc * 100 >= A.hy_roc20_bp) {
    out.push({ kind: 'credit', key: 'hy_roc20', stateful: true,
      message: `HY OAS widened ${(hyRoc * 100).toFixed(0)}bp over 20 sessions — past the ${A.hy_roc20_bp}bp alert level.` });
  }

  const vix = last('vix');
  if (vix && vix.value >= A.vix_level) {
    out.push({ kind: 'vol', key: 'vix', stateful: true,
      message: `VIX ${vix.value.toFixed(1)} on ${vix.date} — at or above ${A.vix_level}.` });
  }

  // S&P drawdown from its trailing one-year peak
  const spx = m.get('spx');
  if (spx?.length) {
    const end = spx[spx.length - 1];
    const from = isoDaysAgo(end.date, 365);
    let peak = -Infinity;
    for (const p of spx) { if (p.date >= from && p.date <= end.date && p.value > peak) peak = p.value; }
    if (Number.isFinite(peak) && peak > 0) {
      const dd = ((end.value - peak) / peak) * 100;
      if (dd <= A.drawdown_pct) {
        out.push({ kind: 'internals', key: 'drawdown', stateful: true,
          message: `S&P ${dd.toFixed(1)}% from its one-year peak — past the ${A.drawdown_pct}% alert level.` });
      }
    }
  }

  const walcl4 = chg('walcl', 28); // stored in $tn
  if (walcl4 !== null && walcl4 * 1000 >= A.walcl_4w_bn) {
    out.push({ kind: 'liquidity', key: 'walcl_4w', stateful: true,
      message: `Fed balance sheet +$${(walcl4 * 1000).toFixed(0)}bn over four weeks — past the $${A.walcl_4w_bn}bn alert level.` });
  }

  // Hunter targets coming within range
  for (const [id, label, target] of [
    ['spx', 'S&P 500', TG.meltup.sp500.target], ['dow', 'Dow Jones', TG.meltup.dow.target],
    ['nasdaq', 'NASDAQ', TG.meltup.nasdaq.target], ['rut', 'Russell 2000', TG.meltup.russell2000.target],
    ['gold', 'Gold', TG.meltup.gold.target], ['silver', 'Silver', TG.meltup.silver.target],
  ] as [string, string, number][]) {
    const l = last(id);
    if (!l || l.value <= 0) continue;
    const dist = ((target - l.value) / l.value) * 100;
    if (dist >= 0 && dist <= A.target_within_pct) {
      out.push({ kind: 'target', key: id, stateful: true,
        message: `${label} is ${dist.toFixed(1)}% from its Hunter target of ${target.toLocaleString('en-US')} (${l.value.toFixed(0)} on ${l.date}) — inside the ${A.target_within_pct}% alert band.` });
    }
  }

  return out;
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
