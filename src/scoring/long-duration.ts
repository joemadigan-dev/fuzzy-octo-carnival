// LONG DURATION / TREASURY CONVEXITY — a separate analytical stream.
//
// One narrow question: is the macro, inflation and Treasury setup becoming
// attractive for a concentrated long-duration Treasury position, with the
// 2056 principal STRIP as the reference security.
//
// THE FAILURE MODE THIS FILE EXISTS TO PREVENT is the syllogism
// "recession is coming, therefore buy long bonds". A 29-year zero does not
// care whether GDP falls. It cares about one number: the long discount
// rate. A recession helps it only when the recession drags the long REAL
// yield or the term premium down with it. A stagflationary recession, a
// fiscal-risk shock or renewed inflation leaves long yields where they are
// or pushes them higher, and a holder of 29 years of duration loses
// heavily — the same convexity that produces the upside.
//
// So the macro pillar is MULTIPLIED by an inflation-compatibility factor
// rather than added alongside it. Growth deterioration with accelerating
// inflation scores ZERO from the macro pillar, not a reduced amount. That
// is the difference between a module that encodes the distinction and one
// that merely mentions it in a caveat.
//
// SETUP IS NOT CONFIRMATION, and they are reported separately. Yields can
// be at a sixteen-year extreme and still rising. "5.0, NOT CONFIRMED" is a
// coherent and common reading, and collapsing the two into one number
// would destroy the only information that distinguishes a cheap asset from
// a turning one.
//
// This stream feeds NO existing composite. It is not in the barometer, not
// in the phase model, not in any of the five cockpit cards. It reads their
// outputs; nothing reads it.
//
// NO POSITION LANGUAGE. Section 19 of the original brief forbids
// BUY/SELL/LONG/SHORT, and it is not relaxed because this module happens
// to be about an instrument. The vocabulary tops out at "Exceptional",
// which describes the setup, not an instruction.

import type { Point } from '../sources/types.ts';
import thresholds from '../../config/thresholds.json' with { type: 'json' };
import {
  build, change, latest, noData, valueAt,
  type Component, type Score,
} from './common.ts';
import { isoDaysAgo, valueOnOrBefore } from '../compute/stats.ts';
import type { CreditResult } from './credit.ts';
import type { BustResult } from './bust.ts';
import type { LiquidityResult } from './liquidity.ts';
import type { PhaseResult } from './phase.ts';

const T = thresholds.long_duration;

// ── vocabulary ────────────────────────────────────────────────────────

export type SetupBand =
  | 'UNFAVOURABLE' | 'WEAK' | 'WATCH' | 'SETUP BUILDING' | 'ATTRACTIVE' | 'EXCEPTIONAL';

export type MacroRegime =
  | 'Disinflationary slowdown'
  | 'Disinflationary recession'
  | 'Soft landing'
  | 'Reacceleration'
  | 'Stagflation'
  | 'Fiscal / term-premium stress'
  | 'Indeterminate';

export type Confirmation = 'Not confirmed' | 'Partial' | 'Confirmed';
export type Veto = 'OFF' | 'WATCH' | 'ACTIVE';

/** Brief section 1. Bands on the score, not on any underlying yield. */
export function bandOf(score: number): SetupBand {
  const B = T.bands;
  if (score >= B.attractive) return 'EXCEPTIONAL';
  if (score >= B.building) return 'ATTRACTIVE';
  if (score >= B.watch) return 'SETUP BUILDING';
  if (score >= B.weak) return 'WATCH';
  if (score >= B.unfavourable) return 'WEAK';
  return 'UNFAVOURABLE';
}

// ── series helpers ────────────────────────────────────────────────────

/** Percentile rank of the latest value against the series' WHOLE stored
 *  history, with the sample size returned alongside it.
 *
 *  The n matters as much as the percentile and is carried everywhere for
 *  that reason: DFII30 only starts in 2010, so its 96th percentile is a
 *  claim about sixteen years. Presenting that as though it were a claim
 *  about fifty would be the most flattering possible misreading of the
 *  valuation case, which is exactly why it is not available. */
export function percentileOfLatest(
  pts: Point[] | undefined,
): { pct: number; n: number; first: string; last: string; value: number } | null {
  if (!pts?.length || pts.length < 60) return null;
  const v = pts[pts.length - 1].value;
  let below = 0;
  for (const p of pts) if (p.value <= v) below++;
  return {
    pct: (below / pts.length) * 100,
    n: pts.length,
    first: pts[0].date,
    last: pts[pts.length - 1].date,
    value: v,
  };
}

/** Standard deviation of the rolling `days`-change, used to say whether a
 *  move in the term premium is fast rather than merely present. */
