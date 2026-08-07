// Builds the display-ready wall_state row for one KPI from its full history.
// Runs in the cron job only.

import type { Point } from '../sources/types.ts';
import { defaultStaleDays, type KpiDef } from '../registry/kpis.ts';
import { downsample, isoDaysAgo, valueOnOrBefore } from './stats.ts';

export const TIMEFRAMES = ['d', 'w', 'm', 'y', 'y5'] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];

const HORIZON_DAYS: Record<Exclude<Timeframe, 'd'>, number> = {
  w: 7, m: 30, y: 365, y5: 1826,
};

export interface Change { abs: number; pct: number | null }
export interface Spark { v: number[]; t0: string; t1: string }
export type DirState = 'up' | 'down' | 'flat';

export interface WallStateRow {
  series_id: string;
  computed_at: string;
  latest_value: number | null;
  latest_date: string | null;
  changes: Partial<Record<Timeframe, Change | null>>;
  sparks: Partial<Record<Timeframe, Spark | null>>;
  direction_state: Partial<Record<Timeframe, DirState>>;
  status: 'ok' | 'stale' | 'error';
  status_detail: string | null;
  last_success_at: string | null;
  /** Named state chip, e.g. IGV vs its H&S levels, capitulation trigger. */
  flag: string | null;
}

const SPARK_MAX = 60;

function sparkFrom(points: Point[], fromDate: string): Spark | null {
  let lo = 0, hi = points.length; // first index with date >= fromDate
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].date < fromDate) lo = mid + 1;
    else hi = mid;
  }
  const win = points.slice(Math.max(0, Math.min(lo, points.length - 2)));
  if (win.length < 2) return null;
  const ds = downsample(win, SPARK_MAX);
  return {
    v: ds.map((p) => p.value),
    t0: ds[0].date,
    t1: ds[ds.length - 1].date,
  };
}

/** σ of first differences over the trailing ~250 observations. */
function dailyMoveSigma(points: Point[]): number {
  const start = Math.max(1, points.length - 250);
  let n = 0, s = 0, ss = 0;
  for (let i = start; i < points.length; i++) {
    const d = points[i].value - points[i - 1].value;
    n++; s += d; ss += d * d;
  }
  if (n < 20) return 0;
  const mean = s / n;
  return Math.sqrt(Math.max(0, ss / n - mean * mean));
}

function dirOf(change: Change | null, epsilon: number): DirState {
  if (!change) return 'flat';
  if (change.abs > epsilon) return 'up';
  if (change.abs < -epsilon) return 'down';
  return 'flat';
}

export interface BuildOpts {
  nowIso: string;                 // full ISO timestamp of this cron run
  fetchOk: boolean;               // did this run's fetch succeed (derived: inputs ok)
  fetchError?: string;
  prevLastSuccessAt?: string | null;
}

export function buildWallState(def: KpiDef, points: Point[], opts: BuildOpts): WallStateRow {
  const today = opts.nowIso.slice(0, 10);
  const latest = points.length ? points[points.length - 1] : null;

  const changes: WallStateRow['changes'] = {};
  const sparks: WallStateRow['sparks'] = {};
  const direction_state: WallStateRow['direction_state'] = {};

  if (latest && points.length >= 2) {
    // Deadband: a move under 0.1 σ of this series' own daily move is not
    // information — it renders neutral grey instead of a weak green/red.
    // Display precision provides the floor for very quiet series.
    const epsilon = Math.max(Math.pow(10, -def.decimals) / 2, 0.1 * dailyMoveSigma(points));

    for (const tf of TIMEFRAMES) {
      let base: Point | null;
      let sparkStart: string;
      if (tf === 'd') {
        base = points[points.length - 2];
        sparkStart = base.date; // 2-point tick: yesterday → today. Honest for daily data.
      } else {
        const from = isoDaysAgo(latest.date, HORIZON_DAYS[tf]);
        base = valueOnOrBefore(points, from);
        sparkStart = from;
      }
      let change: Change | null = null;
      if (base && base.date < latest.date) {
        change = {
          abs: latest.value - base.value,
          pct: Math.abs(base.value) > 1e-12 ? ((latest.value - base.value) / Math.abs(base.value)) * 100 : null,
        };
      }
      changes[tf] = change;
      sparks[tf] = sparkFrom(points, sparkStart);
      direction_state[tf] = dirOf(change, epsilon);
    }
  }

  // Staleness: a daily series pauses over weekends and holidays, a weekly
  // one publishes in arrears, a quarterly one is fresh at 45 days old —
  // allowances are per-frequency (see defaultStaleDays), and beyond them
  // the number must not present as current.
  const staleAfter = defaultStaleDays(def);
  let status: WallStateRow['status'] = 'ok';
  let status_detail: string | null = null;

  if (!latest) {
    status = 'error';
    status_detail = opts.fetchError ? `no data — ${opts.fetchError}` : 'no data';
  } else {
    const ageDays = Math.floor(
      (Date.parse(today + 'T00:00:00Z') - Date.parse(latest.date + 'T00:00:00Z')) / 86400000,
    );
    if (ageDays > staleAfter) {
      status = 'stale';
      status_detail = `last observation ${latest.date} (${ageDays}d old)`;
      if (!opts.fetchOk && opts.fetchError) status_detail += ` — ${opts.fetchError}`;
    } else if (!opts.fetchOk) {
      // fetch failed this run but data is still within freshness allowance
      status_detail = `showing ${latest.date}; refresh failed: ${opts.fetchError ?? 'unknown'}`;
    }
  }

  // named state flags
  let flag: string | null = null;
  if (latest && def.flagLevels) {
    const { shoulder, top } = def.flagLevels;
    flag = latest.value >= top ? `BROKE >${top}`
      : latest.value >= shoulder ? `AT ${shoulder}–${top}`
      : `< ${shoulder}`;
  }
  if (latest && def.derive?.type === 'capitulation' && latest.value >= 90) {
    flag = 'CAPITULATION';
  }

  return {
    series_id: def.id,
    computed_at: opts.nowIso,
    latest_value: latest?.value ?? null,
    latest_date: latest?.date ?? null,
    changes,
    sparks,
    direction_state,
    status,
    status_detail,
    last_success_at: opts.fetchOk ? opts.nowIso : (opts.prevLastSuccessAt ?? null),
    flag,
  };
}
