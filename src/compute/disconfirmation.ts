// DISCONFIRMATION — the counterweight to a confirmation machine.
//
// Every thesis instrumented on this wall predicts stress. A dashboard built
// to detect the thing its owner already believes will detect it, and one
// wearing a percentile scale and a backtest is more dangerous than one
// without, because it looks rigorous. These tests state the conditions
// under which the bear case is NOT being confirmed, and get the same
// screen space and the same daily logging as the stress readings.
//
// Runs in the cron job. A test with no data reads UNKNOWN — never a
// silent pass and never a silent fail.

import type { Point } from '../sources/types.ts';
import { isoDaysAgo, valueOnOrBefore } from './stats.ts';
import { THESIS_FORECASTS } from '../registry/kpis.ts';

export interface TestResult {
  id: string;
  label: string;
  /** true = disconfirming (bear case weakened), false = confirming,
   *  null = no data. Nulls are excluded from the denominator. */
  pass: boolean | null;
  detail: string;
  caveat?: string;
}

export interface DisconfirmationResult {
  tests: TestResult[];
  passing: number;
  total: number;
  /** Daily [date, passing, total] for charting beside the Barometer. */
  history: { date: string; passing: number; total: number }[];
  decay: {
    label: string; claim: string; statedOn: string;
    horizonMonths: number; elapsedMonths: number; overdueMonths: number;
  }[];
}

const at = (pts: Point[] | undefined, d: string): number | null =>
  pts?.length ? (valueOnOrBefore(pts, d)?.value ?? null) : null;

/** Median of the trailing `days` calendar window ending at d. */
function trailingMedian(pts: Point[] | undefined, d: string, days: number): number | null {
  if (!pts?.length) return null;
  const from = isoDaysAgo(d, days);
  const vals: number[] = [];
  for (const p of pts) {
    if (p.date > d) break;
    if (p.date >= from) vals.push(p.value);
  }
  if (vals.length < 8) return null;
  vals.sort((a, b) => a - b);
  const m = vals.length >> 1;
  return vals.length % 2 ? vals[m] : (vals[m - 1] + vals[m]) / 2;
}

/** Change over `days` ending at d. */
function change(pts: Point[] | undefined, d: string, days: number): number | null {
  if (!pts?.length) return null;
  const now = valueOnOrBefore(pts, d);
  const then = valueOnOrBefore(pts, isoDaysAgo(d, days));
  if (!now || !then || then.date >= now.date) return null;
  return now.value - then.value;
}

const pctOr = (v: number | null, d = 2) => (v === null ? '—' : v.toFixed(d));

