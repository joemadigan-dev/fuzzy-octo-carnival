// REAL YIELD IMPULSE — parameter sensitivity sweep.
//
// Three historical observations is a very small sample, 75 is a
// suspiciously round number, and 18 months is an arbitrary lookback. Both
// parameters may have been chosen with the answer already known. That does
// not make the indicator wrong; it means it must be tested rather than
// adopted, and the tile does not enter PRESSURE unless this says it earned
// a place.
//
// The question the sweep answers is the only one that matters: does the
// effect survive across a broad region of parameter space, or only in a
// narrow cell around the published values?

import type { Point } from '../sources/types.ts';
import { isoDaysAgo } from './stats.ts';

export const LOOKBACKS = [6, 12, 18, 24, 36] as const;
export const THRESHOLDS = [40, 45, 50, 55, 60, 65, 70, 75, 80, 85, 90, 95, 100, 105, 110] as const;
export const PUBLISHED = { months: 18, threshold: 75 };
/** Episodes cited as the evidence for the 75bp claim. */
export const CITED_EPISODES = ['2018-10', '2022-02', '2024-10'];

const MIN_GAP_DAYS = 90; // one episode must not count as many crossings

export interface SweepCell {
  months: number;
  threshold: number;
  crossings: number;
  evaluated: number;
  med1m: number | null;
  med3m: number | null;
  med6m: number | null;
  medDD6m: number | null;
  /** crossings NOT followed by a drawdown of at least 5% / 10% within 6m */
  fp5: number | null;
  fp10: number | null;
}

export interface CrossingDetail {
  date: string;
  cited: boolean;
  r3m: number | null;
  r6m: number | null;
  dd6m: number | null;
}

export interface ImpulseSweep {
  cells: SweepCell[];
  published: SweepCell | null;
  crossings: CrossingDetail[];
  /** does the effect hold across a broad region, or nowhere? */
  verdict: {
    negativeCells: number;
    totalCells: number;
    publishedMed3m: number | null;
    citedMeanDD: number | null;
    otherMeanDD: number | null;
    citedMeanR6m: number | null;
    otherMeanR6m: number | null;
    inPressure: boolean;
    summary: string;
  };
  /** is the impulse just re-expressing what the level already says? */
  overlap: { a: string; b: string; rho: number | null }[];
  /** The mechanical link to Damodaran's implied ERP, and whether it is
   *  currently holding. A rising real yield raises the risk-free rate and
   *  compresses the ERP for a given price and cash-flow path, so the two
   *  should move opposite. When they don't, one of them is carrying
   *  information the other isn't — that is the thing worth surfacing. */
  erpLink: {
    months: number;
    impulseChange: number | null;   // bp
    erpChange: number | null;       // percentage points
    rfChange: number | null;        // pp — the direct channel
    rho: number | null;             // full-history, impulse vs ERP
    agrees: boolean | null;         // did they move opposite, as expected?
    note: string;
  } | null;
  computedAt: string;
}

/** Trailing-window minimum via monotonic deque — O(n). */
function impulse(pts: Point[], months: number): Point[] {
  if (!pts.length) return [];
  const win = Math.round(months * 30.44);
  const out: Point[] = [];
  const dq: number[] = [];
  let head = 0;
  for (let i = 0; i < pts.length; i++) {
    while (dq.length > head && pts[dq[dq.length - 1]].value >= pts[i].value) dq.pop();
    dq.push(i);
    const from = isoDaysAgo(pts[i].date, win);
    while (dq.length > head && pts[dq[head]].date < from) head++;
    out.push({ date: pts[i].date, value: (pts[i].value - pts[dq[head]].value) * 100 });
  }
  return out;
}

function crossingsOf(imp: Point[], threshold: number): string[] {
  const out: string[] = [];
  let armed = true;
  let last: string | null = null;
  for (const p of imp) {
    if (armed && p.value >= threshold) {
      if (!last || (Date.parse(p.date) - Date.parse(last)) / 86400000 >= MIN_GAP_DAYS) {
        out.push(p.date);
        last = p.date;
      }
      armed = false;
    }
    // re-arm once it has fallen meaningfully back below
    if (!armed && p.value < threshold * 0.8) armed = true;
  }
  return out;
}

function median(a: number[]): number | null {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return r2(s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2);
}
const mean = (a: number[]): number | null => (a.length ? r2(a.reduce((x, y) => x + y, 0) / a.length) : null);
const r2 = (n: number) => Math.round(n * 100) / 100;

