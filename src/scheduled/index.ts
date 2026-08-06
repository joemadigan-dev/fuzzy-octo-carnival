// The scheduled job: fetch → compute → write display-ready rows.
// ALL computation lives here. The request path only reads.
//
// Idempotency: every write is an upsert keyed on (series_id, date); the fetch
// window always re-covers the recent past, so a missed cron run (free-tier
// crons do NOT retry) self-heals on the next run. First run against an empty
// table automatically becomes a full 5y+ backfill.

import { KPIS, BACKFILL_START, type KpiDef } from '../registry/kpis.ts';
import { SOURCES, type Point } from '../sources/index.ts';
import { computeDerived } from '../compute/derived.ts';
import { buildWallState, type WallStateRow } from '../compute/wallstate.ts';
import { computeComposite } from '../compute/composite.ts';
import { downsample, isoDaysAgo } from '../compute/stats.ts';

export interface Env {
  DB: D1Database;
  FRED_API_KEY?: string;
  ADMIN_TOKEN?: string;
}

/** Re-fetch window: always re-cover this many days before the newest stored
 *  observation, so revisions and gaps from missed runs are healed. */
const REFETCH_DAYS = 45;
const CHART_MAX_POINTS = 780; // ~3/week over 5y — plenty for a full-width chart

interface FetchOutcome {
  points: Point[];        // full history from D1 after upsert
  ok: boolean;
  error?: string;
}