function changeZ(pts: Point[] | undefined, days: number): number | null {
  if (!pts || pts.length < 250) return null;
  const deltas: number[] = [];
  for (let i = 0; i < pts.length; i++) {
    const then = valueOnOrBefore(pts, isoDaysAgo(pts[i].date, days));
    if (then && then.date < pts[i].date) deltas.push(pts[i].value - then.value);
  }
  if (deltas.length < 100) return null;
  const mean = deltas.reduce((a, b) => a + b, 0) / deltas.length;
  const sd = Math.sqrt(deltas.reduce((a, b) => a + (b - mean) ** 2, 0) / deltas.length);
  if (!(sd > 0)) return null;
  const cur = deltas[deltas.length - 1];
  return (cur - mean) / sd;
}

/** Mean of the last `n` points, or null. Used for the moving averages in
 *  the confirmation test. */
function movingAverage(pts: Point[] | undefined, n: number): number | null {
  if (!pts || pts.length < n) return null;
  let s = 0;
  for (let i = pts.length - n; i < pts.length; i++) s += pts[i].value;
  return s / n;
}

/** Annualised rate of change of a monthly index over `months`. */
function annualisedIndexChange(pts: Point[] | undefined, months: number): number | null {
  const end = latest(pts);
  if (!end || !pts) return null;
  const then = valueOnOrBefore(pts, isoDaysAgo(end.date, Math.round(months * 30.44)));
  if (!then || then.date >= end.date || then.value <= 0) return null;
  const years = (Date.parse(end.date) - Date.parse(then.date)) / (365.25 * 86400000);
  if (years <= 0) return null;
  return (Math.pow(end.value / then.value, 1 / years) - 1) * 100;
}

const bpOf = (pp: number | null): number | null => (pp === null ? null : pp * 100);

// ── A. valuation, 40% ─────────────────────────────────────────────────

export interface ValuationDetail {
  nominal: ReturnType<typeof percentileOfLatest>;
  real: ReturnType<typeof percentileOfLatest>;
  termPremium: ReturnType<typeof percentileOfLatest>;
  termPremiumRisingZ: number | null;
  nominal1mBp: number | null;
  nominal3mBp: number | null;
  real1mBp: number | null;
  real3mBp: number | null;
}

function valuationPillar(m: Map<string, Point[]>): {
  components: Component[]; detail: ValuationDetail;
} {
  const V = T.valuation;
  const nomPts = m.get('us30y');
  const realPts = m.get('us30y_real');
  const tpPts = m.get('term_premium');

  const nominal = percentileOfLatest(nomPts);
  const real = percentileOfLatest(realPts);
  const termPremium = percentileOfLatest(tpPts);
  const termPremiumRisingZ = changeZ(tpPts, 60);

  const detail: ValuationDetail = {
    nominal, real, termPremium, termPremiumRisingZ,
    nominal1mBp: bpOf(change(nomPts, 30)),
    nominal3mBp: bpOf(change(nomPts, 91)),
    real1mBp: bpOf(change(realPts, 30)),
    real3mBp: bpOf(change(realPts, 91)),
  };

  const components: Component[] = [];

  // a1 — the long REAL yield. The single most important input: it is the
  // compensation actually on offer, stripped of the inflation guess.
  if (!real) {
    components.push(noData('30Y real yield percentile'));
  } else {
    const yrs = (real.n / 252).toFixed(0);
    const band =
      real.pct >= V.real_pct_exceptional ? 1
      : real.pct >= V.real_pct_attractive ? 0.75
      : real.pct >= V.real_pct_fair ? 0.375
      : real.pct >= V.real_pct_poor ? 0.125 : 0;
    components.push({
      delta: band * V.real_cap,
      reason: band >= 0.75
        ? `30Y real yield ${real.value.toFixed(2)}% sits in the ${real.pct.toFixed(0)}th percentile of its ${yrs}-year history (from ${real.first}) — the compensation for holding duration is historically high`
        : band > 0
          ? `30Y real yield ${real.value.toFixed(2)}% is at the ${real.pct.toFixed(0)}th percentile of its ${yrs}-year history (from ${real.first}) — middling, not cheap`
          : `30Y real yield ${real.value.toFixed(2)}% is at the ${real.pct.toFixed(0)}th percentile of its ${yrs}-year history (from ${real.first}) — historically expensive duration`,
    });
  }

  // a2 — the nominal yield. Deeper history than the real series, which is
  // why it is carried separately rather than folded into a1.
  if (!nominal) {
    components.push(noData('30Y nominal yield percentile'));
  } else {
    const yrs = (nominal.n / 252).toFixed(0);
    const band =
      nominal.pct >= V.real_pct_exceptional ? 1
      : nominal.pct >= V.real_pct_attractive ? 0.75
      : nominal.pct >= V.real_pct_fair ? 0.375
      : nominal.pct >= V.real_pct_poor ? 0.125 : 0;
    components.push({
      delta: band * V.nominal_cap,
      reason: `30Y nominal ${nominal.value.toFixed(2)}% at the ${nominal.pct.toFixed(0)}th percentile of ${yrs} years (from ${nominal.first})${band >= 0.75 ? ' — the long end is priced cheaply against its own history' : ''}`,
    });
  }

  // a3 — term premium, WITH DIRECTION. The brief is explicit that a high
  // term premium is not automatically bullish, and it is right: a term
  // premium that is high because the market is progressively refusing to
  // fund the long end is a reason for caution, not an entry signal. So a
  // fast rise caps this component and emits its own contradiction.
  if (!termPremium) {
    components.push(noData('term premium percentile'));
  } else {
    const rising = termPremiumRisingZ !== null && termPremiumRisingZ >= V.tp_rising_z;
    const base =
      termPremium.pct >= V.tp_pct_high ? V.tp_cap
      : termPremium.pct >= V.tp_pct_moderate ? V.tp_cap * 0.6 : 0;
    const delta = rising ? Math.min(base, V.tp_rising_cap) : base;
    components.push({
      delta,
      reason: rising
        ? `10Y term premium ${termPremium.value.toFixed(2)}% is at the ${termPremium.pct.toFixed(0)}th percentile BUT still rising fast (60-day change ${termPremiumRisingZ!.toFixed(1)}σ) — a term premium climbing this quickly is the market repricing the long end, not an entry level, so this is capped at ${V.tp_rising_cap}`
        : base > 0
          ? `10Y term premium ${termPremium.value.toFixed(2)}% at the ${termPremium.pct.toFixed(0)}th percentile and not rising sharply — duration is being paid for`
          : `10Y term premium ${termPremium.value.toFixed(2)}% at the ${termPremium.pct.toFixed(0)}th percentile — little extra compensation for duration`,
    });
  }

  return { components, detail };
}