/** Evaluate all tests as of one date. */
function evaluate(m: Map<string, Point[]>, d: string): TestResult[] {
  const out: TestResult[] = [];

  // 1. implied ERP above its 10-year median — a fatter risk cushion than
  //    the last decade has typically offered
  {
    const erp = m.get('erp');
    const v = at(erp, d), med = trailingMedian(erp, d, 3652);
    out.push({
      id: 'erp_above_median', label: 'Implied ERP above its 10-year median',
      pass: v === null || med === null ? null : v > med,
      detail: v === null ? 'no ERP data' : `${pctOr(v)}% vs median ${pctOr(med)}%`,
    });
  }

  // 2. credit spreads below their 5-year median AND not widening
  {
    const hy = m.get('hy_oas'), roc = m.get('hy_roc20');
    const v = at(hy, d), med = trailingMedian(hy, d, 1826), r = at(roc, d);
    out.push({
      id: 'credit_calm', label: 'Credit spreads below 5-year median, not widening',
      pass: v === null || med === null || r === null ? null : v < med && r <= 0,
      detail: v === null ? 'no credit data'
        : `HY ${pctOr(v)}% vs median ${pctOr(med)}%, 20d ${r === null ? '—' : (r > 0 ? '+' : '') + r.toFixed(0)}bp`,
      caveat: 'FRED licenses ICE BofA spreads on a rolling ~3y window, so the "5-year" median is computed over whatever history exists.',
    });
  }

  // 3. breadth improving — equal-weight holding its own against cap-weight
  {
    const b = m.get('breadth_conf');
    const v = at(b, d);
    out.push({
      id: 'breadth_improving', label: 'Breadth improving — RSP/SPY in uptrend',
      pass: v === null ? null : v > 0,
      detail: v === null ? 'no breadth data' : `RSP/SPY 63d ${v > 0 ? '+' : ''}${v.toFixed(2)}%`,
    });
  }

  // 4. earnings growth positive
  {
    const cf = m.get('erp_cf');
    const g = (() => {
      if (!cf?.length) return null;
      const now = valueOnOrBefore(cf, d), then = valueOnOrBefore(cf, isoDaysAgo(d, 365));
      if (!now || !then || Math.abs(then.value) < 1e-9 || then.date >= now.date) return null;
      return ((now.value - then.value) / Math.abs(then.value)) * 100;
    })();
    out.push({
      id: 'earnings_growth', label: 'Earnings growth positive',
      pass: g === null ? null : g > 0,
      detail: g === null ? 'no cash-flow data' : `trailing 12m cash flow ${g > 0 ? '+' : ''}${g.toFixed(1)}% y/y`,
      caveat: 'AGGREGATE, not ex-AI. The brief asks for ex-AI earnings growth; no free source decomposes S&P earnings that way, so this is total index cash flow and will flatter the test exactly when AI capex is carrying the index.',
    });
  }

  // 5. real yields easing — re-specified against the trough impulse, the
  //    sharper form of the same test: how far real yields have risen from
  //    their own 18-month low, and whether that is now easing
  {
    const imp = m.get('real_yield_impulse');
    const v = at(imp, d), c = change(imp, d, 60);
    const r = m.get('us10y_real');
    const rc = change(r, d, 60);
    const pass = v === null || c === null ? (rc === null ? null : rc < 0) : (v < 50 || c < 0);
    out.push({
      id: 'real_yields_falling', label: 'Real-yield impulse easing, not building',
      pass,
      detail: v === null || c === null
        ? (rc === null ? 'no real-yield data' : `10Y real 60d ${rc > 0 ? '+' : ''}${(rc * 100).toFixed(0)}bp`)
        : `impulse ${v.toFixed(0)}bp from 18m trough, 60d ${c > 0 ? '+' : ''}${c.toFixed(0)}bp`,
      caveat: 'The 75bp threshold this impulse is usually quoted against is not supported by the parameter sweep; this test uses direction and a 50bp floor, not the published level.',
    });
  }

  // 6. no funding stress in the plumbing
  {
    const s = m.get('sofr_iorb');
    const v = at(s, d);
    out.push({
      id: 'funding_normal', label: 'No funding stress — SOFR–IORB normal',
      pass: v === null ? null : Math.abs(v) <= 5,
      detail: v === null ? 'no SOFR–IORB data' : `${v > 0 ? '+' : ''}${v.toFixed(0)}bp vs ±5bp normal band`,
    });
  }

  // 7. policy responding to stress rather than lagging it
  {
    const g = m.get('response_gap');
    const v = at(g, d);
    out.push({
      id: 'response_narrow', label: 'Response Gap narrow — policy responding',
      pass: v === null ? null : v < 1,
      detail: v === null ? 'no response-gap data' : `${v > 0 ? '+' : ''}${v.toFixed(2)}z vs 1.00z threshold`,
    });
  }

  return out;
}

export function computeDisconfirmation(m: Map<string, Point[]>, today: string): DisconfirmationResult {
  const tests = evaluate(m, today);
  const known = tests.filter((t) => t.pass !== null);

  // daily history, monthly-sampled over 5 years then daily for the last
  // year — enough to chart without recomputing medians 2,000 times
  const history: DisconfirmationResult['history'] = [];
  const start = isoDaysAgo(today, 1826);
  for (let d = start; d < isoDaysAgo(today, 365); d = isoDaysAgo(d, -28)) {
    const r = evaluate(m, d).filter((t) => t.pass !== null);
    if (r.length) history.push({ date: d, passing: r.filter((t) => t.pass).length, total: r.length });
  }
  for (let d = isoDaysAgo(today, 365); d <= today; d = isoDaysAgo(d, -7)) {
    const r = evaluate(m, d).filter((t) => t.pass !== null);
    if (r.length) history.push({ date: d, passing: r.filter((t) => t.pass).length, total: r.length });
  }

  // thesis decay: elapsed time against a stated horizon. A fact, not a
  // criticism — and exactly the fact a confirmation machine would never
  // surface about itself.
  const decay = THESIS_FORECASTS.map((f) => {
    const elapsed = (Date.parse(today) - Date.parse(f.statedOn)) / (86400000 * 30.44);
    return {
      label: f.label, claim: f.claim, statedOn: f.statedOn,
      horizonMonths: f.horizonMonths,
      elapsedMonths: Math.round(elapsed * 10) / 10,
      overdueMonths: Math.round(Math.max(0, elapsed - f.horizonMonths) * 10) / 10,
    };
  });

  return {
    tests,
    passing: known.filter((t) => t.pass).length,
    total: known.length,
    history,
    decay,
  };
}
