// THE WALL — KPI registry. This file is the single source of truth.
// Adding a KPI to the wall = adding ONE object to KPIS below. Nothing else.
//
//  - fetched KPI:  set `source` + `seriesId`
//  - derived KPI:  set `derive` (computed in the cron job from other series)
//  - hidden KPI:   fetched/stored but not tiled (feeds derived tiles)
//
// Direction semantics (three modes — see README):
//  - 'up_is_good'   rising = green   (equities, liquidity)
//  - 'down_is_good' rising = red     (spreads, VIX, funding stress)
//  - 'neutral'      coloured by direction, no judgement (oil, gold, DXY, rates)
//
// THE BAROMETER membership: `subIndex` names the sub-index this KPI feeds
// (see registry/signal.ts for layer weights); `subSign` is +1 when a HIGH
// value raises that sub-index's named quantity (stress for Pressure subs,
// altitude for Altitude subs). Tile colour and barometer sign are separate
// concerns on purpose — a low VIX tile is green, yet feeds Altitude.

export type Direction = 'up_is_good' | 'down_is_good' | 'neutral';
export type SourceId = 'fred' | 'stooq' | 'yahoo' | 'cnn' | 'naaim';
export type Freq = 'daily' | 'weekly' | 'monthly' | 'quarterly';

export type Derivation =
  | { type: 'ratio'; num: string; den: string }
  | { type: 'rolling_corr'; a: string; b: string; window: number }
  /** Σ coef·value over date axis, inputs forward-filled up to ffillDays. */
  | { type: 'combo'; terms: { id: string; coef: number }[]; ffillDays?: number }
  /** change over `days` calendar days (pct: percent instead of absolute;
   *  scale: display multiplier, e.g. 100 for %→bp). */
  | { type: 'roc'; input: string; days: number; pct?: boolean; scale?: number }
  /** % extension above the input's own N-day moving average. */
  | { type: 'ma_extension'; input: string; maDays: number }
  /** % distance from current value to a forecast target. */
  | { type: 'target_distance'; input: string; target: number }
  /** % of the way from base to target. */
  | { type: 'completion'; input: string; base: number; target: number }
  /** z(credit) − z(rocDays-change in balance): Hunter's response gap. */
  | { type: 'response_gap'; credit: string; balance: string; rocDays: number }
  /** mean percentile-rank of the inputs' 12-week rate of change. */
  | { type: 'capitulation'; inputs: string[]; rocDays: number };

export interface KpiDef {
  id: string;
  label: string;
  cluster: string;
  unit: string;            // display suffix: '%', '$', 'x', 'z', 'bp' …
  unitPrefix?: boolean;    // true → unit renders before the number ('$85.20')
  decimals: number;
  /** false → hide %-change (meaningless for correlations, spreads at zero…) */
  showPct?: boolean;
  direction: Direction;
  refresh: 'daily' | 'intraday';
  /** native publication frequency — drives staleness defaults and z-score
   *  window scaling. Default 'daily'. */
  freq?: Freq;
  /** Observations older than this many days ⇒ tile shows STALE. Defaults
   *  are per-frequency (daily ~6d, weekly ~16d, monthly ~45d, qtrly ~135d). */
  staleAfterDays?: number;
  /** true → fetched and stored but never tiled (feeds derived KPIs). */
  hidden?: boolean;
  source?: SourceId;
  seriesId?: string;
  /** Multiplier applied to fetched values before storage — normalises
   *  provider units (e.g. WALCL publishes $mn; store $tn with 1e-6). */
  fetchScale?: number;
  /** Second REAL source tried when the primary fails — a dead provider
   *  degrades to another live feed before degrading to a stale tile. */
  fallback?: { source: SourceId; seriesId: string };
  derive?: Derivation;
  /** BAROMETER membership (see header note). */
  subIndex?: string;
  subSign?: 1 | -1;
  subWeight?: number;      // weight within the sub-index; default equal
  /** Named horizontal levels → cron computes a state flag for the tile,
   *  e.g. IGV vs the head-and-shoulders shoulder/top. */
  flagLevels?: { shoulder: number; top: number };
  /** Shown on the tile — for dated forecasts ("by 2027-02"). */
  deadline?: string;
}

