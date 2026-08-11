// THE JOE MADIGAN FINANCIAL CONDITIONS BAROMETER — KPI registry.
// This file is the single source of truth. Adding a KPI = adding ONE
// object to KPIS below. Nothing else.
//
//  - fetched KPI:  set `source` + `seriesId`
//  - derived KPI:  set `derive` (computed in the cron job from other series)
//  - hidden KPI:   fetched/stored but not tiled (feeds derived tiles)
//
// COLOUR SEMANTICS (Phase 3): tile colour IS the tile's contribution to
// THE BAROMETER. `stressSign: +1` means a RISING value pushes the system
// toward storm (red on up-moves); `-1` the reverse. The frame is SYSTEMIC
// CONDITIONS, not portfolio P&L — green means the financial system is in
// better shape, never "your book is up". Every judgement is written down
// in `signRationale` at the point it was made. Moves inside the deadband
// (0.1 σ of the series' own daily move) render neutral grey.
//
// THE BAROMETER membership: `subIndex` names the sub-index this KPI feeds
// (see registry/signal.ts for layer weights); `subSign` is +1 when a HIGH
// value raises that sub-index's named quantity (stress for Pressure subs,
// altitude for Altitude subs).

export type SourceId = 'fred' | 'stooq' | 'yahoo' | 'cnn' | 'naaim' | 'damodaran';
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
  | { type: 'capitulation'; inputs: string[]; rocDays: number }
  /** First-order attribution of the change in a cash-yield ERP proxy to
   *  one of its three drivers. ERP_proxy = CF/Index + g − rf, so:
   *   index      = CF(t-1)/Index(t) − CF(t-1)/Index(t-1)
   *   cashflow   = CF(t)/Index(t)   − CF(t-1)/Index(t)
   *   riskfree   = −(rf(t) − rf(t-1))
   *  A falling ERP because the index rallied is froth; a falling ERP
   *  because the risk-free rate rose is a repricing. Not the same thing. */
  | { type: 'erp_attrib'; index: string; cashflow: string; riskfree: string;
      leg: 'index' | 'cashflow' | 'riskfree' };

export interface KpiDef {
  id: string;
  label: string;
  cluster: string;
  unit: string;            // display suffix: '%', '$', 'x', 'z', 'bp' …
  unitPrefix?: boolean;    // true → unit renders before the number ('$85.20')
  decimals: number;
  /** false → hide %-change (meaningless for correlations, spreads at zero…) */
  showPct?: boolean;
  /** +1: rising value pushes the system toward storm (up-moves red).
   *  -1: rising value is benign (up-moves green). Hidden KPIs may omit. */
  stressSign?: 1 | -1;
  /** One line, written when the sign was decided, surfaced on hover. */
  signRationale?: string;
  refresh: 'daily' | 'intraday';
  /** native publication frequency — drives staleness defaults and z-score
   *  window scaling. Default 'daily'. */
  freq?: Freq;
  /** Observations older than this many days ⇒ tile shows STALE. Defaults
   *  are per-frequency (daily ~6d, weekly ~16d, monthly ~45d, qtrly ~240d). */
  staleAfterDays?: number;
  /** true → fetched and stored but never tiled (feeds derived KPIs). */
  hidden?: boolean;
  source?: SourceId;
  seriesId?: string;
  /** Minimum days between fetches for this series. Set for slow-moving
   *  sources on someone else's personal server — be a good citizen. */
  fetchIntervalDays?: number;
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
  { id: 'valuation', label: 'VALUATION — IMPLIED EQUITY RISK PREMIUM',
    attribution: 'DATA: ASWATH DAMODARAN, NYU STERN · MONTHLY' },
  { id: 'thesis', label: 'THESIS TRACKERS — HUNTER TARGETS',
    attribution: 'TRACKING DAVID HUNTER FORECASTS · NOT MARKET DATA' },
];

/** Dated forecasts with stated horizons, for the thesis-decay tile.
 *  Elapsed time against a stated horizon is a fact, not a criticism — and
 *  it is exactly the fact a confirmation machine would never surface. */
export interface ThesisForecast {
  label: string;
  statedOn: string;     // when the call was made
  horizonMonths: number;
  claim: string;
}
export const THESIS_FORECASTS: ThesisForecast[] = [
  { label: 'MELT-UP TO S&P 10,000', statedOn: '2026-02-07', horizonMonths: 12,
    claim: 'Parabolic melt-up completing before the global bust.' },
  { label: 'GLOBAL BUST BEGINS', statedOn: '2026-02-07', horizonMonths: 12,
    claim: 'Bust follows the melt-up peak.' },
  { label: '10Y TO 3.00%', statedOn: '2026-08-07', horizonMonths: 6,
    claim: 'Long yields fall to 3% as growth rolls over.' },
];

