// The scheduled job: fetch → compute → write display-ready rows.
// ALL computation lives here. The request path only reads.
//
// Idempotency: every write is an upsert keyed on (series_id, date); the fetch
// window always re-covers the recent past, so a missed cron run (free-tier
// crons do NOT retry) self-heals on the next run. First run against an empty
// table automatically becomes a full deep backfill.

import { KPIS, BACKFILL_START, type KpiDef } from '../registry/kpis.ts';
import { SOURCES, type Point } from '../sources/index.ts';
import { computeDerived } from '../compute/derived.ts';
import { buildWallState, type WallStateRow } from '../compute/wallstate.ts';
import { computeBarometer } from '../compute/barometer.ts';
import { computeDisconfirmation } from '../compute/disconfirmation.ts';
import { computeBaseRates } from '../compute/baserates.ts';
import { computeImpulseSweep } from '../compute/impulse.ts';
import { runAlerts, reviewJournal } from './accountability.ts';
import { downsample, isoDaysAgo } from '../compute/stats.ts';

export interface Env {
  DB: D1Database;
  FRED_API_KEY?: string;
  ADMIN_TOKEN?: string;
  ALERT_WEBHOOK_URL?: string;
  RESEND_API_KEY?: string;
  ALERT_EMAIL_TO?: string;
  ALERT_EMAIL_FROM?: string;
}

/** Re-fetch window: always re-cover this many days before the newest stored
 *  observation, so revisions and gaps from missed runs are healed. */
const REFETCH_DAYS = 45;
const CHART_MAX_POINTS = 780;
const BARO_CHART_MAX = 1560; // backtest chart resolution (both layers)
/** Truncated histories are re-fetched in full at most this many per run.
 *  Kept small: a deep fetch is a much larger response than the routine
 *  45-day window, and a run that tries too many at once competes with the
 *  ordinary refresh for the same subrequest and CPU budget. Healing a few
 *  per hour is invisible; a run that dies healing all of them is not. */
const DEEP_BACKFILLS_PER_RUN = 4;
/** Trailing window of a derived series rewritten on a routine run. Must
 *  comfortably exceed REFETCH_DAYS, since a revision to an input inside
 *  that window is the only thing that can change an older derived value. */
const DERIVED_WRITE_DAYS = 120;
/** Longest the computed layer may go without a rebuild, however quiet the
 *  sources are. Bounds the staleness that skipping the heavy path can
 *  introduce, and guarantees input revisions are eventually picked up. */
const HEAVY_MAX_IDLE_HOURS = 8;

interface FetchOutcome {
  points: Point[];
  ok: boolean;
  error?: string;
}

export interface RunOpts {
  /** Allow CPU-expensive spreadsheet parses. True on the cron path (~30s
   *  CPU); false from a fetch handler, which would exceed its budget. */
  allowHeavy?: boolean;
  /** Run the load/derive/barometer path even when no series advanced. */
  force?: boolean;
}

