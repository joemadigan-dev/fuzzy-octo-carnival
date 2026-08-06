// Composite signal configuration — weights and thresholds live HERE, not in
// code, because they will be tuned constantly.
//
// The composite is a REGIME STATE (RISK-ON / NEUTRAL / CAUTION / STRESS),
// not an order. Every input is z-scored against its own trailing distribution
// (2y and 5y windows, toggleable in the UI) so heterogeneous units combine.
// score = Σ weight_i · sign_i · z_i   (weights normalised to sum to 1)

export interface SignalInput {
  /** KPI id from the registry — its observation history feeds the z-score. */
  id: string;
  weight: number;
  /** +1: higher-than-usual value pushes toward STRESS. -1: inverse. */
  sign: 1 | -1;
  /** Shown in the transparency panel. */
  rationale: string;
}

export const SIGNAL_INPUTS: SignalInput[] = [
  { id: 'gold_oil',       weight: 0.30, sign: 1,
    rationale: 'Ounces-per-barrel spikes when oil collapses or gold bids — classic recession/stress tell.' },
  { id: 'corr_gold_real', weight: 0.20, sign: 1,
    rationale: 'Gold vs real yields is normally strongly negative; a break toward positive is the anomaly.' },
  { id: 'corr_wti_dxy',   weight: 0.15, sign: 1,
    rationale: 'Oil vs dollar is normally negative; co-movement signals a common macro shock.' },
  { id: 'dxy',            weight: 0.20, sign: 1,
    rationale: 'Broad-dollar spikes are global funding stress — the dollar is the world’s margin call.' },
  { id: 'us10y_real',     weight: 0.15, sign: 1,
    rationale: 'Fast real-yield rises tighten financial conditions and pressure every risk asset.' },
];

/** z-score lookback windows offered in the UI (trading days). */
export const Z_WINDOWS = { '2y': 504, '5y': 1260 } as const;
export type ZWindow = keyof typeof Z_WINDOWS;

/** Regime thresholds on the composite score, with hysteresis: a breach must
 *  persist HYSTERESIS_DAYS consecutive observations before the state flips. */
export const REGIMES = ['RISK-ON', 'NEUTRAL', 'CAUTION', 'STRESS'] as const;
export type Regime = (typeof REGIMES)[number];

export const THRESHOLDS = {
  riskOnBelow: -0.5,   // score < -0.5           → RISK-ON
  cautionAt: 0.5,      // 0.5 ≤ score < 1.25     → CAUTION
  stressAt: 1.25,      // score ≥ 1.25           → STRESS
};
export const HYSTERESIS_DAYS = 3;