// ── C. inflation compatibility, 25% (computed before B, which needs it) ─

export interface InflationDetail {
  breakeven: number | null;
  breakevenAsOf: string | null;
  breakeven1mBp: number | null;
  breakeven3mBp: number | null;
  breakevenPct: number | null;
  core3mAnn: number | null;
  core12mAnn: number | null;
  coreAsOf: string | null;
  oil: number | null;
  oil3mPct: number | null;
  oilAsOf: string | null;
}

function inflationPillar(m: Map<string, Point[]>): {
  components: Component[]; detail: InflationDetail; raw: number; known: number; total: number;
} {
  const I = T.inflation;
  const bePts = m.get('be30');
  const corePts = m.get('core_cpi');
  const oilPts = m.get('wti');

  const be = latest(bePts);
  const bePct = percentileOfLatest(bePts);
  const be3m = bpOf(change(bePts, 91));
  const core3m = annualisedIndexChange(corePts, 3);
  const core12m = annualisedIndexChange(corePts, 12);
  const oil = latest(oilPts);
  const oil3mAbs = change(oilPts, 91);
  const oil3m = oil && oil3mAbs !== null && oil.value - oil3mAbs !== 0
    ? (oil3mAbs / Math.abs(oil.value - oil3mAbs)) * 100 : null;

  const detail: InflationDetail = {
    breakeven: be?.value ?? null,
    breakevenAsOf: be?.date ?? null,
    breakeven1mBp: bpOf(change(bePts, 30)),
    breakeven3mBp: be3m,
    breakevenPct: bePct?.pct ?? null,
    core3mAnn: core3m,
    core12mAnn: core12m,
    coreAsOf: latest(corePts)?.date ?? null,
    oil: oil?.value ?? null,
    oil3mPct: oil3m,
    oilAsOf: oil?.date ?? null,
  };

  const components: Component[] = [];

  // c1 — 30Y breakeven, level AND direction. This is the number that
  // decides whether a growth scare can become a bond rally at all.
  if (be === null || be3m === null) {
    components.push(noData('30Y breakeven'));
  } else {
    const falling = be3m <= I.be_falling_bp;
    const rising = be3m >= I.be_rising_bp;
    const cheapSide = bePct !== null && bePct.pct <= 50;
    const delta = rising ? 0 : falling ? I.be_cap : cheapSide ? I.be_cap * 0.6 : I.be_cap * 0.4;
    components.push({
      delta,
      reason: rising
        ? `30Y breakeven ${be.value.toFixed(2)}% has risen ${be3m.toFixed(0)}bp over three months — inflation expectations are moving the wrong way for long duration, scored 0`
        : falling
          ? `30Y breakeven ${be.value.toFixed(2)}% has fallen ${Math.abs(be3m).toFixed(0)}bp over three months — the long end has room to rally on weaker growth`
          : `30Y breakeven ${be.value.toFixed(2)}% is broadly stable over three months (${be3m >= 0 ? '+' : ''}${be3m.toFixed(0)}bp)${bePct ? `, ${bePct.pct.toFixed(0)}th percentile` : ''}`,
    });
  }

  // c2 — core inflation TREND, 3-month annualised against 12-month.
  // The brief asks for trend over latest print and it is the right call:
  // one print is noise, the relationship between the short and long
  // annualised rates is the direction.
  if (core3m === null || core12m === null) {
    components.push(noData('core CPI trend'));
  } else {
    const gap = core3m - core12m;
    const hot = core3m >= I.core_hot_pct;
    const delta = gap > 0.3 && hot ? 0
      : gap > 0.3 ? I.core_cap * 0.3
      : gap < -0.3 ? I.core_cap
      : I.core_cap * 0.55;
    components.push({
      delta,
      reason: gap > 0.3
        ? `Core CPI running ${core3m.toFixed(1)}% annualised over three months against ${core12m.toFixed(1)}% over twelve — reaccelerating${hot ? ` and above the ${I.core_hot_pct}% level at which the long end stops being able to rally on growth weakness` : ''}`
        : gap < -0.3
          ? `Core CPI ${core3m.toFixed(1)}% annualised over three months against ${core12m.toFixed(1)}% over twelve — disinflating, which is what lets the long end respond to weaker growth`
          : `Core CPI ${core3m.toFixed(1)}% annualised over three months against ${core12m.toFixed(1)}% over twelve — flat trend`,
    });
  }

  // c3 — energy. Reuses the existing wti series; no new fetch.
  if (oil3m === null || oil === null) {
    components.push(noData('energy trend'));
  } else {
    const shock = oil3m >= I.energy_shock_pct;
    const delta = shock ? 0 : oil3m <= I.energy_falling_pct ? I.energy_cap : I.energy_cap * 0.5;
    components.push({
      delta,
      reason: shock
        ? `WTI $${oil.value.toFixed(0)}, ${oil3m >= 0 ? '+' : ''}${oil3m.toFixed(0)}% over three months — an energy shock of this size feeds headline inflation and constrains the long end, scored 0`
        : oil3m <= I.energy_falling_pct
          ? `WTI $${oil.value.toFixed(0)}, ${oil3m.toFixed(0)}% over three months — falling energy is disinflationary at the margin`
          : `WTI $${oil.value.toFixed(0)}, ${oil3m >= 0 ? '+' : ''}${oil3m.toFixed(0)}% over three months — no energy shock`,
    });
  }

  const known = components.filter((c) => !c.unknown);
  return {
    components, detail,
    raw: known.reduce((s, c) => s + c.delta, 0),
    known: known.length,
    total: components.length,
  };
}

