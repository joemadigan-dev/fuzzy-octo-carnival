// 2027 RECESSION MAP — four conceptual paths, priced from the live curve.
//
// THE POINT OF THIS PANEL is a single sentence: recession itself is not the
// trade, falling long discount rates are. Three of the four scenarios below
// involve a recession and they do not share a sign. The stagflation /
// fiscal-stress row is deliberately first, because it is the one a reader
// who has already decided a recession is coming will skip.
//
// The yield moves attached to each scenario are STATED ASSUMPTIONS, not
// forecasts and not probabilities — no scenario carries a likelihood,
// because we have no basis for one and an invented number would be the
// most quoted thing on the page. What is computed live is the payoff
// CONSEQUENCE of each assumed move, from the current proxy yield and the
// real remaining maturity. Change the curve and every figure here moves.

import type { Payoff } from '../compute/duration.ts';

export interface Scenario {
  id: string;
  label: string;
  /** What the long end is assumed to do. Stated, never implied. */
  yieldPath: string;
  /** The assumed parallel move in the 30Y, in basis points. */
  shiftBp: number;
  /** Modelled one-year return for the reference STRIP, in percent. */
  returnPct: number | null;
  /** $10,000 becomes. */
  valueEnd: number | null;
  /** The qualitative implication, in the module's own vocabulary. */
  implication: string;
  /** Why this path would occur, and what would have to be true. */
  mechanism: string;
}

/** Assumed parallel shifts. Chosen to span the plausible range rather than
 *  to flatter the thesis: the adverse case is as large as the good one. */
const PATHS: Omit<Scenario, 'returnPct' | 'valueEnd'>[] = [
  {
    id: 'stagflation',
    label: 'STAGFLATION / FISCAL STRESS',
    yieldPath: 'Long yields remain high or rise',
    shiftBp: 75,
    implication: 'Negative',
    mechanism: 'Growth weakens but inflation or fiscal risk keeps the long end bid away. The Fed cannot ease into it, or eases and the long end rises anyway because the term premium widens. A recession happens and the position still loses — this is the case the setup score exists to suppress.',
  },
  {
    id: 'mild',
    label: 'MILD SLOWDOWN',
    yieldPath: 'Long yields decline modestly',
    shiftBp: -50,
    implication: 'Moderately positive',
    mechanism: 'Growth cools, inflation drifts down, the Fed trims. The long end participates but is not repriced — much of the move is absorbed by the front end.',
  },
  {
    id: 'disinflationary',
    label: 'DISINFLATIONARY RECESSION',
    yieldPath: 'Long yields fall materially',
    shiftBp: -125,
    implication: 'Strongly positive',
    mechanism: 'Growth contracts while inflation falls, so the Fed can cut and the long end can follow. This is the configuration the setup score is built to identify, and the only recession that reliably helps a 29-year zero.',
  },
  {
    id: 'deep',
    label: 'DEEP RECESSION / FLIGHT TO QUALITY',
    yieldPath: 'Large fall in real yields and term premium',
    shiftBp: -200,
    implication: 'Highly convex upside',
    mechanism: 'A disorderly contraction with a bid for Treasuries as collateral. Real yields and the term premium fall together. Convexity means the gain here is larger than a linear duration estimate implies — which is the whole argument for a zero rather than a coupon bond.',
  },
];

/** Price each path off the live payoff curve. Returns the paths with null
 *  figures when there is no proxy yield, so the panel can still state the
 *  scenarios and their logic without inventing numbers for them. */
export function scenarioMap(payoff: Payoff | null): Scenario[] {
  return PATHS.map((p) => {
    if (!payoff) return { ...p, returnPct: null, valueEnd: null };
    // Reprice at this path's shift rather than interpolating the standard
    // table — the table's rows stop at ±150bp and the deep case is -200.
    const r = repriceAt(payoff, p.shiftBp);
    return { ...p, returnPct: r?.returnPct ?? null, valueEnd: r?.valueEnd ?? null };
  });
}

function repriceAt(payoff: Payoff, shiftBp: number): { returnPct: number; valueEnd: number } | null {
  const T = payoff.yearsToMaturity;
  if (!Number.isFinite(T) || T <= 1) return null;
  const y = payoff.proxyYield;
  const price = (yy: number, years: number) => {
    const r = yy / 100 / 2;
    if (1 + r <= 0) return NaN;
    return 100 / Math.pow(1 + r, 2 * years);
  };
  const p0 = price(y, T);
  const p1 = price(y + shiftBp / 100, T - 1);
  if (!Number.isFinite(p0) || !Number.isFinite(p1) || p0 <= 0) return null;
  const returnPct = (p1 / p0 - 1) * 100;
  return { returnPct, valueEnd: payoff.notional * (1 + returnPct / 100) };
}
