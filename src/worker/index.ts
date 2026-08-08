// Request handler. HARD RULE: no computation here — every endpoint is an
// indexed D1 read of rows the cron job already finished. Free-tier Workers
// get 10ms CPU per request; this path uses a fraction of that.

import { KPIS, CLUSTERS, kpiById } from '../registry/kpis.ts';
import { ZONE_PCTS } from '../registry/signal.ts';
import { runScheduled, type Env as BaseEnv } from '../scheduled/index.ts';

type Env = BaseEnv & { ASSETS?: Fetcher };

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    if (!path.startsWith('/api/')) {
      return env.ASSETS ? env.ASSETS.fetch(req) : new Response('not found', { status: 404 });
    }

    if (rateLimited(req)) return new Response('rate limited', { status: 429 });

    if (req.method === 'POST' && path === '/api/admin/refresh') {
      return adminRefresh(req, env, ctx);
    }
    // Journal is personal: every route is token-gated, and none of it is
    // ever edge-cached.
    if (path === '/api/journal') {
      if (!authorized(req, env)) return json({ error: 'unauthorized' }, 401);
      if (req.method === 'POST') return journalCreate(req, env);
      if (req.method === 'GET') return journalList(env);
      return new Response('method not allowed', { status: 405 });
    }
    if (req.method !== 'GET') return new Response('method not allowed', { status: 405 });

    const cacheKey = new Request(url.toString(), { method: 'GET' });
    const cache = caches.default;
    const hit = await cache.match(cacheKey);
    if (hit) return hit;

    let res: Response;
    if (path === '/api/wall') res = await apiWall(env);
    else if (path === '/api/barometer') res = await apiBarometer(env);
    else if (path === '/api/alerts') res = await apiAlerts(env);
    else if (path.startsWith('/api/series/')) res = await apiSeries(env, path.slice('/api/series/'.length));
    else res = json({ error: 'not found' }, 404);

    if (res.status === 200) ctx.waitUntil(cache.put(cacheKey, res.clone()));
    return res;
  },

  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runScheduled(env).then(
      (log) => console.log('scheduled run:\n' + log),
      (err) => console.error('scheduled run failed:', err),
    ));
  },
} satisfies ExportedHandler<Env>;

// ── endpoints ──────────────────────────────────────────────────────────

async function apiWall(env: Env): Promise<Response> {
  const [stateRes, signalRow, lastRun] = await Promise.all([
    env.DB.prepare('SELECT * FROM wall_state').all<Record<string, unknown>>(),
    env.DB.prepare('SELECT computed_at, detail FROM signal_state WHERE id = 1').first<{ computed_at: string; detail: string }>(),
    env.DB.prepare("SELECT value FROM meta WHERE key = 'last_run'").first<{ value: string }>(),
  ]);

  const stateById = new Map((stateRes.results ?? []).map((r) => [r.series_id as string, r]));
  const kpis = KPIS.filter((def) => !def.hidden).map((def) => {
    const s = stateById.get(def.id);
    return {
      id: def.id,
      label: def.label,
      cluster: def.cluster,
      unit: def.unit,
      unitPrefix: def.unitPrefix ?? false,
      decimals: def.decimals,
      showPct: def.showPct ?? true,
      stressSign: def.stressSign ?? 1,
      signRationale: def.signRationale ?? null,
      freq: def.freq ?? 'daily',
      deadline: def.deadline ?? null,
      latest: s ? (s.latest_value as number | null) : null,
      latestDate: s ? (s.latest_date as string | null) : null,
      changes: s ? JSON.parse(s.changes as string) : {},
      sparks: s ? JSON.parse(s.sparks as string) : {},
      dir: s ? JSON.parse(s.direction_state as string) : {},
      status: s ? (s.status as string) : 'error',
      statusDetail: s ? (s.status_detail as string | null) : 'no data yet — run the cron job or POST /api/admin/refresh',
      flag: s ? ((s.flag as string | null) ?? null) : null,
      lastSuccessAt: s ? (s.last_success_at as string | null) : null,
      computedAt: s ? (s.computed_at as string) : null,
    };
  });

  // barometer summary only — full detail + diagnostics live on /api/barometer
  let barometer = null;
  if (signalRow) {
    const detail = JSON.parse(signalRow.detail);
    const pick = (layer: string) => ({
      '2y': slim(detail.barometer?.[layer]?.['2y']),
      '5y': slim(detail.barometer?.[layer]?.['5y']),
    });
    // headline percentile travels with the summary so the bezel can show
    // "is this high?" without loading the full gauge payload
    barometer = {
      computedAt: signalRow.computed_at,
      pressure: pick('pressure'),
      altitude: pick('altitude'),
      divergence: detail.divergence ?? { '2y': false, '5y': false },
    };
  }

  return json({
    generatedAt: new Date().toISOString(),
    lastRun: lastRun?.value ?? null,
    clusters: CLUSTERS,
    kpis,
    barometer,
  }, 200, 60);
}