// ── B. macro turn, 35%, gated by C ────────────────────────────────────

export interface MacroInputs {
  phase: PhaseResult;
  bust: BustResult;
  credit: CreditResult;
  liquidity: LiquidityResult;
}

function macroPillar(
  m: Map<string, Point[]>, i: MacroInputs, compat: number,
): { components: Component[]; rawBeforeGate: number } {
  const M = T.macro;
  const components: Component[] = [];

  // b1 — Bust Risk, consumed as an output. Not recomputed.
  const b = i.bust.score;
  const b1 = b >= M.bust_strong ? M.bust_cap
    : b >= M.bust_moderate ? M.bust_cap * 0.75
    : b >= M.bust_early ? M.bust_cap * 0.42 : 0;
  components.push({
    delta: b1,
    reason: b1 > 0
      ? `Bust Risk ${b.toFixed(1)}/5 (${i.bust.level}) — growth and valuation stress of the kind that eventually pulls long rates down`
      : `Bust Risk ${b.toFixed(1)}/5 (${i.bust.level}) — no growth deterioration to push long rates lower`,
  });

  // b2 — Credit Canary. Widening credit is the transmission channel from
  // a slowdown to lower long rates.
  const c = i.credit.score;
  const b2 = c >= M.credit_strong ? M.credit_cap
    : c >= M.credit_moderate ? M.credit_cap * 0.7
    : c > 0 ? M.credit_cap * 0.4 : 0;
  components.push({
    delta: b2,
    reason: b2 > 0
      ? `Credit Canary ${c.toFixed(1)}/5 (${i.credit.stage}) — credit deterioration is the channel through which a slowdown reaches the long end`
      : `Credit Canary ${c.toFixed(1)}/5 (${i.credit.stage}) — credit is not signalling a slowdown`,
  });

  // b3 — the master phase. A bust or deflationary phase is the regime in
  // which long duration works; a melt-up with onset stirring is a partial.
  const ph = i.phase.phase;
  const bustish = /BUST|DEFLATION|CONTRACTION/i.test(ph);
  const onset = i.bust.onset ?? 0;
  const b3 = bustish ? M.regime_cap : onset >= 1 ? M.regime_cap * 0.57 : 0;
  components.push({
    delta: b3,
    reason: bustish
      ? `Phase ${ph}, Bust Onset ${onset.toFixed(1)}/2 — the regime in which long discount rates fall`
      : onset >= 1
        ? `Phase ${ph}, but Bust Onset ${onset.toFixed(1)}/2 is stirring — an early, partial signal`
        : `Phase ${ph} with Bust Onset ${onset.toFixed(1)}/2 — no turn in the regime yet`,
  });

  // b4 — rates leg and the front end. A 2Y rolling over is the market
  // pricing cuts, which is the mechanism, not a coincidence.
  const us2y20 = bpOf(change(m.get('us2y'), 20));
  const collapsing = i.liquidity.rateLeg === 'RATES COLLAPSING — DEFLATIONARY CONFIRMATION';
  const frontRolling = us2y20 !== null && us2y20 <= M.us2y_rollover_bp;
  const b4 = collapsing ? M.rates_cap : frontRolling ? M.rates_cap * 0.5 : 0;
  components.push({
    delta: b4,
    reason: collapsing
      ? `${i.liquidity.rateLeg}; 2Y ${us2y20 === null ? 'unknown' : `${us2y20 >= 0 ? '+' : ''}${us2y20.toFixed(0)}bp/20d`} — the leg of the sequence that lowers long discount rates`
      : frontRolling
        ? `2Y ${us2y20!.toFixed(0)}bp over 20 sessions — the front end is rolling over, which is cuts being priced`
        : `${i.liquidity.rateLeg}; 2Y ${us2y20 === null ? 'unknown' : `${us2y20 >= 0 ? '+' : ''}${us2y20.toFixed(0)}bp/20d`} — rates are not yet easing`,
  });

  const rawBeforeGate = components.reduce((s, x) => s + x.delta, 0);

  // THE GATE. This is the line that stops "recession = buy bonds".
  if (compat < 1) {
    for (const comp of components) comp.delta *= compat;
    components.push({
      delta: 0,
      reason: compat === 0
        ? `MACRO PILLAR SCORED ZERO: growth deterioration is present but inflation is not compatible with a long-end rally. A recession that keeps inflation elevated does not lower long real yields — it is the case in which 29 years of duration loses badly. The ${ptsFmt(rawBeforeGate)} of macro evidence above is deliberately withheld, not merely discounted`
        : `MACRO PILLAR HALVED: growth is deteriorating but inflation compatibility is only partial, so ${ptsFmt(rawBeforeGate)} of macro evidence contributes ${ptsFmt(rawBeforeGate * compat)}. Weaker growth only helps long duration to the extent the long end is free to rally`,
    });
  }

  return { components, rawBeforeGate };
}

