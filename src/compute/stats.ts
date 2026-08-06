// Pure numeric helpers. Everything here runs in the CRON JOB only — the
// request path never computes. All O(n) via running sums.

import type { Point } from '../sources/types.ts';

/** Inner-join two series on date. Assumes both sorted ascending by date. */
export function alignByDate(a: Point[], b: Point[]): { dates: string[]; av: number[]; bv: number[] } {
  const dates: string[] = [];
  const av: number[] = [];
  const bv: number[] = [];
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    if (a[i].date === b[j].date) {
      dates.push(a[i].date);
      av.push(a[i].value);
      bv.push(b[j].value);
      i++; j++;
    } else if (a[i].date < b[j].date) i++;
    else j++;
  }
  return { dates, av, bv };
}

/** Rolling Pearson correlation over a trailing window of aligned points. */
export function rollingCorrelation(a: Point[], b: Point[], window: number): Point[] {
  const { dates, av, bv } = alignByDate(a, b);
  const n = dates.length;
  if (n < window) return [];
  const out: Point[] = [];
  let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
  for (let k = 0; k < n; k++) {
    const x = av[k], y = bv[k];
    sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y;
    if (k >= window) {
      const ox = av[k - window], oy = bv[k - window];
      sx -= ox; sy -= oy; sxx -= ox * ox; syy -= oy * oy; sxy -= ox * oy;
    }
    if (k >= window - 1) {
      const cov = sxy - (sx * sy) / window;
      const vx = sxx - (sx * sx) / window;
      const vy = syy - (sy * sy) / window;
      const denom = Math.sqrt(vx * vy);
      if (denom > 1e-12) {
        const r = cov / denom;
        out.push({ date: dates[k], value: Math.max(-1, Math.min(1, r)) });
      }
    }
  }
  return out;
}

/** Ratio of two series joined on date (num/den). */
export function ratioSeries(num: Point[], den: Point[]): Point[] {
  const { dates, av, bv } = alignByDate(num, den);
  const out: Point[] = [];
  for (let k = 0; k < dates.length; k++) {
    if (Math.abs(bv[k]) > 1e-12) out.push({ date: dates[k], value: av[k] / bv[k] });
  }
  return out;
}

/** Rolling z-score of each point vs its own trailing `window` observations. */
export function rollingZScore(points: Point[], window: number): Point[] {
  const n = points.length;
  const out: Point[] = [];
  let s = 0, ss = 0;
  for (let k = 0; k < n; k++) {
    const v = points[k].value;
    s += v; ss += v * v;
    if (k >= window) {
      const o = points[k - window].value;
      s -= o; ss -= o * o;
    }
    const m = Math.min(k + 1, window);
    if (m >= Math.min(window, 60)) { // need a reasonable sample before emitting
      const mean = s / m;
      const variance = Math.max(0, ss / m - mean * mean);
      const sd = Math.sqrt(variance);
      out.push({ date: points[k].date, value: sd > 1e-12 ? (v - mean) / sd : 0 });
    }
  }
  return out;
}

/** Uniform downsample to ≤ max points, always keeping the last point. */
export function downsample(points: Point[], max: number): Point[] {
  if (points.length <= max) return points;
  const out: Point[] = [];
  const step = (points.length - 1) / (max - 1);
  for (let i = 0; i < max; i++) {
    out.push(points[Math.round(i * step)]);
  }
  out[out.length - 1] = points[points.length - 1];
  return out;
}

/** Last point on or before `date` (binary search). */
export function valueOnOrBefore(points: Point[], date: string): Point | null {
  let lo = 0, hi = points.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].date <= date) { ans = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return ans >= 0 ? points[ans] : null;
}

export function isoDaysAgo(fromIso: string, days: number): string {
  const d = new Date(fromIso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}