export async function runScheduled(env: Env, nowMs: number = Date.now(), opts: RunOpts = {}): Promise<string> {
  const nowIso = new Date(nowMs).toISOString();
  const today = nowIso.slice(0, 10);
  const log: string[] = [];

  // Stage timings. The scheduled path has ~30s of CPU and no way to report
  // exceeding it: the isolate is killed mid-run, `last_run` is never
  // written, and the failure is silent. These marks are what turns that
  // into a diagnosable event — the last mark logged is where it died.
  const t0 = Date.now();
  let tPrev = t0;
  const marks: string[] = [];
  const mark = (stage: string) => {
    const now = Date.now();
    const line = `${stage} ${((now - tPrev) / 1000).toFixed(1)}s (elapsed ${((now - t0) / 1000).toFixed(1)}s)`;
    marks.push(line);
    log.push(`⏱ ${line}`);
    tPrev = now;
  };
  /** Persist the timings so far. Called mid-run as well as at the end: if
   *  the isolate is killed, the mid-run checkpoint is the only evidence
   *  left of how far it got and which stage was running. */
  const saveProgress = async (done: boolean) => {
    await env.DB.prepare(
      `INSERT INTO meta (key, value) VALUES ('last_run_log', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
    ).bind(JSON.stringify({ at: nowIso, done, marks, failures: log.filter((l) => l.includes('FAILED')) })).run();
  };

  const fetched = KPIS.filter((k) => k.source && k.seriesId);
  const derived = KPIS.filter((k) => k.derive);

  // ── 1. fetch + upsert each sourced series ────────────────────────────
  let deepBudget = DEEP_BACKFILLS_PER_RUN;
  // Did ANY series gain an observation this run? Everything after the
  // fetch — loading full histories, recomputing 34 derivations, the
  // barometer — is pure waste when nothing new arrived, and on the free
  // tier it is waste that costs the whole day's D1 read allowance.
  let advanced: string | null = null;
  const outcomes = new Map<string, FetchOutcome>();
  await Promise.all(fetched.map(async (kpi) => {
    try {
      const maxRow = await env.DB
        .prepare('SELECT MAX(date) AS d, COUNT(*) AS n FROM observations WHERE series_id = ?')
        .bind(kpi.id).first<{ d: string | null; n: number }>();
      const minRows = kpi.freq === 'quarterly' ? 10 : kpi.freq === 'weekly' ? 30
        : kpi.freq === 'monthly' ? 24 : 100;

      // A row count cannot detect a TRUNCATED history. A series backfilled
      // from a shorter window than BACKFILL_START passes every freshness
      // check forever — it has plenty of rows and a current last date — and
      // silently shortens every percentile, z-score and backtest built on
      // it. So the deep backfill is claimed once per series per
      // BACKFILL_START value: if the marker does not match, re-fetch the
      // whole history and reset it. Moving BACKFILL_START earlier
      // re-triggers it everywhere by construction.
      //
      // Budgeted per run: healing sixty full histories (seven of them
      // multi-megabyte workbooks) in one cron would exceed the CPU limit
      // and kill the run before it wrote anything. A first backfill against
      // an empty table is NOT budgeted — the two clauses above still force
      // it — so only the healing path is paced.
      const deepKey = `deep:${kpi.id}`;
      const deepRow = await env.DB.prepare('SELECT value FROM meta WHERE key = ?').bind(deepKey).first<{ value: string }>();
      const needDeep = deepRow?.value !== BACKFILL_START && deepBudget > 0;
      if (needDeep) deepBudget--;
      const needBackfill = !maxRow?.d || (maxRow.n ?? 0) < minRows || needDeep;

      // Large binary workbooks are parsed only where there is CPU budget
      // for them. Skipping leaves the stored history untouched, so the
      // tile keeps serving its last good values rather than erroring.
      if (kpi.heavyParse && !opts.allowHeavy) {
        outcomes.set(kpi.id, { points: [], ok: true });
        log.push(`${kpi.id}: skipped (heavy parse, scheduled path only)`);
        return;
      }

      // Good-citizen throttle: slow-moving series on someone else's
      // personal academic server are fetched at most every N days. The
      // cron runs hourly; without this we would poll a professor's site
      // 720 times a month for data that changes once.
      if (!needBackfill && kpi.fetchIntervalDays) {
        const key = `fetched:${kpi.id}`;
        const last = await env.DB.prepare('SELECT value FROM meta WHERE key = ?').bind(key).first<{ value: string }>();
        if (last?.value && last.value > isoDaysAgo(today, kpi.fetchIntervalDays)) {
          outcomes.set(kpi.id, { points: [], ok: true });
          log.push(`${kpi.id}: skipped (fetched ${last.value}, interval ${kpi.fetchIntervalDays}d)`);
          return;
        }
      }
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
      if (kpi.fetchScale) pts = pts.map((p) => ({ date: p.date, value: p.value * kpi.fetchScale! }));
      if (pts.length && (!maxRow?.d || pts[pts.length - 1].date > maxRow.d)) {
        advanced ??= `${kpi.id} → ${pts[pts.length - 1].date}`;
      }
      await upsertObservations(env.DB, kpi.id, pts);
      if (kpi.fetchIntervalDays) {
        await env.DB.prepare(
          "INSERT INTO meta (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        ).bind(`fetched:${kpi.id}`, today).run();
      }
      if (needDeep) {
        await env.DB.prepare(
          "INSERT INTO meta (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        ).bind(deepKey, BACKFILL_START).run();
      }
      outcomes.set(kpi.id, { points: [], ok: true });
      log.push(`${kpi.id}: fetched ${pts.length} obs from ${from} via ${via}${needDeep ? ' [deep backfill]' : ''}`);
    } catch (e) {
      outcomes.set(kpi.id, { points: [], ok: false, error: String(e instanceof Error ? e.message : e) });
      log.push(`${kpi.id}: FETCH FAILED — ${e}`);
    }
  }));

  mark('fetch');

  // ── 1b. is the rest of this run worth doing? ─────────────────────────
  // Loading every history, recomputing all 34 derivations and rebuilding
  // the barometer costs ~143k D1 row reads. The cron fires hourly but the
  // sources publish daily, so on ~22 runs out of 24 that work reproduces
  // byte-identical output — and 24 x 143k is 3.4M reads against a 5M free
  // daily cap, which is what took the wall down. So the heavy path runs
  // only when a series actually gained an observation.
  //
  // A floor guarantees it still runs: revisions change a value without
  // advancing its date, and the barometer's own reading rolls forward with
  // the calendar even when no input moves. HEAVY_MAX_IDLE_HOURS bounds how
  // stale the computed layer can get regardless of what the sources do.
  const lastHeavyRow = await env.DB.prepare("SELECT value FROM meta WHERE key = 'last_heavy'")
    .first<{ value: string }>();
  const idleHours = lastHeavyRow?.value
    ? (nowMs - Date.parse(lastHeavyRow.value)) / 3600000
    : Infinity;
  const forced = opts.force || idleHours >= HEAVY_MAX_IDLE_HOURS;
  if (!advanced && !forced) {
    log.push(`no series advanced (last heavy run ${idleHours.toFixed(1)}h ago) — skipping load/derive/barometer`);
    mark('skipped heavy path');
    await env.DB.prepare(
      `INSERT INTO meta (key, value) VALUES ('last_run', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
    ).bind(nowIso).run();
    await saveProgress(true);
    return log.join('\n');
  }
  log.push(advanced ? `advanced: ${advanced} — running heavy path` : `forced heavy path (idle ${idleHours.toFixed(1)}h)`);

  // Stamped on ATTEMPT, not on success. A heavy run that dies part-way has
  // already spent most of its ~143k reads, so retrying it every hour is
  // what pins an exhausted quota exhausted — the failure keeps causing the
  // condition that causes the failure. Moving the stamp here makes the
  // idle floor govern retries too, bounding a broken heavy path to a few
  // attempts a day instead of twenty-four.
  await env.DB.prepare(
    `INSERT INTO meta (key, value) VALUES ('last_heavy', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
  ).bind(nowIso).run();

  // ── 2. load full history for every sourced series ────────────────────
  const seriesMap = new Map<string, Point[]>();
  for (const kpi of fetched) {
    const pts = await loadSeries(env.DB, kpi.id);
    seriesMap.set(kpi.id, pts);
    outcomes.get(kpi.id)!.points = pts;
  }

  mark('load');

  // ── 3. compute + upsert derived series (multi-pass: derived KPIs may
  //       consume other derived KPIs, e.g. breadth = roc(rsp/spy)) ──────
  // One small read of every derived series' stored shape (count|earliest),
  // so the loop below never has to COUNT over `observations` to decide how
  // much to write. `meta` is tiny; this is ~34 rows against the ~146k the
  // equivalent COUNTs would scan.
  const derivedShape = new Map<string, { n: number; min: string }>();
  {
    const rows = await env.DB.prepare("SELECT key, value FROM meta WHERE key LIKE 'derived:%'")
      .all<{ key: string; value: string }>();
    for (const r of rows.results ?? []) {
      const [n, min] = r.value.split('|');
      if (min) derivedShape.set(r.key.slice(8), { n: Number(n), min });
    }
  }

  const pending = new Set(derived.map((k) => k.id));
  for (let pass = 0; pass < 4 && pending.size; pass++) {
    for (const kpi of derived) {
      if (!pending.has(kpi.id)) continue;
      const inputIds = inputsOf(kpi);
      if (inputIds.some((id) => pending.has(id))) continue; // wait for deps
      pending.delete(kpi.id);
      const inputsPresent = inputIds.every((id) => (seriesMap.get(id)?.length ?? 0) > 0);
      const failedInput = inputIds.find((id) => outcomes.get(id) && !outcomes.get(id)!.ok);
      try {
        const pts = computeDerived(kpi.derive!, seriesMap);

        // A derivation recomputes its ENTIRE history from its inputs every
        // run, and writing all of it back every hour is what put this over
        // D1's free-tier daily caps: 34 derived series is ~146k rows per
        // run against a 100k/day write allowance, and reloading each one
        // afterwards cost as much again in reads. Only the tail can
        // actually have changed — inputs are re-fetched over a 45-day
        // window — so only the tail is written.
        //
        // The shape of what is stored is tracked in `meta`, NOT with a
        // COUNT/MIN over `observations`: that query scans the whole series
        // and would spend on reads exactly what this saves on writes. A
        // full rewrite is triggered only when the history starts earlier
        // than before, or grows by more than the trailing window could
        // account for — a new series, or an input healed by the deep
        // backfill. Routine daily growth of one observation stays inside
        // the window and does not trigger one. (Deleting a derived series'
        // rows out of band also needs its `derived:` meta key deleted, or
        // the next run will believe they are still there.)
        const fp = derivedShape.get(kpi.id);
        const window = isoDaysAgo(today, DERIVED_WRITE_DAYS);
        const inWindow = pts.filter((p) => p.date >= window);
        const grew = !fp || pts.length === 0 || pts[0].date !== fp.min
          || pts.length - fp.n > inWindow.length;
        const toWrite = grew ? pts : inWindow;
        if (toWrite.length) await upsertObservations(env.DB, kpi.id, toWrite);
        if (pts.length) {
          const shape = `${pts.length}|${pts[0].date}`;
          if (!fp || shape !== `${fp.n}|${fp.min}`) {
            await env.DB.prepare(
              "INSERT INTO meta (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            ).bind(`derived:${kpi.id}`, shape).run();
          }
        }

        // `pts` is computed from the inputs' full history, so when it is at
        // least as complete as what is stored it IS the stored series and
        // the reload is a pure waste. Reload only when the derivation came
        // back short — an input down today — where the stored history is
        // the more complete record.
        const complete = pts.length > 0 && (!fp || (pts.length >= fp.n && pts[0].date <= fp.min));
        const series = complete ? pts : await loadSeries(env.DB, kpi.id);
        seriesMap.set(kpi.id, series);
        outcomes.set(kpi.id, {
          points: series,
          ok: inputsPresent && !failedInput,
          error: failedInput ? `input '${failedInput}' failed to refresh` : (inputsPresent ? undefined : 'missing input series'),
        });
        log.push(`${kpi.id}: derived ${pts.length} obs, wrote ${toWrite.length}${grew ? ' [full — history grew]' : ''}${complete ? '' : ' [reloaded]'}`);
      } catch (e) {
        const stored = await loadSeries(env.DB, kpi.id);
        seriesMap.set(kpi.id, stored);
        outcomes.set(kpi.id, { points: stored, ok: false, error: String(e instanceof Error ? e.message : e) });
        log.push(`${kpi.id}: DERIVE FAILED — ${e}`);
      }
    }
  }
  for (const id of pending) {
    outcomes.set(id, { points: [], ok: false, error: 'unresolved derivation dependency cycle' });
    log.push(`${id}: DERIVE SKIPPED — dependency cycle`);
  }

  mark('derive');

  // ── 4. wall_state + expanded-chart data per visible KPI ──────────────
  const prevSuccess = new Map<string, string | null>();
  const prevFlags = new Map<string, string | null>();
  const currFlags = new Map<string, string | null>();
  const prevRows = await env.DB.prepare('SELECT series_id, last_success_at, flag FROM wall_state').all<{ series_id: string; last_success_at: string | null; flag: string | null }>();
  for (const r of prevRows.results ?? []) {
    prevSuccess.set(r.series_id, r.last_success_at);
    prevFlags.set(r.series_id, r.flag);
  }

  const stateStmts: D1PreparedStatement[] = [];
  const upsertState = env.DB.prepare(
    `INSERT INTO wall_state (series_id, computed_at, latest_value, latest_date, changes, sparks, direction_state, status, status_detail, last_success_at, flag)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(series_id) DO UPDATE SET
       computed_at=excluded.computed_at, latest_value=excluded.latest_value, latest_date=excluded.latest_date,
       changes=excluded.changes, sparks=excluded.sparks, direction_state=excluded.direction_state,
       status=excluded.status, status_detail=excluded.status_detail, last_success_at=excluded.last_success_at,
       flag=excluded.flag`,
  );
  const chartStmt = env.DB.prepare(
    `INSERT INTO charts (series_id, range, points) VALUES (?,?,?)
     ON CONFLICT(series_id, range) DO UPDATE SET points=excluded.points`,
  );

  for (const kpi of KPIS) {
    if (kpi.hidden) continue;
    const oc = outcomes.get(kpi.id) ?? { points: [], ok: false, error: 'not processed' };
    const row: WallStateRow = buildWallState(kpi, oc.points, {
      nowIso,
      fetchOk: oc.ok,
      fetchError: oc.error,
      prevLastSuccessAt: prevSuccess.get(kpi.id) ?? null,
    });
    currFlags.set(kpi.id, row.flag);
    stateStmts.push(upsertState.bind(
      row.series_id, row.computed_at, row.latest_value, row.latest_date,
      JSON.stringify(row.changes), JSON.stringify(row.sparks), JSON.stringify(row.direction_state),
      row.status, row.status_detail, row.last_success_at, row.flag,
    ));

    const from5y = isoDaysAgo(today, 1826);
    const pts5y = downsample(oc.points.filter((p) => p.date >= from5y), CHART_MAX_POINTS);
    stateStmts.push(chartStmt.bind(kpi.id, 'y5', JSON.stringify([
      pts5y.map((p) => Math.floor(Date.parse(p.date + 'T00:00:00Z') / 1000)),
      pts5y.map((p) => p.value),
    ])));
  }
  await batched(env.DB, stateStmts);
  mark('wall_state');
  await saveProgress(false);

  // ── 5. THE BAROMETER: two layers + backtest + diagnostics ────────────
  try {
    const result = computeBarometer(seriesMap);
    mark('barometer');
    const stmts: D1PreparedStatement[] = [];

    // Disconfirmation gets the same treatment as the stress readings:
    // computed every run, stored, logged, charted.
    let disc = null;
    try {
      disc = computeDisconfirmation(seriesMap, today);
      log.push(`disconfirmation: ${disc.passing}/${disc.total} tests passing`);
      mark('disconfirmation');
    } catch (e) {
      log.push(`disconfirmation: FAILED — ${e}`);
    }

    // Parameter sweep for the real-yield impulse. Runs every cron so the
    // verdict on the page is always computed from current data, never a
    // remembered conclusion.
    let impulseSweep = null;
    try {
      impulseSweep = computeImpulseSweep(seriesMap);
      if (impulseSweep) {
        const v = impulseSweep.verdict;
        log.push(`impulse sweep: published med3m=${v.publishedMed3m}% · ${v.negativeCells}/${v.totalCells} cells negative · inPressure=${v.inPressure}`);
      }
      mark('impulse sweep');
    } catch (e) {
      log.push(`impulse sweep: FAILED — ${e}`);
    }

    let baseRates = null;
    try {
      baseRates = computeBaseRates(seriesMap);
      log.push(`baserates: ERP ${baseRates.currentErp}% at ${baseRates.currentPct}th pct, ${baseRates.outcomes.length} comparable years`);
      mark('baserates');
    } catch (e) {
      log.push(`baserates: FAILED — ${e}`);
    }

    stmts.push(env.DB.prepare(
      `INSERT INTO signal_state (id, computed_at, detail) VALUES (1,?,?)
       ON CONFLICT(id) DO UPDATE SET computed_at=excluded.computed_at, detail=excluded.detail`,
    ).bind(nowIso, JSON.stringify({
      barometer: result.detail,
      divergence: result.divergenceNow,
      analogues: result.analogues,
      disconfirmation: disc,
      baseRates,
      impulseSweep,
      diagnostics: result.diagnostics,
    })));

    // precomputed backtest chart (both layers, downsampled) — the request
    // path serves this row verbatim
    // Backtest chart carries POINT-IN-TIME percentiles only. Plotting the
    // live percentile here would rank 2009 against 2020 and flatter the
    // gauge with hindsight it never had.
    const hist = result.history.filter((h) => h.p_2y !== null || h.a_2y !== null || h.p_5y !== null || h.a_5y !== null);
    const ds = downsampleRows(hist, BARO_CHART_MAX);
    stmts.push(chartStmt.bind('__barometer', 'hist', JSON.stringify({
      t: ds.map((h) => Math.floor(Date.parse(h.date + 'T00:00:00Z') / 1000)),
      p_2y: ds.map((h) => h.p_2y), p_5y: ds.map((h) => h.p_5y),
      a_2y: ds.map((h) => h.a_2y), a_5y: ds.map((h) => h.a_5y),
      pp_2y: ds.map((h) => h.pp_2y), pp_5y: ds.map((h) => h.pp_5y),
      ap_2y: ds.map((h) => h.ap_2y), ap_5y: ds.map((h) => h.ap_5y),
      div_2y: ds.map((h) => h.div_2y), div_5y: ds.map((h) => h.div_5y),
    })));

    // durable daily history — full write until scored rows exist, then a
    // rolling 90-day window; count-based self-heal (see Phase 1 fix).
    // Row count alone is NOT enough: adding a column leaves every existing
    // row present but unpopulated, and a 90-day window never reaches back
    // to fill it. Compare stored PIT coverage against this run's too, so a
    // schema addition heals itself on the next cron rather than leaving
    // years of history silently stale.
    const stored = await env.DB.prepare(
      'SELECT COUNT(*) AS n, MAX(date) AS d FROM barometer_history WHERE p_2y IS NOT NULL OR a_2y IS NOT NULL OR p_5y IS NOT NULL OR a_5y IS NOT NULL',
    ).first<{ n: number; d: string | null }>();
    const storedPit = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM barometer_history WHERE pp_2y IS NOT NULL OR ap_2y IS NOT NULL',
    ).first<{ n: number }>();
    const computedPit = result.history.filter((h) => h.pp_2y !== null || h.ap_2y !== null).length;
    const needFull = !stored?.d
      || (stored.n ?? 0) + 120 < hist.length
      || (storedPit?.n ?? 0) + 120 < computedPit;
    const histFrom = needFull ? '0000-00-00' : isoDaysAgo(stored!.d!, 90);
    const histStmt = env.DB.prepare(
      `INSERT INTO barometer_history (date, p_2y, p_5y, a_2y, a_5y, pp_2y, pp_5y, ap_2y, ap_5y, pr_2y, pr_5y, ar_2y, ar_5y, div_2y, div_5y)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(date) DO UPDATE SET p_2y=excluded.p_2y, p_5y=excluded.p_5y, a_2y=excluded.a_2y, a_5y=excluded.a_5y,
         pp_2y=excluded.pp_2y, pp_5y=excluded.pp_5y, ap_2y=excluded.ap_2y, ap_5y=excluded.ap_5y,
         pr_2y=excluded.pr_2y, pr_5y=excluded.pr_5y, ar_2y=excluded.ar_2y, ar_5y=excluded.ar_5y,
         div_2y=excluded.div_2y, div_5y=excluded.div_5y`,
    );
    for (const h of result.history) {
      if (h.date >= histFrom) {
        stmts.push(histStmt.bind(h.date, h.p_2y, h.p_5y, h.a_2y, h.a_5y,
          h.pp_2y, h.pp_5y, h.ap_2y, h.ap_5y,
          h.pr_2y, h.pr_5y, h.ar_2y, h.ar_5y, h.div_2y, h.div_5y));
      }
    }

    // distribution + reference marks: slowly-changing, kept out of the
    // per-date table
    const gaugeStmt = env.DB.prepare(
      `INSERT INTO gauge_meta (layer, window, computed_at, detail) VALUES (?,?,?,?)
       ON CONFLICT(layer, window) DO UPDATE SET computed_at=excluded.computed_at, detail=excluded.detail`,
    );
    for (const layer of ['pressure', 'altitude'] as const) {
      for (const w of ['2y', '5y'] as const) {
        stmts.push(gaugeStmt.bind(layer, w, nowIso, JSON.stringify(result.detail[layer][w].gauge)));
      }
    }

    const changeStmt = env.DB.prepare(
      `INSERT INTO barometer_changes (date, layer, window, from_regime, to_regime, score, drivers) VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(date, layer, window) DO UPDATE SET from_regime=excluded.from_regime, to_regime=excluded.to_regime,
         score=excluded.score, drivers=excluded.drivers`,
    );
    for (const c of result.changes) {
      stmts.push(changeStmt.bind(c.date, c.layer, c.window, c.from_regime, c.to_regime, c.score, JSON.stringify(c.drivers)));
    }
    await batched(env.DB, stmts);
    mark('signal write');
    const p = result.detail.pressure['2y'];
    const a = result.detail.altitude['2y'];
    log.push(`barometer: pressure=${p.score} ${p.regime} · altitude=${a.score} ${a.regime} · changes=${result.changes.length} · corrFlags=${result.diagnostics.corr.flagged.length} · analogues=${result.analogues.length}`);

    // ── 6. accountability: alerts + journal review ───────────────────
    try {
      log.push(...await runAlerts(env, result, seriesMap, prevFlags, currFlags, nowIso));
    } catch (e) {
      log.push(`alerts: FAILED — ${e}`);
    }
    try {
      log.push(...await reviewJournal(env, seriesMap));
    } catch (e) {
      log.push(`journal review: FAILED — ${e}`);
    }
  } catch (e) {
    log.push(`barometer: FAILED — ${e}`);
  }
  mark('accountability');

  await env.DB.prepare(
    `INSERT INTO meta (key, value) VALUES ('last_run', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
  ).bind(nowIso).run();
  await saveProgress(true);

  return log.join('\n');
}

function inputsOf(kpi: KpiDef): string[] {
  const d = kpi.derive!;
  switch (d.type) {
    case 'ratio': return [d.num, d.den];
    case 'rolling_corr': return [d.a, d.b];
    case 'combo': return d.terms.map((t) => t.id);
    case 'roc': case 'ma_extension': case 'target_distance': case 'completion': return [d.input];
    case 'response_gap': return [d.credit, d.balance];
    case 'capitulation': return d.inputs;
    case 'erp_attrib': return [d.index, d.cashflow, d.riskfree];
    case 'trough_impulse': return [d.input];
  }
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

function downsampleRows<T>(rows: T[], max: number): T[] {
  if (rows.length <= max) return rows;
  const out: T[] = [];
  const step = (rows.length - 1) / (max - 1);
  for (let i = 0; i < max; i++) out.push(rows[Math.round(i * step)]);
  out[out.length - 1] = rows[rows.length - 1];
  return out;
}
