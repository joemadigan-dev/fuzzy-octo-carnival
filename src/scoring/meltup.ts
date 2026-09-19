// MELT-UP SCORE (0-5) — section 6.
//
// Measures whether markets are behaving consistently with the final
// melt-up leg of the thesis. It is NOT a forecast and not a judgement that
// the melt-up will complete; it reports how much of the configuration is
// currently present.
//
// Acceleration is weighted deliberately: a six-month return that is high
// AND faster than the three months before it is the parabolic signature.
// A high but decelerating return is a late melt-up, not a building one,
// and the score says which.

import type { Point } from '../sources/types.ts';
import thresholds from '../../config/thresholds.json' with { type: 'json' };
import targets from '../../config/hunter_targets.json' with { type: 'json' };
import { build, change, drawdown, latest, noData, pctChange, type Component, type Score } from './common.ts';

const T = thresholds.meltup;

/** Nearest Hunter target across the melt-up basket, as % still to travel. */
export function targetProximity(m: Map<string, Point[]>): { pct: number | null; which: string | null } {
  const pairs: [string, string, number][] = [
    ['spx', targets.meltup.sp500.label, targets.meltup.sp500.target],
    ['dow', targets.meltup.dow.label, targets.meltup.dow.target],
    ['nasdaq', targets.meltup.nasdaq.label, targets.meltup.nasdaq.target],
    ['gold', targets.meltup.gold.label, targets.meltup.gold.target],
    ['silver', targets.meltup.silver.label, targets.meltup.silver.target],
  ];
  let best: number | null = null;
  let which: string | null = null;
  for (const [id, label, target] of pairs) {
    const l = latest(m.get(id));
    if (!l || target <= 0) continue;
    const pct = ((target - l.value) / l.value) * 100;
    if (pct < 0) continue; // already through the target; not a proximity signal
    if (best === null || pct < best) { best = pct; which = label; }
  }
  return { pct: best, which };
}

export function meltupScore(m: Map<string, Point[]>): Score {
  const spx = m.get('spx');
  const out: Component[] = [];

  // 1. six-month momentum — the spine of the measure
  const r6 = pctChange(spx, 182);
  if (r6 === null) out.push(noData('S&P six-month return'));
  else if (r6 >= T.ret6m_parabolic) {
    out.push({ delta: 1, reason: `S&P six-month return +${r6.toFixed(1)}% — at or beyond the ${T.ret6m_parabolic}% parabolic threshold` });
  } else if (r6 >= T.ret6m_notable) {
    out.push({ delta: 0.5, reason: `S&P six-month return +${r6.toFixed(1)}% — above the ${T.ret6m_notable}% notable threshold, below parabolic` });
  } else {
    out.push({ delta: 0, reason: `S&P six-month return ${r6 > 0 ? '+' : ''}${r6.toFixed(1)}% — below the ${T.ret6m_notable}% notable threshold` });
  }

  // 2. acceleration — is the recent leg faster than the one before it?
  const r3 = pctChange(spx, 91);
  if (r3 === null || r6 === null) out.push(noData('S&P acceleration'));
  else {
    const annualised3 = r3 * 2;                   // 3m scaled to a 6m pace
    const accel = annualised3 - r6;
    if (accel >= T.accel_notable) {
      out.push({ delta: 1, reason: `Accelerating — the last three months ran at a +${annualised3.toFixed(1)}% six-month pace against +${r6.toFixed(1)}% actual` });
    } else if (accel <= -T.accel_notable) {
      out.push({ delta: 0, reason: `Decelerating — the last three months ran at a ${annualised3.toFixed(1)}% six-month pace against +${r6.toFixed(1)}% actual. A late melt-up, not a building one` });
    } else {
      out.push({ delta: 0.5, reason: `Steady — three-month pace ${annualised3.toFixed(1)}% vs six-month ${r6.toFixed(1)}%, neither accelerating nor rolling over` });
    }
  }

  // 3. proximity to the nearest Hunter target
  const prox = targetProximity(m);
  if (prox.pct === null) out.push(noData('Hunter target proximity'));
  else if (prox.pct <= T.target_imminent_pct) {
    out.push({ delta: 1, reason: `${prox.which} is ${prox.pct.toFixed(1)}% from its Hunter target — inside ${T.target_imminent_pct}%` });
  } else if (prox.pct <= T.target_close_pct) {
    out.push({ delta: 0.75, reason: `${prox.which} is ${prox.pct.toFixed(1)}% from its Hunter target — inside ${T.target_close_pct}%` });
  } else if (prox.pct <= T.target_within_pct) {
    out.push({ delta: 0.5, reason: `${prox.which} is ${prox.pct.toFixed(1)}% from its Hunter target — inside ${T.target_within_pct}%` });
  } else {
    out.push({ delta: 0, reason: `Nearest Hunter target is ${prox.pct.toFixed(1)}% away (${prox.which}) — outside the ${T.target_within_pct}% band` });
  }

  // 4. credit calm WHILE equities run — the melt-up's defining configuration
  const hy = latest(m.get('hy_oas'));
  if (!hy) out.push(noData('HY spreads'));
  else if (hy.value < T.credit_calm_hy_pct && (r6 ?? 0) > 0) {
    out.push({ delta: 1, reason: `HY OAS ${hy.value.toFixed(2)}% is below ${T.credit_calm_hy_pct}% while equities rise — credit is not contradicting the advance` });
  } else if (hy.value < T.credit_calm_hy_pct) {
    out.push({ delta: 0.5, reason: `HY OAS ${hy.value.toFixed(2)}% is calm, but equities are not advancing` });
  } else {
    out.push({ delta: 0, reason: `HY OAS ${hy.value.toFixed(2)}% is above the ${T.credit_calm_hy_pct}% calm threshold — credit is no longer confirming` });
  }

  // 5. speculative conditions, read as a pair. Low VIX alone is NOT bearish
  //    and is not treated as such (brief section 6); it only counts when it
  //    sits alongside an advancing market.
  const vix = latest(m.get('vix'));
  const breadth = latest(m.get('breadth_conf'));
  if (!vix) out.push(noData('VIX'));
  else if (vix.value < T.vix_complacent && (r6 ?? 0) > T.ret6m_notable) {
    const divergent = breadth && breadth.value < T.breadth_divergence_pct;
    out.push({
      delta: divergent ? 1 : 0.5,
      reason: divergent
        ? `VIX ${vix.value.toFixed(1)} with the index up and breadth at ${breadth!.value.toFixed(1)}% — a narrow, complacent advance`
        : `VIX ${vix.value.toFixed(1)} below ${T.vix_complacent} alongside a rising index — complacent, but breadth is not yet diverging`,
    });
  } else {
    out.push({ delta: 0, reason: `VIX ${vix.value.toFixed(1)} — not in the complacent-melt-up configuration` });
  }

  return build(out);
}

/** Percentage drawdown of the S&P from its trailing peak — used by the
 *  phase model to separate "melt-up continuing" from "melt-up over". */
export const spxDrawdown = (m: Map<string, Point[]>): number | null => drawdown(m.get('spx'), 365);
export const spxChange = (m: Map<string, Point[]>, d: number) => change(m.get('spx'), d);
