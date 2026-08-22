import type { Point } from '../sources/types.ts';
import type { Derivation } from '../registry/kpis.ts';
import { ratioSeries, rollingCorrelation, rollingZScore, isoDaysAgo, valueOnOrBefore } from './stats.ts';

/** Compute a derived series from already-loaded input series.
 *  `seriesMap` is keyed by KPI id (not provider seriesId). */
export function computeDerived(d: Derivation, seriesMap: Map<string, Point[]>): Point[] {
  switch (d.type) {
    case 'ratio': {
      const num = seriesMap.get(d.num);
      const den = seriesMap.get(d.den);
      if (!num?.length || !den?.length) return [];
      return ratioSeries(num, den);
    }
    case 'rolling_corr': {
      const a = seriesMap.get(d.a);
      const b = seriesMap.get(d.b);
      if (!a?.length || !b?.length) return [];
      return rollingCorrelation(a, b, d.window);
    }
    case 'combo':
      return comboSeries(d.terms, seriesMap, d.ffillDays ?? 0);
    case 'roc': {
      const scale = d.scale ?? 1;
      return rocSeries(seriesMap.get(d.input) ?? [], d.days, d.pct ?? false)
        .map((p) => (scale === 1 ? p : { date: p.date, value: p.value * scale }));
    }
    case 'ma_extension':
      return maExtension(seriesMap.get(d.input) ?? [], d.maDays);
    case 'target_distance': {
      // % move still required to reach the target from each day's close
      return (seriesMap.get(d.input) ?? []).map((p) => ({
        date: p.date,
        value: Math.abs(p.value) > 1e-12 ? ((d.target - p.value) / p.value) * 100 : 0,
      }));
    }
    case 'completion': {
      const span = d.target - d.base;
      return (seriesMap.get(d.input) ?? []).map((p) => ({
        date: p.date,
        value: ((p.value - d.base) / span) * 100,
      }));
    }
    case 'response_gap':
      return responseGap(seriesMap.get(d.credit) ?? [], seriesMap.get(d.balance) ?? [], d.rocDays);
    case 'capitulation':
      return capitulation(d.inputs.map((id) => seriesMap.get(id) ?? []), d.rocDays);
    case 'trough_impulse':
      return troughImpulse(seriesMap.get(d.input) ?? [], d.months, d.scale ?? 1);
    case 'erp_attrib':
      return erpAttribution(seriesMap.get(d.index) ?? [], seriesMap.get(d.cashflow) ?? [],
        seriesMap.get(d.riskfree) ?? [], d.leg);
  }
}

/** Σ coef·value on a merged date axis; each input forward-filled ≤ ffillDays.
 *  With ffillDays 0, only dates where every input reports survive. */
function comboSeries(terms: { id?: string; coef: number }[], seriesMap: Map<string, Point[]>,
  ffillDays: number, resolved?: Point[][]): Point[] {
  const series = resolved ?? terms.map((t) => seriesMap.get(t.id!) ?? []);
  if (series.some((s) => !s.length)) return [];
  const dates = [...new Set(series.flat().map((p) => p.date))].sort();
  const idx = series.map(() => 0);
  const last: ({ date: string; value: number } | null)[] = series.map(() => null);
  const out: Point[] = [];
  for (const date of dates) {
    let ok = true;
    let sum = 0;
    for (let s = 0; s < series.length; s++) {
      while (idx[s] < series[s].length && series[s][idx[s]].date <= date) {
        last[s] = series[s][idx[s]];
        idx[s]++;
      }
      const l = last[s];
      if (!l || (ffillDays >= 0 && l.date < isoDaysAgo(date, Math.max(0, ffillDays)) && l.date !== date)) {
        ok = false;
        break;
      }
      sum += terms[s].coef * l.value;
    }
    if (ok) out.push({ date, value: sum });
  }
  return out;
}

/** Change vs the closest observation ≥ `days` calendar days back. */
function rocSeries(pts: Point[], days: number, pct: boolean): Point[] {
  const out: Point[] = [];
  for (const p of pts) {
    const base = valueOnOrBefore(pts, isoDaysAgo(p.date, days));
    if (!base || base.date === p.date) continue;
    if (pct) {
      if (Math.abs(base.value) > 1e-12) out.push({ date: p.date, value: ((p.value - base.value) / Math.abs(base.value)) * 100 });
    } else {
      out.push({ date: p.date, value: p.value - base.value });
    }
  }
  return out;
}

/** % above the trailing N-observation simple moving average. */
function maExtension(pts: Point[], maDays: number): Point[] {
  const out: Point[] = [];
  let sum = 0;
  for (let i = 0; i < pts.length; i++) {
    sum += pts[i].value;
    if (i >= maDays) sum -= pts[i - maDays].value;
    if (i >= maDays - 1) {
      const ma = sum / maDays;
      if (Math.abs(ma) > 1e-12) out.push({ date: pts[i].date, value: ((pts[i].value - ma) / ma) * 100 });
    }
  }
  return out;
}

/** Hunter's response gap: z(credit level) − z(rocDays-change in balance),
 *  both z-scored over ~2y of their own frequency, joined on credit dates
 *  with the balance leg forward-filled (weekly series). */