export interface ClusterDef {
  id: string;
  label: string;
  /** Rendered persistently on the cluster header; marks forecast-tracking
   *  clusters as one analyst's calls, never confusable with market data. */
  attribution?: string;
}

export const CLUSTERS: ClusterDef[] = [
  { id: 'four_bodies', label: 'THE FOUR BODIES — OIL · GOLD · DOLLAR · RATES' },
  { id: 'credit_stress', label: 'CREDIT STRESS' },
  { id: 'funding', label: 'FUNDING & LIQUIDITY' },
  { id: 'sentiment', label: 'SENTIMENT & POSITIONING' },
  { id: 'trend', label: 'TREND, BREADTH & ROTATION' },
  { id: 'thesis', label: 'THESIS TRACKERS — HUNTER TARGETS',
    attribution: 'TRACKING DAVID HUNTER FORECASTS · NOT MARKET DATA' },
];

/** Deep backfill: credit/sentiment need to have seen 2008 and 2020 for the
 *  backtest to mean anything. Sources cap their own depth. */
export const BACKFILL_START = '2000-01-01';

export const KPIS: KpiDef[] = [
  // ═══ THE FOUR BODIES ══════════════════════════════════════════════════
  {
    id: 'wti', label: 'WTI CRUDE', cluster: 'four_bodies',
    unit: '$', unitPrefix: true, decimals: 2, direction: 'neutral', refresh: 'daily',
    source: 'fred', seriesId: 'DCOILWTICO',
  },
  {
    id: 'gold', label: 'GOLD', cluster: 'four_bodies',
    unit: '$', unitPrefix: true, decimals: 0, direction: 'neutral', refresh: 'intraday',
    source: 'stooq', seriesId: 'xauusd',
    fallback: { source: 'yahoo', seriesId: 'GC=F' },
  },
  {
    id: 'dxy', label: 'USD INDEX (BROAD)', cluster: 'four_bodies',
    unit: '', decimals: 2, direction: 'neutral', refresh: 'daily',
    staleAfterDays: 12, // FRED publishes DTWEXBGS weekly, ~1 week in arrears
    source: 'fred', seriesId: 'DTWEXBGS',
    subIndex: 'four_bodies', subSign: 1,
  },
  {
    id: 'us10y', label: '10Y TREASURY', cluster: 'four_bodies',
    unit: '%', decimals: 2, direction: 'neutral', refresh: 'daily',
    source: 'fred', seriesId: 'DGS10',
  },
  {
    id: 'us10y_real', label: '10Y REAL YIELD', cluster: 'four_bodies',
    unit: '%', decimals: 2, direction: 'neutral', refresh: 'daily',
    source: 'fred', seriesId: 'DFII10',
    subIndex: 'four_bodies', subSign: 1,
  },
  {
    id: 'gold_oil', label: 'GOLD / OIL', cluster: 'four_bodies',
    unit: 'bbl/oz', decimals: 1, direction: 'neutral', refresh: 'daily',
    derive: { type: 'ratio', num: 'gold', den: 'wti' },
    subIndex: 'four_bodies', subSign: 1,
  },
  {
    id: 'corr_gold_real', label: 'GOLD:REAL10Y CORR', cluster: 'four_bodies',
    unit: '60d', decimals: 2, showPct: false, direction: 'neutral', refresh: 'daily',
    derive: { type: 'rolling_corr', a: 'gold', b: 'us10y_real', window: 60 },
    subIndex: 'four_bodies', subSign: 1,
  },
  {
    id: 'corr_wti_dxy', label: 'WTI:DXY CORR', cluster: 'four_bodies',
    unit: '60d', decimals: 2, showPct: false, direction: 'neutral', refresh: 'daily',
    staleAfterDays: 12, // can only be as fresh as DXY's weekly publication
    derive: { type: 'rolling_corr', a: 'wti', b: 'dxy', window: 60 },
    subIndex: 'four_bodies', subSign: 1,
  },

  // ═══ CREDIT STRESS ════════════════════════════════════════════════════
  {
    id: 'hy_oas', label: 'HY OAS', cluster: 'credit_stress',
    unit: '%', decimals: 2, direction: 'down_is_good', refresh: 'daily',
    source: 'fred', seriesId: 'BAMLH0A0HYM2',
    subIndex: 'credit_stress', subSign: 1,
  },
  {
    id: 'ccc_oas', label: 'CCC & LOWER OAS', cluster: 'credit_stress',
    unit: '%', decimals: 2, direction: 'down_is_good', refresh: 'daily',
    source: 'fred', seriesId: 'BAMLH0A3HYC',
    subIndex: 'credit_stress', subSign: 1,
  },
  {
    id: 'bb_oas', label: 'BB OAS', cluster: 'credit_stress',
    unit: '%', decimals: 2, direction: 'down_is_good', refresh: 'daily',
    source: 'fred', seriesId: 'BAMLH0A1HYBB',
  },
  {
    id: 'ig_oas', label: 'IG OAS', cluster: 'credit_stress',
    unit: '%', decimals: 2, direction: 'down_is_good', refresh: 'daily',
    source: 'fred', seriesId: 'BAMLC0A0CM',
    subIndex: 'credit_stress', subSign: 1,
  },
  {
    id: 'cre_delinq', label: 'CRE DELINQUENCY', cluster: 'credit_stress',
    unit: '%', decimals: 2, direction: 'down_is_good', refresh: 'daily',
    freq: 'quarterly', // slow series tiled honestly: observation date is prominent
    source: 'fred', seriesId: 'DRCRELEXFACBS',
  },
  {
    id: 'ci_delinq', label: 'C&I DELINQUENCY', cluster: 'credit_stress',
    unit: '%', decimals: 2, direction: 'down_is_good', refresh: 'daily',
    freq: 'quarterly',
    source: 'fred', seriesId: 'DRBLACBS',
  },
  {
    id: 'ccc_bb', label: 'CCC−BB LADDER', cluster: 'credit_stress',
    unit: '%', decimals: 2, direction: 'down_is_good', refresh: 'daily',
    derive: { type: 'combo', terms: [{ id: 'ccc_oas', coef: 1 }, { id: 'bb_oas', coef: -1 }] },
    subIndex: 'credit_stress', subSign: 1,
  },
  {
    id: 'hy_roc20', label: 'HY OAS 20D Δ', cluster: 'credit_stress',
    unit: 'bp', decimals: 0, showPct: false, direction: 'down_is_good', refresh: 'daily',
    derive: { type: 'roc', input: 'hy_oas', days: 28, scale: 100 }, // ~20 trading days, %→bp
    subIndex: 'credit_stress', subSign: 1, subWeight: 1.5, // velocity beats level
  },

  // ═══ FUNDING & LIQUIDITY ══════════════════════════════════════════════
  {
    id: 'walcl', label: 'FED BALANCE SHEET', cluster: 'funding',
    unit: '$tn', decimals: 2, direction: 'up_is_good', refresh: 'daily',
    freq: 'weekly',
    source: 'fred', seriesId: 'WALCL', fetchScale: 1e-6, // $mn → $tn
  },
  {
    id: 'tga', label: 'TREASURY TGA', cluster: 'funding',
    unit: '$bn', decimals: 0, direction: 'neutral', refresh: 'daily',
    freq: 'weekly',
    source: 'fred', seriesId: 'WTREGEN', fetchScale: 1e-3, // $mn → $bn
  },
  {
    id: 'rrp', label: 'REVERSE REPO', cluster: 'funding',
    unit: '$bn', decimals: 1, direction: 'neutral', refresh: 'daily',
    source: 'fred', seriesId: 'RRPONTSYD', // already $bn
  },
  {
    id: 'reserves', label: 'BANK RESERVES', cluster: 'funding',
    unit: '$tn', decimals: 2, direction: 'up_is_good', refresh: 'daily',
    freq: 'weekly',
    source: 'fred', seriesId: 'WRESBAL', fetchScale: 1e-6, // $mn → $tn
    subIndex: 'funding_liquidity', subSign: -1, // ample reserves = less stress
  },
  {
    id: 'sofr', label: 'SOFR', cluster: 'funding',
    unit: '%', decimals: 2, direction: 'neutral', refresh: 'daily',
    source: 'fred', seriesId: 'SOFR',
  },
  {
    id: 'iorb', label: 'IORB', cluster: 'funding',
    unit: '%', decimals: 2, direction: 'neutral', refresh: 'daily',
    source: 'fred', seriesId: 'IORB',
  },
  {
    // stored units: walcl $tn, tga $bn, rrp $bn — coefficients → $tn
    id: 'net_liq', label: 'NET LIQUIDITY', cluster: 'funding',
    unit: '$tn', decimals: 2, direction: 'up_is_good', refresh: 'daily',
    freq: 'weekly',
    derive: { type: 'combo', terms: [
      { id: 'walcl', coef: 1 }, { id: 'tga', coef: -1e-3 }, { id: 'rrp', coef: -1e-3 },
    ], ffillDays: 10 },
    subIndex: 'funding_liquidity', subSign: -1, // draining liquidity = stress
  },
  {
    id: 'sofr_iorb', label: 'SOFR − IORB', cluster: 'funding',
    unit: 'bp', decimals: 0, showPct: false, direction: 'down_is_good', refresh: 'daily',
    derive: { type: 'combo', terms: [{ id: 'sofr', coef: 100 }, { id: 'iorb', coef: -100 }] },
    subIndex: 'funding_liquidity', subSign: 1, // secured funding above IORB = tightening
  },
  {
    // Hunter's central claim, instrumented: credit stress rising while the
    // balance sheet doesn't respond. z(HY OAS) − z(4wk ΔWALCL).
    id: 'response_gap', label: 'THE RESPONSE GAP', cluster: 'funding',
    unit: 'z', decimals: 2, showPct: false, direction: 'down_is_good', refresh: 'daily',
    freq: 'weekly',
    derive: { type: 'response_gap', credit: 'hy_oas', balance: 'walcl', rocDays: 28 },
    subIndex: 'funding_liquidity', subSign: 1,
  },

  // ═══ SENTIMENT & POSITIONING ══════════════════════════════════════════
  // AAII's file endpoint and CBOE's stats API both hard-block non-browser
  // clients (verified), so per the no-stub rule: CNN's Fear & Greed stands
  // in for the survey read, and its put_call_options series carries the
  // real CBOE-derived put/call data. NAAIM comes from naaim.org directly.
  {
    id: 'fng', label: 'FEAR & GREED', cluster: 'sentiment',
    unit: '', decimals: 0, direction: 'neutral', refresh: 'daily',
    source: 'cnn', seriesId: 'fear_and_greed_historical',
    subIndex: 'sentiment_positioning', subSign: 1, // greed raises Altitude
  },
  {
    id: 'naaim', label: 'NAAIM EXPOSURE', cluster: 'sentiment',
    unit: '', decimals: 0, direction: 'neutral', refresh: 'daily',
    freq: 'weekly',
    source: 'naaim', seriesId: 'exposure',
    subIndex: 'sentiment_positioning', subSign: 1, // full managers = no dry powder
  },
  {
    id: 'put_call', label: 'EQUITY PUT/CALL', cluster: 'sentiment',
    unit: '', decimals: 2, direction: 'neutral', refresh: 'daily',
    source: 'cnn', seriesId: 'put_call_options',
    subIndex: 'sentiment_positioning', subSign: -1, // low P/C = complacency
  },
  {
    id: 'vix', label: 'VIX', cluster: 'sentiment',
    unit: '', decimals: 2, direction: 'down_is_good', refresh: 'daily',
    source: 'fred', seriesId: 'VIXCLS',
    subIndex: 'vol_structure', subSign: 1,
  },
  {
    id: 'vix3m', label: 'VIX 3M', cluster: 'sentiment',
    unit: '', decimals: 2, direction: 'down_is_good', refresh: 'daily',
    source: 'fred', seriesId: 'VXVCLS', // yahoo's ^VIX3M history has holes
    fallback: { source: 'yahoo', seriesId: '^VIX3M' },
  },
  {
    id: 'vix_term', label: 'VIX TERM 3M/1M', cluster: 'sentiment',
    unit: 'x', decimals: 2, showPct: false, direction: 'up_is_good', refresh: 'daily',
    derive: { type: 'ratio', num: 'vix3m', den: 'vix' },
    subIndex: 'vol_structure', subSign: -1, // contango = calm; inversion = storm
  },
  {
    // Hunter's stated top signal, adapted to available series: skeptics
    // converting fast. Mean percentile-rank of the 12-week rate of change
    // in NAAIM exposure and Fear & Greed. ≥90 on both = capitulation flag.
    id: 'capitulation', label: 'BEAR CAPITULATION', cluster: 'sentiment',
    unit: 'pct', decimals: 0, showPct: false, direction: 'down_is_good', refresh: 'daily',
    freq: 'weekly',
    derive: { type: 'capitulation', inputs: ['naaim', 'fng'], rocDays: 84 },
    subIndex: 'sentiment_positioning', subSign: 1,
  },

  // ═══ TREND, BREADTH & ROTATION ════════════════════════════════════════
  {
    id: 'spx', label: 'S&P 500', cluster: 'trend',
    unit: '', decimals: 0, direction: 'up_is_good', refresh: 'daily',
    source: 'yahoo', seriesId: '^GSPC',
  },
  {
    id: 'copper', label: 'COPPER', cluster: 'trend',
    unit: '$', unitPrefix: true, decimals: 2, direction: 'neutral', refresh: 'daily',
    source: 'yahoo', seriesId: 'HG=F',
  },
  {
    id: 'rsp_spy', label: 'EQUAL-WT / CAP-WT', cluster: 'trend',
    unit: 'x', decimals: 3, showPct: false, direction: 'neutral', refresh: 'daily',
    derive: { type: 'ratio', num: 'rsp', den: 'spy' },
  },
  {
    id: 'xlf_spy', label: 'XLF / SPY', cluster: 'trend',
    unit: 'x', decimals: 3, showPct: false, direction: 'neutral', refresh: 'daily',
    derive: { type: 'ratio', num: 'xlf', den: 'spy' },
  },
  {
    id: 'xlb_spy', label: 'XLB / SPY', cluster: 'trend',
    unit: 'x', decimals: 3, showPct: false, direction: 'neutral', refresh: 'daily',
    derive: { type: 'ratio', num: 'xlb', den: 'spy' },
  },
  {
    id: 'smh_spy', label: 'SMH / SPY', cluster: 'trend',
    unit: 'x', decimals: 3, showPct: false, direction: 'neutral', refresh: 'daily',
    derive: { type: 'ratio', num: 'smh', den: 'spy' },
    subIndex: 'breadth_rotation', subSign: 1, // semi concentration = fragility
  },
  {
    // "It's going parabolic", made falsifiable: % extension of the S&P
    // above its own 200-day moving average. Check it against 1999 and 2021.
    id: 'parabolicity', label: 'PARABOLICITY', cluster: 'trend',
    unit: '%>200D', decimals: 1, showPct: false, direction: 'neutral', refresh: 'daily',
    derive: { type: 'ma_extension', input: 'spx', maDays: 200 },
    subIndex: 'trend_extension', subSign: 1,
  },
  {
    // Hunter says leadership is broadening. If this is falling, it isn't,
    // and one of his premises is failing in real time.
    id: 'breadth_conf', label: 'BREADTH 63D Δ', cluster: 'trend',
    unit: '%', decimals: 2, showPct: false, direction: 'up_is_good', refresh: 'daily',
    derive: { type: 'roc', input: 'rsp_spy', days: 91, pct: true }, // ~63 trading days
    subIndex: 'breadth_rotation', subSign: -1, // broadening lowers fragility
  },
  {
    // Corporate equities market value over GDP — the slow, structural
    // valuation read for the Altitude gauge (quarterly by construction).
    id: 'eq_gdp', label: 'EQ MKT CAP / GDP', cluster: 'trend',
    unit: 'x', decimals: 2, showPct: false, direction: 'neutral', refresh: 'daily',
    freq: 'quarterly',
    derive: { type: 'combo', terms: [{ id: 'corp_eq', coef: 0.001 }, ], ffillDays: 0 },
    subIndex: 'leverage_valuation', subSign: 1,
  },

  // ═══ THESIS TRACKERS — Hunter forecast tracking, not market data ══════
  {
    id: 't_spx', label: 'S&P → 10,000', cluster: 'thesis',
    unit: '%', decimals: 1, showPct: false, direction: 'neutral', refresh: 'daily',
    derive: { type: 'target_distance', input: 'spx', target: 10000 },
  },
  {
    id: 't_ndx', label: 'NASDAQ → 36,000', cluster: 'thesis',
    unit: '%', decimals: 1, showPct: false, direction: 'neutral', refresh: 'daily',
    derive: { type: 'target_distance', input: 'nasdaq', target: 36000 },
  },
  {
    id: 't_dow', label: 'DOW → 70,000', cluster: 'thesis',
    unit: '%', decimals: 1, showPct: false, direction: 'neutral', refresh: 'daily',
    derive: { type: 'target_distance', input: 'dow', target: 70000 },
  },
  {
    id: 't_rut', label: 'RUSSELL → 4,000', cluster: 'thesis',
    unit: '%', decimals: 1, showPct: false, direction: 'neutral', refresh: 'daily',
    derive: { type: 'target_distance', input: 'rut', target: 4000 },
  },
  {
    id: 't_smh', label: 'SMH → 800', cluster: 'thesis',
    unit: '%', decimals: 1, showPct: false, direction: 'neutral', refresh: 'daily',
    derive: { type: 'target_distance', input: 'smh', target: 800 },
  },
  {
    id: 't_gold', label: 'GOLD → $7,000', cluster: 'thesis',
    unit: '%', decimals: 1, showPct: false, direction: 'neutral', refresh: 'daily',
    derive: { type: 'target_distance', input: 'gold', target: 7000 },
  },
  {
    id: 't_silver', label: 'SILVER → $200', cluster: 'thesis',
    unit: '%', decimals: 1, showPct: false, direction: 'neutral', refresh: 'daily',
    derive: { type: 'target_distance', input: 'silver', target: 200 },
  },
  {
    id: 't_gdx', label: 'GDX → 180', cluster: 'thesis',
    unit: '%', decimals: 1, showPct: false, direction: 'neutral', refresh: 'daily',
    derive: { type: 'target_distance', input: 'gdx', target: 180 },
  },
  {
    id: 't_oil', label: 'OIL → $60 (→$30)', cluster: 'thesis',
    unit: '%', decimals: 1, showPct: false, direction: 'neutral', refresh: 'daily',
    derive: { type: 'target_distance', input: 'wti', target: 60 },
  },
  {
    id: 't_10y', label: '10Y → 3.00%', cluster: 'thesis',
    unit: '%', decimals: 1, showPct: false, direction: 'neutral', refresh: 'daily',
    derive: { type: 'target_distance', input: 'us10y', target: 3 },
    deadline: '2027-02-07', // "within six months" of the Phase 2 brief date
  },
  {
    // % of the way from the Oct 2022 low (3491.58) to the 10,000 target.
    id: 'meltup', label: 'MELT-UP COMPLETION', cluster: 'thesis',
    unit: '%', decimals: 1, showPct: false, direction: 'neutral', refresh: 'daily',
    derive: { type: 'completion', input: 'spx', base: 3491.58, target: 10000 },
  },
  {
    // Named, dated, falsifiable: right shoulder ~110 vs prior top ~116.
    id: 'igv', label: 'IGV vs H&S 110/116', cluster: 'thesis',
    unit: '$', unitPrefix: true, decimals: 2, direction: 'neutral', refresh: 'daily',
    source: 'yahoo', seriesId: 'IGV',
    flagLevels: { shoulder: 110, top: 116 },
  },

  // ═══ hidden underlying series (feed derived tiles, never tiled) ═══════
  { id: 'spy', label: 'SPY', cluster: 'trend', unit: '$', decimals: 2, direction: 'neutral',
    refresh: 'daily', hidden: true, source: 'yahoo', seriesId: 'SPY' },
  { id: 'rsp', label: 'RSP', cluster: 'trend', unit: '$', decimals: 2, direction: 'neutral',
    refresh: 'daily', hidden: true, source: 'yahoo', seriesId: 'RSP' },
  { id: 'xlf', label: 'XLF', cluster: 'trend', unit: '$', decimals: 2, direction: 'neutral',
    refresh: 'daily', hidden: true, source: 'yahoo', seriesId: 'XLF' },
  { id: 'xlb', label: 'XLB', cluster: 'trend', unit: '$', decimals: 2, direction: 'neutral',
    refresh: 'daily', hidden: true, source: 'yahoo', seriesId: 'XLB' },
  { id: 'smh', label: 'SMH', cluster: 'trend', unit: '$', decimals: 2, direction: 'neutral',
    refresh: 'daily', hidden: true, source: 'yahoo', seriesId: 'SMH' },
  { id: 'nasdaq', label: 'NASDAQ COMPOSITE', cluster: 'thesis', unit: '', decimals: 0, direction: 'neutral',
    refresh: 'daily', hidden: true, source: 'yahoo', seriesId: '^IXIC' },
  { id: 'dow', label: 'DOW', cluster: 'thesis', unit: '', decimals: 0, direction: 'neutral',
    refresh: 'daily', hidden: true, source: 'yahoo', seriesId: '^DJI' },
  { id: 'rut', label: 'RUSSELL 2000', cluster: 'thesis', unit: '', decimals: 0, direction: 'neutral',
    refresh: 'daily', hidden: true, source: 'yahoo', seriesId: '^RUT' },
  { id: 'silver', label: 'SILVER', cluster: 'thesis', unit: '$', decimals: 2, direction: 'neutral',
    refresh: 'daily', hidden: true, source: 'yahoo', seriesId: 'SI=F' },
  { id: 'gdx', label: 'GDX', cluster: 'thesis', unit: '$', decimals: 2, direction: 'neutral',
    refresh: 'daily', hidden: true, source: 'yahoo', seriesId: 'GDX' },
  { id: 'corp_eq', label: 'CORP EQUITIES / GDP RAW', cluster: 'trend', unit: '', decimals: 2,
    direction: 'neutral', refresh: 'daily', freq: 'quarterly', hidden: true,
    // NCBEILQ027S is $mn of corporate equities; GDP is $bn — the eq_gdp
    // combo folds the 1e3 into its coefficient after this ratio.
    derive: { type: 'ratio', num: 'corp_eq_lvl', den: 'gdp' } },
  { id: 'corp_eq_lvl', label: 'NCBEILQ027S', cluster: 'trend', unit: '', decimals: 0,
    direction: 'neutral', refresh: 'daily', freq: 'quarterly', hidden: true,
    source: 'fred', seriesId: 'NCBEILQ027S' },
  { id: 'gdp', label: 'GDP', cluster: 'trend', unit: '', decimals: 0,
    direction: 'neutral', refresh: 'daily', freq: 'quarterly', hidden: true,
    source: 'fred', seriesId: 'GDP' },
];

export const kpiById = new Map(KPIS.map((k) => [k.id, k]));

/** Default staleness allowance (days) by native frequency. */
export function defaultStaleDays(def: KpiDef): number {
  if (def.staleAfterDays !== undefined) return def.staleAfterDays;
  switch (def.freq ?? 'daily') {
    case 'weekly': return 16;
    case 'monthly': return 45;
    // dated at quarter START and published ~2 months after quarter end:
    // the newest observation is legitimately up to ~8 months "old"
    case 'quarterly': return 240;
    default: return def.refresh === 'intraday' ? 4 : 6;
  }
}