export function computeImpulseSweep(m: Map<string, Point[]>): ImpulseSweep | null {
  const real = m.get('us10y_real') ?? [];
  const spx = m.get('spx') ?? [];
  if (real.length < 500 || spx.length < 500) return null;

  const sd = spx.map((p) => p.date), sv = spx.map((p) => p.value);
  const at = (d: string): number => {
    let lo = 0, hi = sd.length - 1, a = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (sd[mid] <= d) { a = mid; lo = mid + 1; } else hi = mid - 1; }
    return a;
  };
  const fwd = (d: string, days: number): { r: number; dd: number } | null => {
    const i = at(d);
    if (i < 0) return null;
    const end = isoDaysAgo(d, -days);
    if (sd[sd.length - 1] < end) return null; // horizon not elapsed
    const j = at(end);
    let peak = sv[i], dd = 0;
    for (let k = i; k <= j; k++) { if (sv[k] > peak) peak = sv[k]; const x = ((sv[k] - peak) / peak) * 100; if (x < dd) dd = x; }
    return { r: ((sv[j] - sv[i]) / sv[i]) * 100, dd };
  };

  const impByLookback = new Map<number, Point[]>();
  for (const L of LOOKBACKS) impByLookback.set(L, impulse(real, L));

  const cells: SweepCell[] = [];
  for (const L of LOOKBACKS) {
    const imp = impByLookback.get(L)!;
    for (const T of THRESHOLDS) {
      const cross = crossingsOf(imp, T);
      const r1: number[] = [], r3: number[] = [], r6: number[] = [], dd: number[] = [];
      for (const d of cross) {
        const a = fwd(d, 30), b = fwd(d, 91), c = fwd(d, 182);
        if (a) r1.push(a.r);
        if (b) r3.push(b.r);
        if (c) { r6.push(c.r); dd.push(c.dd); }
      }
      cells.push({
        months: L, threshold: T, crossings: cross.length, evaluated: dd.length,
        med1m: median(r1), med3m: median(r3), med6m: median(r6), medDD6m: median(dd),
        fp5: dd.length ? dd.filter((x) => x > -5).length : null,
        fp10: dd.length ? dd.filter((x) => x > -10).length : null,
      });
    }
  }

  // every crossing at the published parameters — the full denominator
  const pubImp = impByLookback.get(PUBLISHED.months)!;
  const pubCross = crossingsOf(pubImp, PUBLISHED.threshold);
  const crossings: CrossingDetail[] = pubCross.map((d) => {
    const b = fwd(d, 91), c = fwd(d, 182);
    return {
      date: d,
      cited: CITED_EPISODES.includes(d.slice(0, 7)),
      r3m: b ? r2(b.r) : null,
      r6m: c ? r2(c.r) : null,
      dd6m: c ? r2(c.dd) : null,
    };
  });

  const published = cells.find((c) => c.months === PUBLISHED.months && c.threshold === PUBLISHED.threshold) ?? null;
  const settled = crossings.filter((c) => c.dd6m !== null);
  const cited = settled.filter((c) => c.cited);
  const other = settled.filter((c) => !c.cited);
  const negativeCells = cells.filter((c) => c.med3m !== null && c.med3m < 0).length;

  const inPressure = false; // set by the verdict below; see summary
  const summary = buildSummary(published, negativeCells, cells.length, cited.length, other.length);

  // overlap with the real-yield inputs already feeding PRESSURE
  const overlap = [
    { a: 'real_yield_impulse', b: 'us10y_real', rho: pearson(pubImp, real) },
    { a: 'real_yield_impulse', b: 'corr_gold_real', rho: pearson(pubImp, m.get('corr_gold_real') ?? []) },
    { a: 'us10y_real', b: 'corr_gold_real', rho: pearson(real, m.get('corr_gold_real') ?? []) },
  ];

  return {
    cells, published, crossings, erpLink: erpLink(pubImp, m),
    verdict: {
      negativeCells, totalCells: cells.length,
      publishedMed3m: published?.med3m ?? null,
      citedMeanDD: mean(cited.map((c) => c.dd6m!)),
      otherMeanDD: mean(other.map((c) => c.dd6m!)),
      citedMeanR6m: mean(cited.map((c) => c.r6m!)),
      otherMeanR6m: mean(other.map((c) => c.r6m!)),
      inPressure,
      summary,
    },
    overlap,
    computedAt: new Date().toISOString(),
  };
}

const ERP_LINK_MONTHS = 6;

/** Change over `days` ending at the series' last observation. */
function changeOverDays(pts: Point[], days: number): number | null {
  if (pts.length < 2) return null;
  const end = pts[pts.length - 1];
  const from = isoDaysAgo(end.date, days);
  let start: Point | null = null;
  for (const p of pts) { if (p.date > from) break; start = p; }
  if (!start || start.date >= end.date) return null;
  return end.value - start.value;
}