export async function runScheduled(env: Env, nowMs: number = Date.now()): Promise<string> {
  const nowIso = new Date(nowMs).toISOString();
  const today = nowIso.slice(0, 10);
  const log: string[] = [];

  const fetched = KPIS.filter((k) => k.source && k.seriesId);
  const derived = KPIS.filter((k) => k.derive);

  // ── 1. fetch + upsert each sourced series ────────────────────────────
  const outcomes = new Map<string, FetchOutcome>();
  await Promise.all(fetched.map(async (kpi) => {
    try {
      const maxRow = await env.DB
        .prepare('SELECT MAX(date) AS d, COUNT(*) AS n FROM observations WHERE series_id = ?')
        .bind(kpi.id).first<{ d: string | null; n: number }>();
      const needBackfill = !maxRow?.d || (maxRow.n ?? 0) < 100;
      const from = needBackfill ? BACKFILL_START : isoDaysAgo(maxRow!.d!, REFETCH_DAYS);
      const source = SOURCES[kpi.source!];
      let pts: Point[];
      let via: string = kpi.source!;
      try {
        pts = await source.fetchSeries(kpi.seriesId!, { from, to: today }, env);
      } catch (primaryErr) {
        if (!kpi.fallback) throw primaryErr;
        pts = await SOURCES[kpi.fallback.source].fetchSeries(kpi.fallback.seriesId, { from, to: today }, env);
        via = `${kpi.fallback.source} (fallback; ${kpi.source} failed: ${primaryErr instanceof Error ? primaryErr.message : primaryErr})`;
      }
      await upsertObservations(env.DB, kpi.id, pts);
      outcomes.set(kpi.id, { points: [], ok: true });
      log.push(`${kpi.id}: fetched ${pts.length} obs from ${from} via ${via}`);
    } catch (e) {
      outcomes.set(kpi.id, { points: [], ok: false, error: String(e instanceof Error ? e.message : e) });
      log.push(`${kpi.id}: FETCH FAILED — ${e}`);
    }
  }));

  // ── 2. load full history for every sourced series ────────────────────
  const seriesMap = new Map<string, Point[]>();
  for (const kpi of fetched) {
    const pts = await loadSeries(env.DB, kpi.id);
    seriesMap.set(kpi.id, pts);
    outcomes.get(kpi.id)!.points = pts;
  }

  // ── 3. compute + upsert derived series ───────────────────────────────
  for (const kpi of derived) {
    const inputIds = inputsOf(kpi);
    const inputsOk = inputIds.every((id) => (seriesMap.get(id)?.length ?? 0) > 0);
    const staleInput = inputIds.find((id) => !outcomes.get(id)?.ok);
    try {
      const pts = computeDerived(kpi.derive!, seriesMap);
      if (pts.length) await upsertObservations(env.DB, kpi.id, pts);
      // reload from D1 so history persists even when an input is down today
      const stored = await loadSeries(env.DB, kpi.id);
      seriesMap.set(kpi.id, stored);
      outcomes.set(kpi.id, {
        points: stored,
        ok: inputsOk && !staleInput,
        error: staleInput ? `input '${staleInput}' failed to refresh` : (inputsOk ? undefined : 'missing input series'),
      });
      log.push(`${kpi.id}: derived ${pts.length} obs`);
    } catch (e) {
      const stored = await loadSeries(env.DB, kpi.id);
      seriesMap.set(kpi.id, stored);
      outcomes.set(kpi.id, { points: stored, ok: false, error: String(e instanceof Error ? e.message : e) });
      log.push(`${kpi.id}: DERIVE FAILED — ${e}`);
    }
  }

  // ── 4. wall_state per KPI ────────────────────────────────────────────
  const prevSuccess = new Map<string, string | null>();
  const prevRows = await env.DB.prepare('SELECT series_id, last_success_at FROM wall_state').all<{ series_id: string; last_success_at: string | null }>();
  for (const r of prevRows.results ?? []) prevSuccess.set(r.series_id, r.last_success_at);

  const stateStmts: D1PreparedStatement[] = [];
  const upsertState = env.DB.prepare(
    `INSERT INTO wall_state (series_id, computed_at, latest_value, latest_date, changes, sparks, direction_state, status, status_detail, last_success_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(series_id) DO UPDATE SET
       computed_at=excluded.computed_at, latest_value=excluded.latest_value, latest_date=excluded.latest_date,
       changes=excluded.changes, sparks=excluded.sparks, direction_state=excluded.direction_state,
       status=excluded.status, status_detail=excluded.status_detail, last_success_at=excluded.last_success_at`,
  );
  const chartStmt = env.DB.prepare(
    `INSERT INTO charts (series_id, range, points) VALUES (?,?,?)
     ON CONFLICT(series_id, range) DO UPDATE SET points=excluded.points`,
  );

  for (const kpi of KPIS) {
    const oc = outcomes.get(kpi.id) ?? { points: [], ok: false, error: 'not processed' };
    const row: WallStateRow = buildWallState(kpi, oc.points, {
      nowIso,
      fetchOk: oc.ok,
      fetchError: oc.error,
      prevLastSuccessAt: prevSuccess.get(kpi.id) ?? null,
    });
    stateStmts.push(upsertState.bind(
      row.series_id, row.computed_at, row.latest_value, row.latest_date,
      JSON.stringify(row.changes), JSON.stringify(row.sparks), JSON.stringify(row.direction_state),
      row.status, row.status_detail, row.last_success_at,
    ));

    // expanded-chart data: 5y daily, downsampled, uPlot column layout
    const from5y = isoDaysAgo(today, 1826);
    const pts5y = downsample(oc.points.filter((p) => p.date >= from5y), CHART_MAX_POINTS);
    stateStmts.push(chartStmt.bind(kpi.id, 'y5', JSON.stringify([
      pts5y.map((p) => Math.floor(Date.parse(p.date + 'T00:00:00Z') / 1000)),
      pts5y.map((p) => p.value),
    ])));
  }
  await batched(env.DB, stateStmts);

  // ── 5. composite signal + backtest + change log ──────────────────────
  try {
    const result = computeComposite(seriesMap);
    const stmts: D1PreparedStatement[] = [];
    stmts.push(env.DB.prepare(
      `INSERT INTO signal_state (id, computed_at, detail) VALUES (1,?,?)
       ON CONFLICT(id) DO UPDATE SET computed_at=excluded.computed_at, detail=excluded.detail`,
    ).bind(nowIso, JSON.stringify(result.detail)));

    const histStmt = env.DB.prepare(
      `INSERT INTO signal_history (date, score_2y, score_5y, regime_2y, regime_5y) VALUES (?,?,?,?,?)
       ON CONFLICT(date) DO UPDATE SET score_2y=excluded.score_2y, score_5y=excluded.score_5y,
         regime_2y=excluded.regime_2y, regime_5y=excluded.regime_5y`,
    );
    // full history until scores exist; afterwards only re-write the recent
    // window (old scores never change absent revisions inside the refetch
    // window). Keyed off the last date with a real score, not MAX(date) —
    // an early run can legitimately write all-null rows that must be filled.
    const stored = await env.DB.prepare(
      'SELECT COUNT(*) AS n, MAX(date) AS d FROM signal_history WHERE score_2y IS NOT NULL OR score_5y IS NOT NULL',
    ).first<{ n: number; d: string | null }>();
    const computedScored = result.history.filter((h) => h.score_2y !== null || h.score_5y !== null).length;
    const needFull = !stored?.d || (stored.n ?? 0) + 120 < computedScored;
    const histFrom = needFull ? '0000-00-00' : isoDaysAgo(stored!.d!, 90);
    for (const h of result.history) {
      if (h.date >= histFrom) stmts.push(histStmt.bind(h.date, h.score_2y, h.score_5y, h.regime_2y, h.regime_5y));
    }

    const changeStmt = env.DB.prepare(
      `INSERT INTO signal_changes (date, window, from_regime, to_regime, score, drivers) VALUES (?,?,?,?,?,?)
       ON CONFLICT(date, window) DO UPDATE SET from_regime=excluded.from_regime, to_regime=excluded.to_regime,
         score=excluded.score, drivers=excluded.drivers`,
    );
    for (const c of result.changes) {
      stmts.push(changeStmt.bind(c.date, c.window, c.from_regime, c.to_regime, c.score, JSON.stringify(c.drivers)));
    }
    await batched(env.DB, stmts);
    log.push(`signal: score2y=${result.detail['2y'].score} regime2y=${result.detail['2y'].regime} changes=${result.changes.length}`);
  } catch (e) {
    log.push(`signal: FAILED — ${e}`);
  }

  await env.DB.prepare(
    `INSERT INTO meta (key, value) VALUES ('last_run', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
  ).bind(nowIso).run();

  return log.join('\n');
}

function inputsOf(kpi: KpiDef): string[] {
  const d = kpi.derive!;
  return d.type === 'ratio' ? [d.num, d.den] : [d.a, d.b];
}

async function loadSeries(db: D1Database, id: string): Promise<Point[]> {
  const res = await db
    .prepare('SELECT date, value FROM observations WHERE series_id = ? ORDER BY date ASC')
    .bind(id).all<{ date: string; value: number }>();
  return (res.results ?? []).map((r) => ({ date: r.date, value: r.value }));
}

/** Upsert observations in chunks (D1 caps bound params per statement). */
async function upsertObservations(db: D1Database, seriesId: string, pts: Point[]): Promise<void> {
  const ROWS_PER_STMT = 32; // 3 params/row → 96, under D1's 100-param cap
  const stmts: D1PreparedStatement[] = [];
  for (let i = 0; i < pts.length; i += ROWS_PER_STMT) {
    const chunk = pts.slice(i, i + ROWS_PER_STMT);
    const values = chunk.map(() => '(?,?,?)').join(',');
    const sql = `INSERT INTO observations (series_id, date, value) VALUES ${values}
                 ON CONFLICT(series_id, date) DO UPDATE SET value=excluded.value`;
    const params: (string | number)[] = [];
    for (const p of chunk) params.push(seriesId, p.date, p.value);
    stmts.push(db.prepare(sql).bind(...params));
  }
  await batched(db, stmts);
}

/** db.batch in slices to stay under D1 per-batch statement limits. */
async function batched(db: D1Database, stmts: D1PreparedStatement[]): Promise<void> {
  const SLICE = 50;
  for (let i = 0; i < stmts.length; i += SLICE) {
    await db.batch(stmts.slice(i, i + SLICE));
  }
}
