// THE WALL — KPI registry. This file is the single source of truth.
// Adding a KPI to the wall = adding ONE object to KPIS below. Nothing else.
//
//  - fetched KPI:  set `source` + `seriesId`
//  - derived KPI:  set `derive` (computed in the cron job from other series)
//
// Direction semantics (three modes — see README):
//  - 'up_is_good'   rising = green   (equities, liquidity)
//  - 'down_is_good' rising = red     (spreads, VIX, funding stress)
//  - 'neutral'      coloured by direction, no judgement (oil, gold, DXY, rates)

export type Direction = 'up_is_good' | 'down_is_good' | 'neutral';
export type SourceId = 'fred' | 'stooq' | 'yahoo';

export type Derivation =
  | { type: 'ratio'; num: string; den: string }
  | { type: 'rolling_corr'; a: string; b: string; window: number };

export interface KpiDef {
  id: string;
  label: string;
  cluster: string;
  unit: string;            // display suffix: '%', '$', 'x', 'ρ' …
  unitPrefix?: boolean;    // true → unit renders before the number ('$85.20')
  decimals: number;
  /** false → hide %-change (meaningless for correlations, spreads at zero…) */
  showPct?: boolean;
  direction: Direction;
  refresh: 'daily' | 'intraday';
  /** Observations older than this many days ⇒ tile shows STALE. Daily macro
   *  series pause on weekends/holidays, so the default allows for that. */
  staleAfterDays?: number;
  source?: SourceId;
  seriesId?: string;
  /** Second REAL source tried when the primary fails — a dead provider
   *  degrades to another live feed before degrading to a stale tile. */
  fallback?: { source: SourceId; seriesId: string };
  derive?: Derivation;
}

export interface ClusterDef {
  id: string;
  label: string;
}

export const CLUSTERS: ClusterDef[] = [
  { id: 'four_bodies', label: 'THE FOUR BODIES — OIL · GOLD · DOLLAR · RATES' },
  // Phase 2: credit_stress, plumbing, yield_curve, liquidity, concentration, vol_structure
];

export const BACKFILL_START = '2015-01-01'; // deep enough for the 2020/2022 backtest

export const KPIS: KpiDef[] = [
  {
    id: 'wti',
    label: 'WTI CRUDE',
    cluster: 'four_bodies',
    unit: '$', unitPrefix: true,
    decimals: 2,
    direction: 'neutral',
    refresh: 'daily',
    source: 'fred',
    seriesId: 'DCOILWTICO',
  },
  {
    id: 'gold',
    label: 'GOLD',
    cluster: 'four_bodies',
    unit: '$', unitPrefix: true,
    decimals: 0,
    direction: 'neutral',
    refresh: 'intraday',
    source: 'stooq',
    seriesId: 'xauusd',
    fallback: { source: 'yahoo', seriesId: 'GC=F' },
  },
  {
    id: 'dxy',
    label: 'USD INDEX (BROAD)',
    cluster: 'four_bodies',
    unit: '',
    decimals: 2,
    direction: 'neutral',
    refresh: 'daily',
    staleAfterDays: 12, // FRED publishes DTWEXBGS weekly, ~1 week in arrears
    source: 'fred',
    seriesId: 'DTWEXBGS',
  },
  {
    id: 'us10y',
    label: '10Y TREASURY',
    cluster: 'four_bodies',
    unit: '%',
    decimals: 2,
    direction: 'neutral',
    refresh: 'daily',
    source: 'fred',
    seriesId: 'DGS10',
  },
  {
    id: 'us10y_real',
    label: '10Y REAL YIELD',
    cluster: 'four_bodies',
    unit: '%',
    decimals: 2,
    direction: 'neutral',
    refresh: 'daily',
    source: 'fred',
    seriesId: 'DFII10',
  },
  // ── derived ───────────────────────────────────────────────────────────
  {
    id: 'gold_oil',
    label: 'GOLD / OIL',
    cluster: 'four_bodies',
    unit: 'bbl/oz',
    decimals: 1,
    direction: 'neutral',
    refresh: 'daily',
    derive: { type: 'ratio', num: 'gold', den: 'wti' },
  },
  {
    id: 'corr_gold_real',
    label: 'GOLD:REAL10Y CORR',
    cluster: 'four_bodies',
    unit: '60d',
    decimals: 2,
    showPct: false,
    direction: 'neutral',
    refresh: 'daily',
    derive: { type: 'rolling_corr', a: 'gold', b: 'us10y_real', window: 60 },
  },
  {
    id: 'corr_wti_dxy',
    label: 'WTI:DXY CORR',
    cluster: 'four_bodies',
    unit: '60d',
    decimals: 2,
    showPct: false,
    direction: 'neutral',
    refresh: 'daily',
    staleAfterDays: 12, // can only be as fresh as DXY's weekly publication
    derive: { type: 'rolling_corr', a: 'wti', b: 'dxy', window: 60 },
  },
];

export const kpiById = new Map(KPIS.map((k) => [k.id, k]));