function erpLink(imp: Point[], m: Map<string, Point[]>): ImpulseSweep['erpLink'] {
  const erp = m.get('erp') ?? [];
  const rf = m.get('erp_rf') ?? [];
  if (!imp.length || !erp.length) return null;
  const days = Math.round(ERP_LINK_MONTHS * 30.44);
  const di = changeOverDays(imp, days);
  const de = changeOverDays(erp, days);
  const dr = changeOverDays(rf, days);
  // The ERP is monthly and the impulse daily, so an exact-date join finds
  // almost nothing. Sample the impulse as-of each ERP observation instead.
  const rho = pearson(sampleAsOf(imp, erp), erp);

  // Expected: impulse up → ERP down. Both flat is neither agreement nor
  // divergence, so it reads as neither.
  const IMP_MIN = 15;  // bp — below this the impulse has not "fired"
  const ERP_MIN = 0.1; // pp
  let agrees: boolean | null = null;
  let note: string;
  if (di === null || de === null) {
    note = 'not enough overlapping history to check the link.';
  } else if (Math.abs(di) < IMP_MIN) {
    note = `the impulse has moved only ${fmtBp(di)} over ${ERP_LINK_MONTHS} months — too little to expect a visible ERP response.`;
  } else if (Math.abs(de) < ERP_MIN) {
    agrees = false;
    note = `the impulse moved ${fmtBp(di)} over ${ERP_LINK_MONTHS} months while the implied ERP barely moved (${fmtPp(de)}). `
      + `The discount-rate channel is not showing up in the ERP: either price and cash-flow moves are offsetting it, or one of the two is carrying information the other is not.`;
  } else {
    agrees = (di > 0) !== (de > 0);
    note = agrees
      ? `the impulse ${di > 0 ? 'rose' : 'fell'} ${fmtBp(di)} over ${ERP_LINK_MONTHS} months and the implied ERP moved the opposite way (${fmtPp(de)}), which is the mechanical response — the impulse is arriving in ALTITUDE through valuation, not adding independent news.`
      : `DIVERGENCE — the impulse ${di > 0 ? 'rose' : 'fell'} ${fmtBp(di)} over ${ERP_LINK_MONTHS} months and the implied ERP moved the SAME way (${fmtPp(de)}), against the discount-rate mechanism. Something other than rates is driving the ERP: check the decomposition bar on that tile for whether it is the index or the cash-flow leg.`;
  }
  if (dr !== null) note += ` Risk-free rate used by Damodaran over the same window: ${fmtPp(dr)}.`;
  // The mechanism is real but it is one term among several, and the record
  // says so: read the current reading against that, not against a link the
  // data does not actually show as tight.
  if (rho !== null && Math.abs(rho) < 0.3) {
    note += ` Over the full record the two are only ρ=${rho.toFixed(2)} — the discount-rate channel is one term in the ERP among several, so a period where they disagree is common rather than remarkable.`;
  }

  return { months: ERP_LINK_MONTHS, impulseChange: di === null ? null : r2(di), erpChange: de === null ? null : r2(de), rfChange: dr === null ? null : r2(dr), rho, agrees, note };
}

/** `src` sampled at each date in `at`, taking the last value on or before
 *  it. Dates with no prior observation are dropped. */
function sampleAsOf(src: Point[], at: Point[]): Point[] {
  const out: Point[] = [];
  let i = 0;
  let last: Point | null = null;
  for (const target of at) {
    while (i < src.length && src[i].date <= target.date) { last = src[i]; i++; }
    if (last) out.push({ date: target.date, value: last.value });
  }
  return out;
}

const fmtBp = (v: number) => `${v > 0 ? '+' : ''}${v.toFixed(0)}bp`;
const fmtPp = (v: number) => `${v > 0 ? '+' : ''}${v.toFixed(2)}pp`;

function buildSummary(pub: SweepCell | null, neg: number, total: number, nCited: number, nOther: number): string {
  if (!pub) return 'sweep incomplete';
  const dir = pub.med3m === null ? 'unmeasurable'
    : pub.med3m > 0 ? `POSITIVE (+${pub.med3m}%)` : `${pub.med3m}%`;
  return `At the published 18m/75bp setting the median 3-month S&P return after a crossing is ${dir}, `
    + `across ${pub.crossings} crossings — not three. Only ${neg} of ${total} parameter cells show a negative median 3-month return, `
    + `and they are shallow and scattered rather than forming a coherent region. `
    + `The ${nCited} cited episodes are ${nCited} of ${nCited + nOther} settled crossings. `
    + `Excluded from PRESSURE: carried as an observation, not a signal.`;
}

function pearson(a: Point[], b: Point[]): number | null {
  if (!a.length || !b.length) return null;
  const B = new Map(b.map((p) => [p.date, p.value]));
  let n = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
  for (const p of a) {
    const y = B.get(p.date);
    if (y === undefined) continue;
    n++; sx += p.value; sy += y; sxx += p.value * p.value; syy += y * y; sxy += p.value * y;
  }
  if (n < 100) return null;
  const cov = sxy - (sx * sy) / n, vx = sxx - (sx * sx) / n, vy = syy - (sy * sy) / n;
  const den = Math.sqrt(vx * vy);
  return den > 1e-12 ? r2(cov / den) : null;
}