const ptsFmt = (v: number): string => `${v.toFixed(2)} pts`;

// ── stagflation veto ──────────────────────────────────────────────────

export interface VetoResult {
  state: Veto;
  triggered: string[];
  /** Cap applied to the total, or null when nothing is capped. */
  cap: number | null;
}

function stagflationVeto(v: ValuationDetail, inf: InflationDetail): VetoResult {
  const W = T.veto;
  const triggered: string[] = [];

  if (inf.breakeven3mBp !== null && inf.breakeven3mBp >= W.be_3m_bp
      && inf.breakevenPct !== null && inf.breakevenPct >= W.be_pct) {
    triggered.push(`30Y breakeven +${inf.breakeven3mBp.toFixed(0)}bp over three months and at the ${inf.breakevenPct.toFixed(0)}th percentile — inflation expectations accelerating from an already high level`);
  }
  if (inf.core3mAnn !== null && inf.core12mAnn !== null
      && inf.core3mAnn > inf.core12mAnn && inf.core3mAnn >= W.core_3m_ann_pct) {
    triggered.push(`Core CPI ${inf.core3mAnn.toFixed(1)}% annualised over three months, above both its twelve-month rate and the ${W.core_3m_ann_pct}% threshold — core is reaccelerating`);
  }
  if (inf.oil3mPct !== null && inf.oil3mPct >= W.energy_3m_pct) {
    triggered.push(`WTI +${inf.oil3mPct.toFixed(0)}% over three months — an energy shock of this magnitude`);
  }
  if (v.real3mBp !== null && v.real3mBp >= W.real30_3m_bp) {
    triggered.push(`30Y real yield +${v.real3mBp.toFixed(0)}bp over three months — long real yields are still rising aggressively, which is the direct opposite of the move this setup requires`);
  }

  const state: Veto = triggered.length >= W.active_at ? 'ACTIVE'
    : triggered.length >= W.watch_at ? 'WATCH' : 'OFF';
  const cap = state === 'ACTIVE' ? W.cap_active : state === 'WATCH' ? W.cap_watch : null;
  return { state, triggered, cap };
}

// ── macro regime classification ───────────────────────────────────────