function responseGap(credit: Point[], balance: Point[], rocDays: number): Point[] {
  if (!credit.length || !balance.length) return [];
  const balRoc = rocSeries(balance, rocDays, true);
  const zCredit = rollingZScore(credit, 504);
  const zBal = rollingZScore(balRoc, 104); // weekly series → ~2y of samples
  if (!zCredit.length || !zBal.length) return [];
  const out: Point[] = [];
  let j = 0;
  let lastBal: Point | null = null;
  for (const c of zCredit) {
    while (j < zBal.length && zBal[j].date <= c.date) { lastBal = zBal[j]; j++; }
    if (lastBal && lastBal.date >= isoDaysAgo(c.date, 21)) {
      out.push({ date: c.date, value: c.value - lastBal.value });
    }
  }
  return out;
}

/** Capitulation-of-the-bears: mean rolling-percentile-rank (0–100, ~3y
 *  window) of each input's `rocDays` rate of change. Skeptics converting
 *  fast from a depressed base reads high on every leg at once. */
function capitulation(inputs: Point[][], rocDays: number): Point[] {
  const rocs = inputs.filter((s) => s.length).map((s) => rocSeries(s, rocDays, false).map(p => ({date: p.date, value: p.value})));
  if (!rocs.length) return [];
  const ranked = rocs.map((s) => percentileRank(s, 750));
  // daily axis = union of dates; each leg forward-filled ≤ 21 days
  const dates = [...new Set(ranked.flat().map((p) => p.date))].sort();
  const idx = ranked.map(() => 0);
  const last: (Point | null)[] = ranked.map(() => null);
  const out: Point[] = [];
  for (const date of dates) {
    let sum = 0, n = 0;
    for (let s = 0; s < ranked.length; s++) {
      while (idx[s] < ranked[s].length && ranked[s][idx[s]].date <= date) { last[s] = ranked[s][idx[s]]; idx[s]++; }
      const l = last[s];
      if (l && l.date >= isoDaysAgo(date, 21)) { sum += l.value; n++; }
    }
    if (n === ranked.length) out.push({ date, value: sum / n });
  }
  return out;
}

/** Value minus its own trailing-window minimum, via a monotonic deque so
 *  the whole history is O(n) rather than O(n·window) — the parameter sweep
 *  runs this five times over 20+ years of daily data inside one cron run. */
function troughImpulse(pts: Point[], months: number, scale: number): Point[] {
  if (!pts.length) return [];
  const winDays = Math.round(months * 30.44);
  const out: Point[] = [];
  const dq: number[] = []; // indices, values ascending
  let head = 0;
  for (let i = 0; i < pts.length; i++) {
    while (dq.length > head && pts[dq[dq.length - 1]].value >= pts[i].value) dq.pop();
    dq.push(i);
    const from = isoDaysAgo(pts[i].date, winDays);
    while (dq.length > head && pts[dq[head]].date < from) head++;
    out.push({ date: pts[i].date, value: (pts[i].value - pts[dq[head]].value) * scale });
  }
  return out;
}

/** First-order attribution of the monthly change in a cash-yield ERP proxy
 *  (CF/Index + g − rf) to one of its three drivers. The legs sum to the
 *  change in the proxy, not to the change in Damodaran's solved ERP — the
 *  UI says so. The point is the SIGN and the mix: a falling ERP driven by
 *  the index rallying is not the same event as one driven by rates rising.
 *  Returned in percentage points, matching the ERP series' units. */
function erpAttribution(index: Point[], cf: Point[], rf: Point[],
  leg: 'index' | 'cashflow' | 'riskfree'): Point[] {
  if (!index.length || !cf.length || !rf.length) return [];
  const cfBy = new Map(cf.map((p) => [p.date, p.value]));
  const rfBy = new Map(rf.map((p) => [p.date, p.value]));
  const out: Point[] = [];
  for (let i = 1; i < index.length; i++) {
    const d = index[i].date, dPrev = index[i - 1].date;
    const i1 = index[i].value, i0 = index[i - 1].value;
    const c1 = cfBy.get(d), c0 = cfBy.get(dPrev);
    const r1 = rfBy.get(d), r0 = rfBy.get(dPrev);
    if (c1 === undefined || c0 === undefined || r1 === undefined || r0 === undefined) continue;
    if (Math.abs(i1) < 1e-9 || Math.abs(i0) < 1e-9) continue;
    let v: number;
    if (leg === 'index') v = (c0 / i1 - c0 / i0) * 100;
    else if (leg === 'cashflow') v = (c1 / i1 - c0 / i1) * 100;
    else v = -(r1 - r0); // rf series is already in percentage points
    out.push({ date: d, value: v });
  }
  return out;
}

/** Rolling percentile rank of each point vs its trailing `window` points. */
function percentileRank(pts: Point[], window: number): Point[] {
  const out: Point[] = [];
  for (let i = 0; i < pts.length; i++) {
    const lo = Math.max(0, i - window + 1);
    const n = i - lo + 1;
    if (n < 26) continue; // need half a year of samples before ranking
    let below = 0;
    for (let j = lo; j <= i; j++) if (pts[j].value <= pts[i].value) below++;
    out.push({ date: pts[i].date, value: (below / n) * 100 });
  }
  return out;
}