function slim(d: { score?: number | null; regime?: string | null; gauge?: Record<string, unknown> } | undefined) {
  return d ? {
    score: d.score ?? null,
    regime: d.regime ?? null,
    pct: (d.gauge?.percentileLive as number | null) ?? null,
    since: (d.gauge?.firstDate as string | null) ?? null,
    velocityZ: (d.gauge?.velocityZ as number | null) ?? null,
  } : null;
}

async function apiBarometer(env: Env): Promise<Response> {
  const [state, chart, changes] = await Promise.all([
    env.DB.prepare('SELECT computed_at, detail FROM signal_state WHERE id = 1').first<{ computed_at: string; detail: string }>(),
    env.DB.prepare("SELECT points FROM charts WHERE series_id = '__barometer' AND range = 'hist'").first<{ points: string }>(),
    env.DB.prepare('SELECT date, layer, window, from_regime, to_regime, score, drivers FROM barometer_changes ORDER BY date DESC LIMIT 200').all(),
  ]);
  if (!state) return json({ error: 'barometer not computed yet' }, 503);
  const detail = JSON.parse(state.detail);
  return json({
    computedAt: state.computed_at,
    zonePcts: ZONE_PCTS,
    barometer: detail.barometer,
    divergence: detail.divergence,
    analogues: detail.analogues ?? [],
    diagnostics: detail.diagnostics,
    history: chart ? JSON.parse(chart.points) : null,
    changes: (changes.results ?? []).map((c) => ({ ...c, drivers: JSON.parse(c.drivers as string) })),
  }, 200, 300);
}

async function apiSeries(env: Env, rawId: string): Promise<Response> {
  const id = decodeURIComponent(rawId);
  const def = kpiById.get(id);
  if (!def || def.hidden) return json({ error: 'unknown series' }, 404);
  const row = await env.DB.prepare("SELECT points FROM charts WHERE series_id = ? AND range = 'y5'")
    .bind(id).first<{ points: string }>();
  if (!row) return json({ error: 'no chart data yet' }, 503);
  return new Response(
    `{"id":${JSON.stringify(id)},"label":${JSON.stringify(def.label)},"unit":${JSON.stringify(def.unit)},"decimals":${def.decimals},"data":${row.points}}`,
    { status: 200, headers: baseHeaders(300) },
  );
}

async function apiAlerts(env: Env): Promise<Response> {
  const rows = await env.DB.prepare(
    'SELECT date, kind, key, message, delivered, created_at FROM alerts ORDER BY created_at DESC LIMIT 100',
  ).all();
  return json({
    alerts: (rows.results ?? []).map((a) => ({ ...a, delivered: safeParse(a.delivered as string | null) })),
  }, 200, 60);
}

// ── decision journal (token-gated, never cached) ───────────────────────

function authorized(req: Request, env: Env): boolean {
  const token = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '')
    ?? new URL(req.url).searchParams.get('token');
  return Boolean(env.ADMIN_TOKEN) && token === env.ADMIN_TOKEN;
}

async function journalCreate(req: Request, env: Env): Promise<Response> {
  let body: Record<string, unknown>;
  try { body = await req.json() as Record<string, unknown>; }
  catch { return noStore({ error: 'invalid JSON' }, 400); }

  const entry = String(body.entry ?? '').trim();
  if (!entry) return noStore({ error: 'entry text required' }, 400);
  if (entry.length > 20000) return noStore({ error: 'entry too long' }, 400);

  const stance = ['bullish', 'bearish', 'neutral'].includes(String(body.stance)) ? String(body.stance) : null;
  const convictionRaw = Number(body.conviction);
  const conviction = Number.isFinite(convictionRaw) ? Math.max(1, Math.min(5, Math.round(convictionRaw))) : null;
  const action = body.action ? String(body.action).slice(0, 4000) : null;
  const instruments = Array.isArray(body.instruments)
    ? body.instruments.filter((x): x is string => typeof x === 'string' && kpiById.has(x)).slice(0, 10)
    : [];

  // Snapshot the full wall state at write time — reading finished rows,
  // not computing. Memory can't rewrite what was recorded here.
  const [stateRes, signalRow] = await Promise.all([
    env.DB.prepare('SELECT series_id, latest_value, latest_date, status FROM wall_state').all<Record<string, unknown>>(),
    env.DB.prepare('SELECT computed_at, detail FROM signal_state WHERE id = 1').first<{ computed_at: string; detail: string }>(),
  ]);
  const detail = signalRow ? JSON.parse(signalRow.detail) : null;
  const gauge = (layer: string, w: string) => {
    const d = detail?.barometer?.[layer]?.[w];
    return d ? { score: d.score, regime: d.regime, percentile: d.gauge?.percentile ?? null } : null;
  };
  const snapshot = {
    takenAt: new Date().toISOString(),
    computedAt: signalRow?.computed_at ?? null,
    pressure: { '2y': gauge('pressure', '2y'), '5y': gauge('pressure', '5y') },
    altitude: { '2y': gauge('altitude', '2y'), '5y': gauge('altitude', '5y') },
    divergence: detail?.divergence ?? null,
    inputs: (stateRes.results ?? []).map((r) => ({
      id: r.series_id, value: r.latest_value, asOf: r.latest_date, status: r.status,
    })),
    subZ: extractSubZ(detail),
  };

  const now = new Date().toISOString();
  const res = await env.DB.prepare(
    `INSERT INTO journal_entries (created_at, entry, stance, action, conviction, instruments, snapshot, realized)
     VALUES (?,?,?,?,?,?,?,NULL)`,
  ).bind(now, entry, stance, action, conviction, JSON.stringify(instruments), JSON.stringify(snapshot)).run();

  return noStore({ ok: true, id: res.meta?.last_row_id ?? null, createdAt: now });
}