/** Deep backfill: credit/sentiment need to have seen 2008 and 2020 for the
 *  backtest to mean anything. Sources cap their own depth. */
export const BACKFILL_START = '2000-01-01';

export const KPIS: KpiDef[] = [
  // ═══ THE FOUR BODIES ══════════════════════════════════════════════════
  {
    id: 'wti', label: 'WTI CRUDE', cluster: 'four_bodies',
    unit: '$', unitPrefix: true, decimals: 2, refresh: 'daily',
    stressSign: -1,
    signRationale: 'Falling oil relieves inflation but signals demand destruction — the sign here reads it as a demand signal.',
    source: 'fred', seriesId: 'DCOILWTICO',
  },
  {
    id: 'gold', label: 'GOLD', cluster: 'four_bodies',
    unit: '$', unitPrefix: true, decimals: 0, refresh: 'intraday',
    stressSign: 1,
    signRationale: 'A gold bid is usually fear — safe-haven demand rising, not prosperity.',
    source: 'stooq', seriesId: 'xauusd',
    fallback: { source: 'yahoo', seriesId: 'GC=F' },
  },
  {
    id: 'dxy', label: 'USD INDEX (BROAD)', cluster: 'four_bodies',
    unit: '', decimals: 2, refresh: 'daily',
    stressSign: 1,
    signRationale: 'Broad-dollar spikes are global funding stress — the dollar is the world’s margin call.',
    staleAfterDays: 12, // FRED publishes DTWEXBGS weekly, ~1 week in arrears
    source: 'fred', seriesId: 'DTWEXBGS',
    subIndex: 'four_bodies', subSign: 1,
  },
  {
    id: 'us10y', label: '10Y TREASURY', cluster: 'four_bodies',
    unit: '%', decimals: 2, refresh: 'daily',
    stressSign: 1,
    signRationale: 'Rising long yields tighten financial conditions and pressure every duration-sensitive asset.',
    source: 'fred', seriesId: 'DGS10',
  },
  {
    id: 'us10y_real', label: '10Y REAL YIELD', cluster: 'four_bodies',
    unit: '%', decimals: 2, refresh: 'daily',
    stressSign: 1,
    signRationale: 'Fast real-yield rises are the actual tightening mechanism — they reprice everything.',
    source: 'fred', seriesId: 'DFII10',
    subIndex: 'four_bodies', subSign: 1,
  },
  {
    id: 'gold_oil', label: 'GOLD / OIL', cluster: 'four_bodies',
    unit: 'bbl/oz', decimals: 1, refresh: 'daily',
    stressSign: 1,
    signRationale: 'Ounces-per-barrel spikes when oil collapses or gold bids — a classic recession tell.',
    derive: { type: 'ratio', num: 'gold', den: 'wti' },
    subIndex: 'four_bodies', subSign: 1,
  },
  {
    id: 'corr_gold_real', label: 'GOLD:REAL10Y CORR', cluster: 'four_bodies',
    unit: '60d', decimals: 2, showPct: false, refresh: 'daily',
    stressSign: 1,
    signRationale: 'Normally strongly negative; the sign fires on the break toward positive — the deviation is the signal, not the level.',
    derive: { type: 'rolling_corr', a: 'gold', b: 'us10y_real', window: 60 },
    subIndex: 'four_bodies', subSign: 1,
  },
  {
    id: 'corr_wti_dxy', label: 'WTI:DXY CORR', cluster: 'four_bodies',
    unit: '60d', decimals: 2, showPct: false, refresh: 'daily',
    stressSign: 1,
    signRationale: 'Normally negative; co-movement toward positive signals a common macro shock.',
    staleAfterDays: 12, // can only be as fresh as DXY's weekly publication
    derive: { type: 'rolling_corr', a: 'wti', b: 'dxy', window: 60 },
    subIndex: 'four_bodies', subSign: 1,
  },

  // ═══ CREDIT STRESS ════════════════════════════════════════════════════
  {
    id: 'hy_oas', label: 'HY OAS', cluster: 'credit_stress',
    unit: '%', decimals: 2, refresh: 'daily',
    stressSign: 1,
    signRationale: 'Widening high-yield spreads are the front line of credit stress.',
    source: 'fred', seriesId: 'BAMLH0A0HYM2',
    subIndex: 'credit_stress', subSign: 1,
  },
  {
    id: 'ccc_oas', label: 'CCC & LOWER OAS', cluster: 'credit_stress',
    unit: '%', decimals: 2, refresh: 'daily',
    stressSign: 1,
    signRationale: 'The bottom rung breaks first — CCC widening leads the cycle.',
    source: 'fred', seriesId: 'BAMLH0A3HYC',
    subIndex: 'credit_stress', subSign: 1,
  },
  {
    id: 'bb_oas', label: 'BB OAS', cluster: 'credit_stress',
    unit: '%', decimals: 2, refresh: 'daily',
    stressSign: 1,
    signRationale: 'Quality high-yield — widening here means stress is climbing the ladder.',
    source: 'fred', seriesId: 'BAMLH0A1HYBB',
  },
  {
    id: 'ig_oas', label: 'IG OAS', cluster: 'credit_stress',
    unit: '%', decimals: 2, refresh: 'daily',
    stressSign: 1,
    signRationale: 'Investment-grade widening means the stress is systemic, not speculative.',
    source: 'fred', seriesId: 'BAMLC0A0CM',
    subIndex: 'credit_stress', subSign: 1,
  },
  {
    id: 'cre_delinq', label: 'CRE DELINQUENCY', cluster: 'credit_stress',
    unit: '%', decimals: 2, refresh: 'daily',
    stressSign: 1,
    signRationale: 'Commercial real estate delinquency is where the leverage thesis says the bust surfaces first.',
    freq: 'quarterly', // slow series tiled honestly: observation date is prominent
    source: 'fred', seriesId: 'DRCRELEXFACBS',
  },
  {
    id: 'ci_delinq', label: 'C&I DELINQUENCY', cluster: 'credit_stress',
    unit: '%', decimals: 2, refresh: 'daily',
    stressSign: 1,
    signRationale: 'Business-loan delinquency rising = the real economy failing to service debt.',
    freq: 'quarterly',
    source: 'fred', seriesId: 'DRBLACBS',
  },
  {
    id: 'ccc_bb', label: 'CCC−BB LADDER', cluster: 'credit_stress',
    unit: '%', decimals: 2, refresh: 'daily',
    stressSign: 1,
    signRationale: 'The quality ladder: sudden widening at the bottom rung is where credit cycles break.',
    derive: { type: 'combo', terms: [{ id: 'ccc_oas', coef: 1 }, { id: 'bb_oas', coef: -1 }] },
    subIndex: 'credit_stress', subSign: 1,
  },
  {
    id: 'hy_roc20', label: 'HY OAS 20D Δ', cluster: 'credit_stress',
    unit: 'bp', decimals: 0, showPct: false, refresh: 'daily',
    stressSign: 1,
    signRationale: 'The velocity of widening matters more than the level — 40bp in a fortnight is a different world from a drift.',
    derive: { type: 'roc', input: 'hy_oas', days: 28, scale: 100 }, // ~20 trading days, %→bp
    subIndex: 'credit_stress', subSign: 1, subWeight: 1.5, // velocity beats level
  },

  // ═══ FUNDING & LIQUIDITY ══════════════════════════════════════════════
  {
    id: 'walcl', label: 'FED BALANCE SHEET', cluster: 'funding',
    unit: '$tn', decimals: 2, refresh: 'daily',
    stressSign: -1,
    signRationale: 'Balance-sheet expansion is liquidity support; shrinkage drains the system.',
    freq: 'weekly',
    source: 'fred', seriesId: 'WALCL', fetchScale: 1e-6, // $mn → $tn
  },
  {
    id: 'tga', label: 'TREASURY TGA', cluster: 'funding',
    unit: '$bn', decimals: 0, refresh: 'daily',
    stressSign: 1,
    signRationale: 'A rising TGA pulls cash out of the banking system — a stealth drain.',
    freq: 'weekly',
    source: 'fred', seriesId: 'WTREGEN', fetchScale: 1e-3, // $mn → $bn
  },
  {
    id: 'rrp', label: 'REVERSE REPO', cluster: 'funding',
    unit: '$bn', decimals: 1, refresh: 'daily',
    stressSign: 1,
    signRationale: 'Cash parked at the Fed is liquidity withdrawn from markets.',
    source: 'fred', seriesId: 'RRPONTSYD', // already $bn
  },
  {
    id: 'reserves', label: 'BANK RESERVES', cluster: 'funding',
    unit: '$tn', decimals: 2, refresh: 'daily',
    stressSign: -1,
    signRationale: 'Ample reserves are the buffer between a leverage unwind and a funding crisis.',
    freq: 'weekly',
    source: 'fred', seriesId: 'WRESBAL', fetchScale: 1e-6, // $mn → $tn
    subIndex: 'funding_liquidity', subSign: -1, // ample reserves = less stress
  },
  {
    id: 'sofr', label: 'SOFR', cluster: 'funding',
    unit: '%', decimals: 2, refresh: 'daily',
    stressSign: 1,
    signRationale: 'Rising secured funding costs tighten every levered book simultaneously.',
    source: 'fred', seriesId: 'SOFR',
  },
  {
    id: 'iorb', label: 'IORB', cluster: 'funding',
    unit: '%', decimals: 2, refresh: 'daily',
    stressSign: 1,
    signRationale: 'The policy floor — higher means tighter, mechanically.',
    source: 'fred', seriesId: 'IORB',
  },
  {
    // stored units: walcl $tn, tga $bn, rrp $bn — coefficients → $tn
    id: 'net_liq', label: 'NET LIQUIDITY', cluster: 'funding',
    unit: '$tn', decimals: 2, refresh: 'daily',
    stressSign: -1,
    signRationale: 'The most-watched liquidity proxy: draining net liquidity starves risk assets.',
    freq: 'weekly',
    derive: { type: 'combo', terms: [
      { id: 'walcl', coef: 1 }, { id: 'tga', coef: -1e-3 }, { id: 'rrp', coef: -1e-3 },
    ], ffillDays: 10 },
    subIndex: 'funding_liquidity', subSign: -1, // draining liquidity = stress
  },
  {
    id: 'sofr_iorb', label: 'SOFR − IORB', cluster: 'funding',
    unit: 'bp', decimals: 0, showPct: false, refresh: 'daily',
    stressSign: 1,
    signRationale: 'Secured funding persistently above the Fed floor = the plumbing is tightening. Unwinds surface here first.',
    derive: { type: 'combo', terms: [{ id: 'sofr', coef: 100 }, { id: 'iorb', coef: -100 }] },
    subIndex: 'funding_liquidity', subSign: 1, // secured funding above IORB = tightening
  },
  {
    // Hunter's central claim, instrumented: credit stress rising while the
    // balance sheet doesn't respond. z(HY OAS) − z(4wk ΔWALCL).
    id: 'response_gap', label: 'THE RESPONSE GAP', cluster: 'funding',
    unit: 'z', decimals: 2, showPct: false, refresh: 'daily',
    stressSign: 1,
    signRationale: 'Credit stress rising while the Fed doesn’t respond — the gap Hunter says gets unusually wide before capitulation.',
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
    unit: '', decimals: 0, refresh: 'daily',
    stressSign: 1,
    signRationale: 'Rising greed is rising altitude — complacency is the input, not the all-clear.',
    source: 'cnn', seriesId: 'fear_and_greed_historical',
    subIndex: 'sentiment_positioning', subSign: 1, // greed raises Altitude
  },
  {
    id: 'naaim', label: 'NAAIM EXPOSURE', cluster: 'sentiment',
    unit: '', decimals: 0, refresh: 'daily',
    stressSign: 1,
    signRationale: 'Fully-invested managers means no dry powder — positioning stretch, not conviction to borrow.',
    freq: 'weekly',
    source: 'naaim', seriesId: 'exposure',
    subIndex: 'sentiment_positioning', subSign: 1, // full managers = no dry powder
  },
  {
    id: 'put_call', label: 'EQUITY PUT/CALL', cluster: 'sentiment',
    unit: '', decimals: 2, refresh: 'daily',
    stressSign: -1,
    signRationale: 'A falling put/call is hedges coming off — complacency rising, protection thinning.',
    source: 'cnn', seriesId: 'put_call_options',
    subIndex: 'sentiment_positioning', subSign: -1, // low P/C = complacency
  },
  {
    id: 'vix', label: 'VIX', cluster: 'sentiment',
    unit: '', decimals: 2, refresh: 'daily',
    stressSign: 1,
    signRationale: 'Spiking vol is stress arriving now — coincident, not leading, but unambiguous.',
    source: 'fred', seriesId: 'VIXCLS',
    subIndex: 'vol_structure', subSign: 1,
  },
  {
    id: 'vix3m', label: 'VIX 3M', cluster: 'sentiment',
    unit: '', decimals: 2, refresh: 'daily',
    stressSign: 1,
    signRationale: 'The 3-month vol expectation — rising means the market prices sustained turbulence.',
    source: 'fred', seriesId: 'VXVCLS', // yahoo's ^VIX3M history has holes
    fallback: { source: 'yahoo', seriesId: '^VIX3M' },
  },
  {
    id: 'vix_term', label: 'VIX TERM 3M/1M', cluster: 'sentiment',
    unit: 'x', decimals: 2, showPct: false, refresh: 'daily',
    stressSign: -1,
    signRationale: 'Contango is calm; the slide toward inversion is the early warning — spot VIX is merely coincident.',
    derive: { type: 'ratio', num: 'vix3m', den: 'vix' },
    subIndex: 'vol_structure', subSign: -1, // contango = calm; inversion = storm
  },
  {
    // Hunter's stated top signal, adapted to available series: skeptics
    // converting fast. Mean percentile-rank of the 12-week rate of change
    // in NAAIM exposure and Fear & Greed. ≥90 on both = capitulation flag.
    id: 'capitulation', label: 'BEAR CAPITULATION', cluster: 'sentiment',
    unit: 'pct', decimals: 0, showPct: false, refresh: 'daily',
    stressSign: 1,
    signRationale: 'Skeptics converting into a united bullish front is Hunter’s stated top signal.',
    freq: 'weekly',
    derive: { type: 'capitulation', inputs: ['naaim', 'fng'], rocDays: 84 },
    subIndex: 'sentiment_positioning', subSign: 1,
  },

  // ═══ TREND, BREADTH & ROTATION ════════════════════════════════════════
  {
    id: 'spx', label: 'S&P 500', cluster: 'trend',
    unit: '', decimals: 0, refresh: 'daily',
    stressSign: 1,
    signRationale: 'Systemic frame, not P&L: every leg higher deepens extension, valuation and positioning stretch. Drawdowns reduce it.',
    source: 'yahoo', seriesId: '^GSPC',
  },
  {
    id: 'copper', label: 'COPPER', cluster: 'trend',
    unit: '$', unitPrefix: true, decimals: 2, refresh: 'daily',
    stressSign: -1,
    signRationale: 'Read as a demand signal: falling copper is the real economy rolling over.',
    source: 'yahoo', seriesId: 'HG=F',
  },
  {
    id: 'rsp_spy', label: 'EQUAL-WT / CAP-WT', cluster: 'trend',
    unit: 'x', decimals: 3, showPct: false, refresh: 'daily',
    stressSign: -1,
    signRationale: 'Falling means leadership narrowing to a handful of names — fragile structure.',
    derive: { type: 'ratio', num: 'rsp', den: 'spy' },
  },
  {
    id: 'xlf_spy', label: 'XLF / SPY', cluster: 'trend',
    unit: 'x', decimals: 3, showPct: false, refresh: 'daily',
    stressSign: -1,
    signRationale: 'Financials leading is the broadening Hunter’s melt-up requires; fading is the premise failing.',
    derive: { type: 'ratio', num: 'xlf', den: 'spy' },
  },
  {
    id: 'xlb_spy', label: 'XLB / SPY', cluster: 'trend',
    unit: 'x', decimals: 3, showPct: false, refresh: 'daily',
    stressSign: -1,
    signRationale: 'Materials participation = broadening; fading = concentration.',
    derive: { type: 'ratio', num: 'xlb', den: 'spy' },
  },
  {
    id: 'smh_spy', label: 'SMH / SPY', cluster: 'trend',
    unit: 'x', decimals: 3, showPct: false, refresh: 'daily',
    stressSign: 1,
    signRationale: 'Semis outperformance is the concentration/AI-payoff risk compounding.',
    derive: { type: 'ratio', num: 'smh', den: 'spy' },
    subIndex: 'breadth_rotation', subSign: 1, // semi concentration = fragility
  },
  {
    // "It's going parabolic", made falsifiable: % extension of the S&P
    // above its own 200-day moving average. Check it against 1999 and 2021.
    id: 'parabolicity', label: 'PARABOLICITY', cluster: 'trend',
    unit: '%>200D', decimals: 1, showPct: false, refresh: 'daily',
    stressSign: 1,
    signRationale: 'Steepening extension above trend is altitude accruing — the shape of every late-stage melt-up.',
    derive: { type: 'ma_extension', input: 'spx', maDays: 200 },
    subIndex: 'trend_extension', subSign: 1,
  },
  {
    // Hunter says leadership is broadening. If this is falling, it isn't,
    // and one of his premises is failing in real time.
    id: 'breadth_conf', label: 'BREADTH 63D Δ', cluster: 'trend',
    unit: '%', decimals: 2, showPct: false, refresh: 'daily',
    stressSign: -1,
    signRationale: 'Broadening participation is structurally healthier than narrow leadership.',
    derive: { type: 'roc', input: 'rsp_spy', days: 91, pct: true }, // ~63 trading days
    subIndex: 'breadth_rotation', subSign: -1, // broadening lowers fragility
  },
  {
    // Corporate equities market value over GDP — the slow, structural
    // valuation read for the Altitude gauge (quarterly by construction).
    id: 'eq_gdp', label: 'EQ MKT CAP / GDP', cluster: 'trend',
    unit: 'x', decimals: 2, showPct: false, refresh: 'daily',
    stressSign: 1,
    signRationale: 'Valuation stretch is stored drawdown — the higher this sits, the further there is to fall.',
    freq: 'quarterly',
    derive: { type: 'combo', terms: [{ id: 'corp_eq', coef: 0.001 }], ffillDays: 0 },
    subIndex: 'leverage_valuation', subSign: 1,
  },

  // ═══ VALUATION — implied ERP (Aswath Damodaran, NYU Stern) ═══════════
  // The corrective input. Every other voice on this wall is bearish and
  // their indicators were chosen because they support that thesis. This
  // one is forward-looking, cash-flow-based and immune to sentiment — the
  // input most likely to DISAGREE with the rest of the board, which is
  // precisely its value. Monthly cadence; the observation date is
  // prominent on the tile and it must never read as though it ticked today.
  {
    id: 'erp', label: 'IMPLIED ERP', cluster: 'valuation',
    unit: '%', decimals: 2, refresh: 'daily', freq: 'monthly',
    stressSign: -1,
    signRationale: 'Reads backwards to most people: a FALLING ERP means investors demand less compensation for equity risk — richer pricing, thinner cushion — so falling ERP raises Altitude. Rising ERP is a fatter cushion.',
    source: 'damodaran', seriesId: 'erp', fetchIntervalDays: 20,
    subIndex: 'valuation', subSign: -1, subWeight: 2,
  },
  {
    id: 'erp_norm', label: 'IMPLIED ERP (NORM)', cluster: 'valuation',
    unit: '%', decimals: 2, refresh: 'daily', freq: 'monthly',
    stressSign: -1,
    signRationale: 'Damodaran’s more conservative variant, on normalized earnings and payout. Diverges meaningfully from the headline — when it does, the gap is the story.',
    source: 'damodaran', seriesId: 'erp_norm', fetchIntervalDays: 20,
    subIndex: 'valuation', subSign: -1,
  },
  {
    id: 'erp_rf', label: 'RISK-FREE USED', cluster: 'valuation',
    unit: '%', decimals: 2, refresh: 'daily', freq: 'monthly',
    stressSign: 1,
    signRationale: 'The treasury rate underlying that month’s ERP solve — published alongside it so the number stays traceable to its assumptions.',
    source: 'damodaran', seriesId: 'erp_rf', fetchIntervalDays: 20,
  },
  {
    id: 'erp_expret', label: 'EXPECTED EQUITY RETURN', cluster: 'valuation',
    unit: '%', decimals: 2, refresh: 'daily', freq: 'monthly',
    stressSign: -1,
    signRationale: 'ERP + risk-free: the total nominal return the market is priced to deliver. The single most useful number for a long-horizon allocator, and low is bad.',
    derive: { type: 'combo', terms: [{ id: 'erp', coef: 1 }, { id: 'erp_rf', coef: 1 }], ffillDays: 40 },
  },
  {
    id: 'erp_d_index', label: 'ΔERP FROM INDEX', cluster: 'valuation',
    unit: 'pp', decimals: 3, showPct: false, refresh: 'daily', freq: 'monthly',
    stressSign: -1,
    signRationale: 'The part of the ERP change explained by the index moving. Negative means the market rallied into a thinner cushion — late-cycle froth rather than a repricing.',
    derive: { type: 'erp_attrib', index: 'erp_spx', cashflow: 'erp_cf', riskfree: 'erp_rf', leg: 'index' },
  },
  {
    id: 'erp_d_cf', label: 'ΔERP FROM CASHFLOW', cluster: 'valuation',
    unit: 'pp', decimals: 3, showPct: false, refresh: 'daily', freq: 'monthly',
    stressSign: -1,
    signRationale: 'The part explained by expected cash flows changing. Falling cash flows thin the cushion for a fundamentally different reason than a price rally does.',
    derive: { type: 'erp_attrib', index: 'erp_spx', cashflow: 'erp_cf', riskfree: 'erp_rf', leg: 'cashflow' },
  },
  {
    id: 'erp_d_rf', label: 'ΔERP FROM RATES', cluster: 'valuation',
    unit: 'pp', decimals: 3, showPct: false, refresh: 'daily', freq: 'monthly',
    stressSign: -1,
    signRationale: 'The part explained by the risk-free rate moving. An ERP falling because rates rose while equities held is arguably a repricing, not a bubble — the composite must not treat the two identically.',
    derive: { type: 'erp_attrib', index: 'erp_spx', cashflow: 'erp_cf', riskfree: 'erp_rf', leg: 'riskfree' },
  },

  // ═══ THESIS TRACKERS — Hunter forecast tracking, not market data ══════
  // Distance-to-target tiles move OPPOSITE their underlying (target fixed),
  // so each carries the inverted sign of its underlying instrument.
  {
    id: 't_spx', label: 'S&P → 10,000', cluster: 'thesis',
    unit: '%', decimals: 1, showPct: false, refresh: 'daily',
    stressSign: -1,
    signRationale: 'Distance shrinking = the melt-up advancing = altitude accruing (inverts the S&P sign).',
    derive: { type: 'target_distance', input: 'spx', target: 10000 },
  },
  {
    id: 't_ndx', label: 'NASDAQ → 36,000', cluster: 'thesis',
    unit: '%', decimals: 1, showPct: false, refresh: 'daily',
    stressSign: -1,
    signRationale: 'Distance shrinking = the melt-up advancing (inverts the index sign).',
    derive: { type: 'target_distance', input: 'nasdaq', target: 36000 },
  },
  {
    id: 't_dow', label: 'DOW → 70,000', cluster: 'thesis',
    unit: '%', decimals: 1, showPct: false, refresh: 'daily',
    stressSign: -1,
    signRationale: 'Distance shrinking = the melt-up advancing (inverts the index sign).',
    derive: { type: 'target_distance', input: 'dow', target: 70000 },
  },
  {
    id: 't_rut', label: 'RUSSELL → 4,000', cluster: 'thesis',
    unit: '%', decimals: 1, showPct: false, refresh: 'daily',
    stressSign: -1,
    signRationale: 'Distance shrinking = the melt-up advancing (inverts the index sign).',
    derive: { type: 'target_distance', input: 'rut', target: 4000 },
  },
  {
    id: 't_smh', label: 'SMH → 800', cluster: 'thesis',
    unit: '%', decimals: 1, showPct: false, refresh: 'daily',
    stressSign: -1,
    signRationale: 'Distance shrinking = semis melt-up advancing (inverts the SMH sign).',
    derive: { type: 'target_distance', input: 'smh', target: 800 },
  },
  {
    id: 't_gold', label: 'GOLD → $7,000', cluster: 'thesis',
    unit: '%', decimals: 1, showPct: false, refresh: 'daily',
    stressSign: -1,
    signRationale: 'Approaching a $7,000 gold target means the fear bid is winning (inverts the gold sign).',
    derive: { type: 'target_distance', input: 'gold', target: 7000 },
  },
  {
    id: 't_silver', label: 'SILVER → $200', cluster: 'thesis',
    unit: '%', decimals: 1, showPct: false, refresh: 'daily',
    stressSign: -1,
    signRationale: 'Monetary-metal mania approaching target = systemic anxiety rising (inverts the silver sign).',
    derive: { type: 'target_distance', input: 'silver', target: 200 },
  },
  {
    id: 't_gdx', label: 'GDX → 180', cluster: 'thesis',
    unit: '%', decimals: 1, showPct: false, refresh: 'daily',
    stressSign: -1,
    signRationale: 'Gold-miner mania approaching target = the fear trade compounding (inverts the GDX sign).',
    derive: { type: 'target_distance', input: 'gdx', target: 180 },
  },
  {
    id: 't_oil', label: 'OIL → $60 (→$30)', cluster: 'thesis',
    unit: '%', decimals: 1, showPct: false, refresh: 'daily',
    stressSign: 1,
    signRationale: 'This distance grows as oil falls — approach means demand destruction (inverts the WTI sign).',
    derive: { type: 'target_distance', input: 'wti', target: 60 },
  },
  {
    id: 't_10y', label: '10Y → 3.00%', cluster: 'thesis',
    unit: '%', decimals: 1, showPct: false, refresh: 'daily',
    stressSign: -1,
    signRationale: 'This distance grows as yields fall — easing conditions (inverts the 10Y sign).',
    derive: { type: 'target_distance', input: 'us10y', target: 3 },
    deadline: '2027-02-07', // "within six months" of the Phase 2 brief date
  },
  {
    // % of the way from the Oct 2022 low (3491.58) to the 10,000 target.
    id: 'meltup', label: 'MELT-UP COMPLETION', cluster: 'thesis',
    unit: '%', decimals: 1, showPct: false, refresh: 'daily',
    stressSign: 1,
    signRationale: 'Completion rising = more of the melt-up spent = closer to the bust phase of the cycle.',
    derive: { type: 'completion', input: 'spx', base: 3491.58, target: 10000 },
  },
  {
    // Named, dated, falsifiable: right shoulder ~110 vs prior top ~116.
    id: 'igv', label: 'IGV vs H&S 110/116', cluster: 'thesis',
    unit: '$', unitPrefix: true, decimals: 2, refresh: 'daily',
    stressSign: 1,
    signRationale: 'A break above 116 refutes the H&S and extends software risk appetite — more altitude, and it moves the long/short book.',
    source: 'yahoo', seriesId: 'IGV',
    flagLevels: { shoulder: 110, top: 116 },
  },

  // ═══ hidden underlying series (feed derived tiles, never tiled) ═══════
  { id: 'spy', label: 'SPY', cluster: 'trend', unit: '$', decimals: 2,
    refresh: 'daily', hidden: true, source: 'yahoo', seriesId: 'SPY' },
  { id: 'rsp', label: 'RSP', cluster: 'trend', unit: '$', decimals: 2,
    refresh: 'daily', hidden: true, source: 'yahoo', seriesId: 'RSP' },
  { id: 'xlf', label: 'XLF', cluster: 'trend', unit: '$', decimals: 2,
    refresh: 'daily', hidden: true, source: 'yahoo', seriesId: 'XLF' },
  { id: 'xlb', label: 'XLB', cluster: 'trend', unit: '$', decimals: 2,
    refresh: 'daily', hidden: true, source: 'yahoo', seriesId: 'XLB' },
  { id: 'smh', label: 'SMH', cluster: 'trend', unit: '$', decimals: 2,
    refresh: 'daily', hidden: true, source: 'yahoo', seriesId: 'SMH' },
  { id: 'nasdaq', label: 'NASDAQ COMPOSITE', cluster: 'thesis', unit: '', decimals: 0,
    refresh: 'daily', hidden: true, source: 'yahoo', seriesId: '^IXIC' },
  { id: 'dow', label: 'DOW', cluster: 'thesis', unit: '', decimals: 0,
    refresh: 'daily', hidden: true, source: 'yahoo', seriesId: '^DJI' },
  { id: 'rut', label: 'RUSSELL 2000', cluster: 'thesis', unit: '', decimals: 0,
    refresh: 'daily', hidden: true, source: 'yahoo', seriesId: '^RUT' },
  { id: 'silver', label: 'SILVER', cluster: 'thesis', unit: '$', decimals: 2,
    refresh: 'daily', hidden: true, source: 'yahoo', seriesId: 'SI=F' },
  { id: 'gdx', label: 'GDX', cluster: 'thesis', unit: '$', decimals: 2,
    refresh: 'daily', hidden: true, source: 'yahoo', seriesId: 'GDX' },
  { id: 'corp_eq', label: 'CORP EQUITIES / GDP RAW', cluster: 'trend', unit: '', decimals: 2,
    refresh: 'daily', freq: 'quarterly', hidden: true,
    // NCBEILQ027S is $mn of corporate equities; GDP is $bn — the eq_gdp
    // combo folds the 1e3 into its coefficient after this ratio.
    derive: { type: 'ratio', num: 'corp_eq_lvl', den: 'gdp' } },
  { id: 'corp_eq_lvl', label: 'NCBEILQ027S', cluster: 'trend', unit: '', decimals: 0,
    refresh: 'daily', freq: 'quarterly', hidden: true,
    source: 'fred', seriesId: 'NCBEILQ027S' },
  { id: 'gdp', label: 'GDP', cluster: 'trend', unit: '', decimals: 0,
    refresh: 'daily', freq: 'quarterly', hidden: true,
    source: 'fred', seriesId: 'GDP' },
  { id: 'erp_spx', label: 'ERP S&P LEVEL', cluster: 'valuation', unit: '', decimals: 0,
    refresh: 'daily', freq: 'monthly', hidden: true,
    source: 'damodaran', seriesId: 'erp_spx', fetchIntervalDays: 20 },
  { id: 'erp_cf', label: 'ERP TRAILING CF', cluster: 'valuation', unit: '', decimals: 2,
    refresh: 'daily', freq: 'monthly', hidden: true,
    source: 'damodaran', seriesId: 'erp_cf', fetchIntervalDays: 20 },
  // Deep annual history (1961-). This is Implied ERP (FCFE) — a DIFFERENT
  // measure from the monthly sustainable-payout headline, so it is kept as
  // its own series and never spliced into it. Used for the reference marks
  // at the 1999 low and the 2008/2011 highs.
  { id: 'erp_annual', label: 'IMPLIED ERP (ANNUAL, FCFE)', cluster: 'valuation', unit: '%', decimals: 2,
    refresh: 'daily', freq: 'monthly', staleAfterDays: 500, hidden: true,
    source: 'damodaran', seriesId: 'erp_annual', fetchIntervalDays: 20 },
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
