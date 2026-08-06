// Request handler. HARD RULE: no computation here — every endpoint is an
// indexed D1 read of rows the cron job already finished. Free-tier Workers
// get 10ms CPU per request; this path uses a fraction of that.

import { KPIS, CLUSTERS, kpiById } from '../registry/kpis.ts';
import { runScheduled, type Env as BaseEnv } from '../scheduled/index.ts';

type Env = BaseEnv & { ASSETS?: Fetcher };

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    if (!path.startsWith('/api/')) {
      // static assets (run_worker_first only routes /api/* here normally)
      return env.ASSETS ? env.ASSETS.fetch(req) : new Response('not found', { status: 404 });
    }

    // best-effort per-isolate rate limit (the edge cache absorbs the rest)
    if (rateLimited(req)) return new Response('rate limited', { status: 429 });

    if (req.method === 'POST' && path === '/api/admin/refresh') {
      return adminRefresh(req, env, ctx);
    }
    if (req.method !== 'GET') return new Response('method not allowed', { status: 405 });

    // edge cache: one origin hit per TTL regardless of viewer count
    const cacheKey = new Request(url.toString(), { method: 'GET' });
    const cache = caches.default;
    const hit = await cache.match(cacheKey);
    if (hit) return hit;

    let res: Response;
    if (path === '/api/wall') res = await apiWall(env);
    else if (path === '/api/signal') res = await apiSignal(env);
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
  const kpis = KPIS.map((def) => {
    const s = stateById.get(def.id);
    return {
      id: def.id,
      label: def.label,
      cluster: def.cluster,
      unit: def.unit,
      unitPrefix: def.unitPrefix ?? false,
      decimals: def.decimals,
      showPct: def.showPct ?? true,
      direction: def.direction,
      latest: s ? (s.latest_value as number | null) : null,
      latestDate: s ? (s.latest_date as string | null) : null,
      changes: s ? JSON.parse(s.changes as string) : {},
      sparks: s ? JSON.parse(s.sparks as string) : {},
      dir: s ? JSON.parse(s.direction_state as string) : {},
      status: s ? (s.status as string) : 'error',
      statusDetail: s ? (s.status_detail as string | null) : 'no data yet — run the cron job or POST /api/admin/refresh',
      lastSuccessAt: s ? (s.last_success_at as string | null) : null,
      computedAt: s ? (s.computed_at as string) : null,
    };
  });

  return json({
    generatedAt: new Date().toISOString(),
    lastRun: lastRun?.value ?? null,
    clusters: CLUSTERS,
    kpis,
    signal: signalRow ? { computedAt: signalRow.computed_at, ...JSON.parse(signalRow.detail) } : null,
  }, 200, 60);
}

async function apiSignal(env: Env): Promise<Response> {
  const [state, history, changes] = await Promise.all([
    env.DB.prepare('SELECT computed_at, detail FROM signal_state WHERE id = 1').first<{ computed_at: string; detail: string }>(),
    env.DB.prepare('SELECT date, score_2y, score_5y, regime_2y, regime_5y FROM signal_history ORDER BY date ASC').all(),
    env.DB.prepare('SELECT date, window, from_regime, to_regime, score, drivers FROM signal_changes ORDER BY date DESC LIMIT 200').all(),
  ]);
  if (!state) return json({ error: 'signal not computed yet' }, 503);
  return json({
    computedAt: state.computed_at,
    detail: JSON.parse(state.detail),
    history: history.results ?? [],
    changes: (changes.results ?? []).map((c) => ({ ...c, drivers: JSON.parse(c.drivers as string) })),
  }, 200, 300);
}

async function apiSeries(env: Env, rawId: string): Promise<Response> {
  const id = decodeURIComponent(rawId);
  const def = kpiById.get(id);
  if (!def) return json({ error: 'unknown series' }, 404);
  const row = await env.DB.prepare("SELECT points FROM charts WHERE series_id = ? AND range = 'y5'")
    .bind(id).first<{ points: string }>();
  if (!row) return json({ error: 'no chart data yet' }, 503);
  return new Response(
    `{"id":${JSON.stringify(id)},"label":${JSON.stringify(def.label)},"unit":${JSON.stringify(def.unit)},"decimals":${def.decimals},"data":${row.points}}`,
    { status: 200, headers: baseHeaders(300) },
  );
}

async function adminRefresh(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const token = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? new URL(req.url).searchParams.get('token');
  if (!env.ADMIN_TOKEN || token !== env.ADMIN_TOKEN) return json({ error: 'unauthorized' }, 401);
  // run inline so the caller sees the log (backfill is fetch/IO-bound)
  try {
    const log = await runScheduled(env);
    return json({ ok: true, log: log.split('\n') });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
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
const RATE = 60;        // requests
const WINDOW_MS = 60_000;

function rateLimited(req: Request): boolean {
  const ip = req.headers.get('cf-connecting-ip') ?? 'local';
  const now = Date.now();
  let b = buckets.get(ip);
  if (!b) { b = { tokens: RATE, ts: now }; buckets.set(ip, b); }
  b.tokens = Math.min(RATE, b.tokens + ((now - b.ts) / WINDOW_MS) * RATE);
  b.ts = now;
  if (buckets.size > 5000) buckets.clear(); // crude memory cap
  if (b.tokens < 1) return true;
  b.tokens -= 1;
  return false;
}