function classifyRegime(
  v: ValuationDetail, inf: InflationDetail, i: MacroInputs, lowConfidence: boolean,
): { regime: MacroRegime; why: string } {
  if (lowConfidence) {
    return { regime: 'Indeterminate', why: 'Too few inputs available to classify a regime.' };
  }

  const growthWeak = i.bust.score >= T.macro.bust_moderate || i.credit.score >= T.macro.credit_moderate;
  const deepWeak = i.credit.score >= T.macro.credit_strong || /BUST|DEFLATION/i.test(i.phase.phase);

  const infRising = (inf.breakeven3mBp !== null && inf.breakeven3mBp >= T.inflation.be_rising_bp)
    || (inf.core3mAnn !== null && inf.core12mAnn !== null
        && inf.core3mAnn - inf.core12mAnn > 0.3 && inf.core3mAnn >= T.inflation.core_hot_pct);
  const infFalling = (inf.breakeven3mBp !== null && inf.breakeven3mBp <= T.inflation.be_falling_bp)
    || (inf.core3mAnn !== null && inf.core12mAnn !== null && inf.core3mAnn - inf.core12mAnn < -0.3);

  const realRising = v.real3mBp !== null && v.real3mBp >= T.veto.real30_3m_bp;
  const tpHigh = v.termPremium !== null && v.termPremium.pct >= 85;

  // Fiscal / term-premium stress is checked FIRST because it is the case
  // that looks most like an opportunity and is not one: long real yields
  // rising while inflation expectations are NOT, which is the market
  // demanding more to fund the long end rather than pricing inflation.
  if (tpHigh && realRising && !infRising) {
    return {
      regime: 'Fiscal / term-premium stress',
      why: 'Long real yields rising with the term premium at an extreme while inflation expectations are not accelerating — the market is demanding more compensation to hold duration, which raises long yields without any inflation cause.',
    };
  }
  if (growthWeak && infRising) {
    return { regime: 'Stagflation', why: 'Growth deteriorating while inflation accelerates — the configuration in which weaker growth does not lower long yields.' };
  }
  if (growthWeak && infFalling && deepWeak) {
    return { regime: 'Disinflationary recession', why: 'Growth and credit deteriorating together with inflation falling — the configuration in which long discount rates fall.' };
  }
  if (growthWeak && infFalling) {
    return { regime: 'Disinflationary slowdown', why: 'Growth softening with inflation falling, but credit has not confirmed a recession.' };
  }
  if (!growthWeak && infRising) {
    return { regime: 'Reacceleration', why: 'Growth holding up while inflation accelerates — the worst configuration for long duration.' };
  }
  if (!growthWeak && infFalling) {
    return { regime: 'Soft landing', why: 'Inflation falling without growth deterioration — supportive of the long end, but without the growth shock that produces a large move.' };
  }
  return { regime: 'Indeterminate', why: 'Neither growth nor inflation is moving decisively enough to classify.' };
}

// ── market confirmation ───────────────────────────────────────────────

export interface ConfirmationResult {
  state: Confirmation;
  passed: number;
  total: number;
  tests: { label: string; pass: boolean | null; detail: string }[];
}

function marketConfirmation(m: Map<string, Point[]>, liq: LiquidityResult): ConfirmationResult {
  const C = T.confirmation;
  const nom = m.get('us30y');
  const nomL = latest(nom);
  const ma20 = movingAverage(nom, C.ma_short_days);
  const ma60 = movingAverage(nom, C.ma_long_days);
  const real20 = bpOf(change(m.get('us30y_real'), 20));
  const us2y20 = bpOf(change(m.get('us2y'), 20));

  const tests: ConfirmationResult['tests'] = [
    {
      label: `30Y below its ${C.ma_short_days}-day average`,
      pass: nomL && ma20 !== null ? nomL.value < ma20 : null,
      detail: nomL && ma20 !== null
        ? `${nomL.value.toFixed(2)}% vs ${ma20.toFixed(2)}%`
        : 'insufficient history',
    },
    {
      label: `30Y below its ${C.ma_long_days}-day average`,
      pass: nomL && ma60 !== null ? nomL.value < ma60 : null,
      detail: nomL && ma60 !== null
        ? `${nomL.value.toFixed(2)}% vs ${ma60.toFixed(2)}%`
        : 'insufficient history',
    },
    {
      label: '30Y real yield rolling over',
      pass: real20 === null ? null : real20 < C.real_rollover_bp,
      detail: real20 === null ? 'no data' : `${real20 >= 0 ? '+' : ''}${real20.toFixed(0)}bp over 20 sessions`,
    },
    {
      label: '2Y yield rolling over',
      pass: us2y20 === null ? null : us2y20 < C.us2y_rollover_bp,
      detail: us2y20 === null ? 'no data' : `${us2y20 >= 0 ? '+' : ''}${us2y20.toFixed(0)}bp over 20 sessions`,
    },
    {
      label: 'Liquidity / rates turning supportive',
      pass: liq.rateLeg === 'RATES COLLAPSING — DEFLATIONARY CONFIRMATION' || liq.regime === 'EXPANDING',
      detail: `${liq.rateLeg}; balance sheet ${liq.regime}`,
    },
  ];

  const passed = tests.filter((t) => t.pass === true).length;
  const state: Confirmation = passed >= C.confirmed_at ? 'Confirmed'
    : passed >= C.partial_at ? 'Partial' : 'Not confirmed';
  return { state, passed, total: tests.length, tests };
}

// ── sell-off decomposition ────────────────────────────────────────────

export type DriverTag =
  | 'Inflation-led sell-off'
  | 'Real-yield / term-premium-led sell-off'
  | 'Growth-scare rally'
  | 'Disinflation rally'
  | 'Mixed'
  | 'Quiet';

