// THE BAROMETER — two readings, displayed together, never summed.
//
//   PRESSURE  — is stress arriving now? Fast, coincident-to-leading.
//               Falling pressure = deteriorating conditions (the metaphor
//               is literal). Green when rising, red when falling.
//   ALTITUDE  — how far is there to fall? Slow, structural. High altitude
//               is not "sell" — melt-ups end AT maximum altitude. It means
//               the eventual drawdown is larger and margin for error thinner.
//
// Weights apply to SUB-INDICES, not raw inputs. Each sub-index is built
// from its member KPIs' z-scores (membership + sign + weight live on the
// KPI in registry/kpis.ts), then itself z-normalised before entering the
// layer — so no single series can dominate through duplication. The old
// Phase 1 composite had 65% of its weight touching gold or oil; that
// concentration is exactly what this structure removes (Four Bodies now
// carries 15% of one layer).
//
// A barometer tells you pressure is dropping. It does not tell you when
// the rain starts, and it does not tell you to sell anything.

export type LayerId = 'pressure' | 'altitude';

export interface SubIndexDef {
  id: string;
  label: string;
  weight: number;
}

export interface LayerDef {
  id: LayerId;
  label: string;
  /** 'stress' layers score −Σ w·z(sub) (their subs measure bad-when-high);
   *  'level' layers score +Σ. */
  polarity: -1 | 1;
  subs: SubIndexDef[];
}

export const LAYERS: LayerDef[] = [
  {
    id: 'pressure',
    label: 'PRESSURE',
    polarity: -1, // sub-indices below measure stress; pressure is its inverse
    subs: [
      { id: 'credit_stress', label: 'CREDIT STRESS', weight: 0.35 },
      { id: 'funding_liquidity', label: 'FUNDING & LIQUIDITY', weight: 0.30 },
      { id: 'vol_structure', label: 'VOLATILITY STRUCTURE', weight: 0.20 },
      { id: 'four_bodies', label: 'FOUR BODIES', weight: 0.15 },
    ],
  },
  {
    id: 'altitude',
    label: 'ALTITUDE',
    polarity: 1,
    subs: [
      { id: 'sentiment_positioning', label: 'SENTIMENT & POSITIONING', weight: 0.40 },
      { id: 'trend_extension', label: 'TREND EXTENSION', weight: 0.25 },
      { id: 'leverage_valuation', label: 'LEVERAGE & VALUATION', weight: 0.20 },
      { id: 'breadth_rotation', label: 'BREADTH & ROTATION', weight: 0.15 },
    ],
  },
];

/** z-score lookback windows offered in the UI, in samples of each series'
 *  own native frequency (mixed frequencies must not share a sample count). */
export const Z_WINDOWS = {
  '2y': { daily: 504, weekly: 104, monthly: 24, quarterly: 8 },
  '5y': { daily: 1260, weekly: 260, monthly: 60, quarterly: 20 },
} as const;
export type ZWindow = keyof typeof Z_WINDOWS;

/** Pressure face — labels off a real barometer, ordered good → bad. */
export const PRESSURE_REGIMES = ['SET FAIR', 'FAIR', 'CHANGE', 'UNSETTLED', 'STORM'] as const;
export type PressureRegime = (typeof PRESSURE_REGIMES)[number];
export const PRESSURE_THRESHOLDS = { setFairAt: 1.0, fairAt: 0.3, unsettledBelow: -0.3, stormBelow: -1.0 };

/** Altitude gauge — its own scale, never summed with Pressure. */
export const ALTITUDE_REGIMES = ['LOW', 'MODERATE', 'HIGH', 'EXTREME'] as const;
export type AltitudeRegime = (typeof ALTITUDE_REGIMES)[number];
export const ALTITUDE_THRESHOLDS = { lowBelow: -0.5, highAt: 0.5, extremeAt: 1.25 };

/** A regime flip must persist this many consecutive sessions. */
export const HYSTERESIS_DAYS = 3;

/** The configuration that precedes a bust: high altitude + falling
 *  pressure. Logged and highlighted specifically. */
export const DIVERGENCE = {
  altitudeAtLeast: 'HIGH' as AltitudeRegime,
  pressureAtMost: 'UNSETTLED' as PressureRegime,
};

/** Diagnostics: pairwise |correlation| above this gets flagged in the UI. */
export const CORR_FLAG = 0.7;

/** Minimum share of a sub-index's (or layer's) weight that must be present
 *  before a value is published. */
export const MIN_COVERAGE = 0.5;