function extractSubZ(detail: any): Record<string, Record<string, number | null>> {
  const out: Record<string, Record<string, number | null>> = {};
  for (const layer of ['pressure', 'altitude']) {
    const subs = detail?.barometer?.[layer]?.['2y']?.subs ?? [];
    for (const s of subs) {
      out[s.id] = { z: s.z ?? null };
      for (const i of s.inputs ?? []) out[s.id][i.id] = i.z ?? null;
    }
  }
  return out;
}

async function journalList(env: Env): Promise<Response> {
  const rows = await env.DB.prepare(
    'SELECT id, created_at, entry, stance, action, conviction, instruments, snapshot, realized FROM journal_entries ORDER BY created_at DESC LIMIT 200',
  ).all<Record<string, unknown>>();
  const entries = (rows.results ?? []).map((r) => ({
    id: r.id,
    createdAt: r.created_at,
    entry: r.entry,
    stance: r.stance,
    action: r.action,
    conviction: r.conviction,
    instruments: safeParse(r.instruments as string | null) ?? [],
    snapshot: safeParse(r.snapshot as string | null),
    realized: safeParse(r.realized as string | null),
  }));

  // Calibration: stated conviction vs realised 3-month accuracy. The single
  // question no amount of extra KPIs can answer.
  const buckets: Record<number, { n: number; hits: number }> = {};
  for (const e of entries) {
    const hit = (e.realized as { hit3m?: boolean | null } | null)?.hit3m;
    const c = e.conviction as number | null;
    if (hit === null || hit === undefined || !c) continue;
    buckets[c] ??= { n: 0, hits: 0 };
    buckets[c].n++;
    if (hit) buckets[c].hits++;
  }
  const calibration = Object.entries(buckets).map(([conviction, b]) => ({
    conviction: Number(conviction), n: b.n, hitRate: Math.round((b.hits / b.n) * 1000) / 10,
  })).sort((a, b) => a.conviction - b.conviction);

  return noStore({ entries, calibration });
}

async function adminRefresh(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (!authorized(req, env)) return json({ error: 'unauthorized' }, 401);
  try {
    const log = await runScheduled(env);
    return json({ ok: true, log: log.split('\n') });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
}

function safeParse(s: string | null): unknown {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}

function noStore(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

// ── plumbing ───────────────────────────────────────────────────────────

function baseHeaders(sMaxAge: number): HeadersInit {
  return {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': `public, max-age=15, s-maxage=${sMaxAge}`,
    'access-control-allow-origin': '*',
  };
}

function json(body: unknown, status = 200, sMaxAge = 60): Response {
  return new Response(JSON.stringify(body), { status, headers: baseHeaders(sMaxAge) });
}

// Best-effort token bucket per isolate. Real protection is the edge cache +
// (optionally) a Cloudflare dashboard rate-limit rule; this stops a single
// hot client from hammering one isolate's origin path.
const buckets = new Map<string, { tokens: number; ts: number }>();
const RATE = 60;
const WINDOW_MS = 60_000;

function rateLimited(req: Request): boolean {
  const ip = req.headers.get('cf-connecting-ip') ?? 'local';
  const now = Date.now();
  let b = buckets.get(ip);
  if (!b) { b = { tokens: RATE, ts: now }; buckets.set(ip, b); }
  b.tokens = Math.min(RATE, b.tokens + ((now - b.ts) / WINDOW_MS) * RATE);
  b.ts = now;
  if (buckets.size > 5000) buckets.clear();
  if (b.tokens < 1) return true;
  b.tokens -= 1;
  return false;
}