export interface Decomposition {
  windowDays: number;
  nominalBp: number | null;
  realBp: number | null;
  breakevenBp: number | null;
  tag: DriverTag;
  /** The sentence the UI prints. Deliberately stops short of claiming to
   *  observe a flow mechanism. */
  interpretation: string;
}

/** Split the 30Y nominal move into its real and breakeven legs.
 *
 *  WHAT THIS CANNOT SAY. Michael Green's mechanism is passive bond-fund
 *  flow amplifying long-end moves. Yield data cannot see flow, so no
 *  output here says "passive" or "mechanical". The strongest honest phrase
 *  is that a move is consistent with a non-inflation, term-premium driven
 *  sell-off — which is a statement about the decomposition, and leaves the
 *  mechanism an open question rather than asserting it. */
export function decompose(m: Map<string, Point[]>, windowDays: number): Decomposition {
  const D = T.decomposition;
  const nominalBp = bpOf(change(m.get('us30y'), windowDays));
  const realBp = bpOf(change(m.get('us30y_real'), windowDays));
  const beBp = bpOf(change(m.get('be30'), windowDays));

  const base = { windowDays, nominalBp, realBp, breakevenBp: beBp };

  if (nominalBp === null || realBp === null || beBp === null) {
    return { ...base, tag: 'Mixed', interpretation: 'Decomposition unavailable — one or more legs missing. Not inferred from the others.' };
  }
  if (Math.abs(nominalBp) < D.quiet_bp) {
    return { ...base, tag: 'Quiet', interpretation: `30Y moved ${nominalBp >= 0 ? '+' : ''}${nominalBp.toFixed(0)}bp over ${windowDays} sessions — too small to attribute.` };
  }

  const realShare = realBp / nominalBp;
  const beShare = beBp / nominalBp;
  const selling = nominalBp > 0;

  if (selling) {
    if (realShare >= D.dominant_share) {
      return {
        ...base, tag: 'Real-yield / term-premium-led sell-off',
        interpretation: `30Y +${nominalBp.toFixed(0)}bp, of which real +${realBp.toFixed(0)}bp and breakeven ${beBp >= 0 ? '+' : ''}${beBp.toFixed(0)}bp. Consistent with a non-inflation / term-premium driven sell-off — the compensation demanded for duration rose, not the inflation priced into it.`,
      };
    }
    if (realShare <= D.minor_share) {
      return {
        ...base, tag: 'Inflation-led sell-off',
        interpretation: `30Y +${nominalBp.toFixed(0)}bp, of which breakeven +${beBp.toFixed(0)}bp and real ${realBp >= 0 ? '+' : ''}${realBp.toFixed(0)}bp. Inflation expectations, not the real rate, are doing the work — which is the configuration long duration cannot rally out of.`,
      };
    }
    return {
      ...base, tag: 'Mixed',
      interpretation: `30Y +${nominalBp.toFixed(0)}bp split between real +${realBp.toFixed(0)}bp and breakeven ${beBp >= 0 ? '+' : ''}${beBp.toFixed(0)}bp — no single driver dominates.`,
    };
  }

  if (realShare >= D.dominant_share) {
    return {
      ...base, tag: 'Growth-scare rally',
      interpretation: `30Y ${nominalBp.toFixed(0)}bp, driven by real ${realBp.toFixed(0)}bp against breakeven ${beBp >= 0 ? '+' : ''}${beBp.toFixed(0)}bp. Falling real yields with inflation expectations holding — a growth scare, which is the move this setup is built for.`,
    };
  }
  if (beShare >= D.dominant_share) {
    return {
      ...base, tag: 'Disinflation rally',
      interpretation: `30Y ${nominalBp.toFixed(0)}bp, driven by breakeven ${beBp.toFixed(0)}bp against real ${realBp >= 0 ? '+' : ''}${realBp.toFixed(0)}bp. Falling inflation expectations are doing the work.`,
    };
  }
  return {
    ...base, tag: 'Mixed',
    interpretation: `30Y ${nominalBp.toFixed(0)}bp split between real ${realBp.toFixed(0)}bp and breakeven ${beBp.toFixed(0)}bp — no single driver dominates.`,
  };
}

// ── the module ────────────────────────────────────────────────────────

/** What the backtest found, carried in the payload so the caveat travels
 *  with the number rather than living only in a document nobody opens.
 *
 *  These are FACTS ABOUT THE SCORE'S TRACK RECORD, not live data, so they
 *  are constants and are updated only when the backtest is re-run. The
 *  script that produces them reads config/thresholds.json and never writes
 *  it: no threshold has been tuned to improve what this block says.
 *
 *  It says the score does not predict returns and is mildly inverse to
 *  them. That is an uncomfortable thing to render next to a 0-5 score and
 *  it is exactly why it renders next to the 0-5 score. */
export const VALIDATION = {
  /** Highest reading in ~25 years of reconstructed history. */
  observedMax: 3.8,
  /** Bands never reached, so never tested. */
  untestedBands: ['ATTRACTIVE', 'EXCEPTIONAL'] as const,
  spearman: { full1y: 0.01, full2y: 0.05, reduced1y: -0.07, reduced2y: -0.07 },
  headline: 'Backtested 2001-2024 on production-matched percentile windows: this score did NOT predict long-duration returns (rank correlation -0.07 to +0.05). Its lowest band preceded the best average one-year returns (+3.6%) and its middle bands the worst (-5.7%).',
  cause: 'Two reasons it cannot reach its top bands. The pillars are additive, so macro and inflation alone reach 3.0 of 5 with valuation at zero — in April 2020 the score read 3.0 with valuation 0.00, after the rally. And the veto condition "long real yields still rising" is almost always true exactly when the valuation percentile is highest, because a high real yield is usually reached BY rising: that collision is live right now at valuation 2.00 of 2.00 with the veto ACTIVE.',
  bandsNote: 'ATTRACTIVE and EXCEPTIONAL have never been observed in 25 years. Treat them as untested vocabulary.',
} as const;

/** True when the current reading sits in a band no history has tested. */
export const bandIsUntested = (band: SetupBand): boolean =>
  (VALIDATION.untestedBands as readonly string[]).includes(band);

export interface LongDurationResult {
  score: Score;
  band: SetupBand;
  regime: MacroRegime;
  regimeWhy: string;
  confirmation: ConfirmationResult;
  veto: VetoResult;
  /** True when too little evidence is available to present a score. */
  lowDataConfidence: boolean;
  valuation: ValuationDetail;
  inflation: InflationDetail;
  /** The multiplier applied to the macro pillar: 1, 0.5 or 0. */
  inflationCompatibility: number;
  pillars: { valuation: number; macro: number; inflation: number };
  decomposition: Decomposition[];
  supporting: string[];
  contradicting: string[];
  /** One deterministic sentence, built from the readings above it. */
  line: string;
  /** The score's own track record, rendered beside it. */
  validation: typeof VALIDATION & { currentBandUntested: boolean };
}

export function longDurationSetup(
  m: Map<string, Point[]>, i: MacroInputs,
): LongDurationResult {
  const val = valuationPillar(m);
  const inf = inflationPillar(m);

  // The gate, derived from the inflation pillar's own total.
  const compat = inf.raw >= T.inflation.compat_full ? 1
    : inf.raw >= T.inflation.compat_partial ? 0.5 : 0;

  const mac = macroPillar(m, i, compat);

  const components = [...val.components, ...mac.components, ...inf.components];
  let score = build(components, 5);

  const veto = stagflationVeto(val.detail, inf.detail);
  if (veto.cap !== null && score.score > veto.cap) {
    // Cap by appending an explicit negative component rather than silently
    // rewriting the number — the arithmetic on screen must still add up.
    const excess = score.score - veto.cap;
    components.push({
      delta: -excess,
      reason: `STAGFLATION VETO ${veto.state} — total capped at ${veto.cap.toFixed(1)} (from ${score.score.toFixed(1)}). ${veto.triggered.length} condition${veto.triggered.length === 1 ? '' : 's'} present: ${veto.triggered.map((t) => t.split(' — ')[0]).join('; ')}`,
    });
    score = build(components, 5);
  }

  const lowDataConfidence = score.coverage < T.confidence.low_coverage;
  const { regime, why } = classifyRegime(val.detail, inf.detail, i, lowDataConfidence);
  const confirmation = marketConfirmation(m, i.liquidity);

  const supporting = components.filter((c) => !c.unknown && c.delta > 0).map((c) => c.reason);
  const contradicting = components.filter((c) => !c.unknown && c.delta <= 0).map((c) => c.reason);

  const band = bandOf(score.score);
  const line = lowDataConfidence
    ? `LOW DATA CONFIDENCE — ${score.evidenceAvailable}/${score.evidenceTotal} inputs available. No setup score is presented.`
    : `Long duration setup ${score.score.toFixed(1)}/5 — ${band}. Macro regime: ${regime}. Market confirmation: ${confirmation.state.toLowerCase()} (${confirmation.passed}/${confirmation.total}). Stagflation veto: ${veto.state}.`;

  return {
    score, band, regime, regimeWhy: why, confirmation, veto, lowDataConfidence,
    valuation: val.detail, inflation: inf.detail,
    inflationCompatibility: compat,
    pillars: {
      valuation: val.components.filter((c) => !c.unknown).reduce((s, c) => s + c.delta, 0),
      macro: mac.components.filter((c) => !c.unknown).reduce((s, c) => s + c.delta, 0),
      inflation: inf.raw,
    },
    decomposition: [
      decompose(m, T.decomposition.window_short),
      decompose(m, T.decomposition.window_long),
    ],
    supporting, contradicting, line,
    validation: { ...VALIDATION, currentBandUntested: bandIsUntested(band) },
  };
}

export { valueAt };
