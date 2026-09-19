// MASTER PHASE MODEL — section 4.
//
// Seven phases, and the rule the brief is emphatic about: do not change
// phase because of a single daily market move. A candidate phase must hold
// for `persistDays` consecutive evaluations before it is adopted, which is
// the same hysteresis the Barometer applies to its own regimes.
//
// The phase is a CLASSIFICATION generated from the indicators, not a claim
// that the thesis is correct or that the world is objectively in this
// state. The wording on the card says so.

import thresholds from '../../config/thresholds.json' with { type: 'json' };
import type { CreditResult } from './credit.ts';
import type { BustResult } from './bust.ts';
import type { LiquidityResult } from './liquidity.ts';

const T = thresholds.phase;

export const PHASES = [
  'NORMAL / PRE-MELT-UP',
  'MELT-UP',
  'PARABOLIC FINAL STAGE',
  'BUST WARNING',
  'GLOBAL BUST / DEFLATION',
  'QE / MONEY PUMP',
  'COMMODITY SUPERCYCLE',
] as const;
export type Phase = (typeof PHASES)[number];

export interface PhaseInput {
  ret6m: number | null;
  drawdown: number | null;
  meltup: number;
  credit: CreditResult;
  bust: BustResult;
  liquidity: LiquidityResult;
  commodityLeadership: number;   // how many of gold/silver/copper/oil beat the S&P over 6m
}

export interface PhaseResult {
  phase: Phase;
  candidate: Phase;
  /** Consecutive evaluations the candidate has held. */
  heldDays: number;
  persistDays: number;
  settled: boolean;
  confidence: 'LOW' | 'MODERATE' | 'HIGH';
  explanation: string;
  evidence: string[];
}

/** Classify today from the indicators alone — no memory. */
export function classify(i: PhaseInput): { phase: Phase; explanation: string; evidence: string[] } {
  const ev: string[] = [];

  // Walk from the most advanced phase backwards; the first match wins, so
  // a later phase is never masked by an earlier one still being true.

  // 7. commodity supercycle — needs several confirmations, not one high
  if (i.commodityLeadership >= thresholds.commodities.breadth_min_confirming
      && i.liquidity.qe.active) {
    ev.push(`${i.commodityLeadership} of four commodities leading the S&P over six months`);
    ev.push(i.liquidity.qe.detail);
    return { phase: 'COMMODITY SUPERCYCLE',
      explanation: 'Commodities are leading broadly while the balance sheet expands — the post-bust configuration the thesis expects.', evidence: ev };
  }

  // 6. QE / money pump
  if (i.liquidity.qe.active && (i.liquidity.walcl13wBn ?? 0) >= T.qe_walcl_13w_bn) {
    ev.push(i.liquidity.qe.detail);
    if (i.drawdown !== null) ev.push(`S&P ${i.drawdown.toFixed(1)}% from its one-year peak`);
    return { phase: 'QE / MONEY PUMP',
      explanation: 'The balance sheet is expanding past intervention scale — a liquidity response is under way.', evidence: ev };
  }

  // 5. global bust
  if ((i.drawdown !== null && i.drawdown <= T.bust_drawdown) || i.credit.score >= T.bust_credit_stage) {
    if (i.drawdown !== null) ev.push(`S&P ${i.drawdown.toFixed(1)}% from its one-year peak`);
    ev.push(`Credit Canary ${i.credit.score.toFixed(1)}/5 — ${i.credit.stage}`);
    return { phase: 'GLOBAL BUST / DEFLATION',
      explanation: 'Equities are in a deep drawdown or credit has reached contagion — the bust leg, not a warning about one.', evidence: ev };
  }

  // 4. bust warning — onset evidence without the bust itself
  if (i.bust.onset >= 1.5 || (i.drawdown !== null && i.drawdown <= T.bust_warning_drawdown && i.credit.score >= 2)) {
    if (i.drawdown !== null) ev.push(`S&P ${i.drawdown.toFixed(1)}% from its peak`);
    ev.push(`Bust onset evidence ${i.bust.onset.toFixed(1)}/2`);
    ev.push(`Credit Canary ${i.credit.score.toFixed(1)}/5`);
    return { phase: 'BUST WARNING',
      explanation: 'Onset evidence is present — internals and credit are deteriorating together, though a bust has not confirmed.', evidence: ev };
  }

  // 3. parabolic final stage
  if (i.ret6m !== null && i.ret6m >= T.parabolic_ret6m && i.meltup >= 3.5) {
    ev.push(`S&P six-month return +${i.ret6m.toFixed(1)}%, past the ${T.parabolic_ret6m}% parabolic threshold`);
    ev.push(`Melt-Up Score ${i.meltup.toFixed(1)}/5`);
    return { phase: 'PARABOLIC FINAL STAGE',
      explanation: 'Equity momentum is at parabolic pace with the melt-up configuration broadly intact.', evidence: ev };
  }

  // 2. melt-up
  if (i.meltup >= 2.5) {
    if (i.ret6m !== null) ev.push(`S&P six-month return ${i.ret6m > 0 ? '+' : ''}${i.ret6m.toFixed(1)}%`);
    ev.push(`Melt-Up Score ${i.meltup.toFixed(1)}/5`);
    ev.push(`Credit Canary ${i.credit.score.toFixed(1)}/5 — ${i.credit.stage}`);
    return { phase: 'MELT-UP',
      explanation: 'Equities remain strong, credit has not confirmed a bust, and liquidity conditions are not yet contradicting the advance.', evidence: ev };
  }

  if (i.ret6m !== null) ev.push(`S&P six-month return ${i.ret6m > 0 ? '+' : ''}${i.ret6m.toFixed(1)}%`);
  ev.push(`Melt-Up Score ${i.meltup.toFixed(1)}/5 — below the 2.5 melt-up threshold`);
  return { phase: 'NORMAL / PRE-MELT-UP',
    explanation: 'No melt-up configuration and no onset evidence — neither leg of the thesis is currently visible.', evidence: ev };
}

/** Apply persistence against the stored history of candidate phases. */
export function settle(
  todayCandidate: Phase,
  adoptedPhase: Phase | null,
  recentCandidates: Phase[],   // most recent LAST, excluding today
): Pick<PhaseResult, 'phase' | 'heldDays' | 'settled' | 'confidence'> {
  const chain = [...recentCandidates, todayCandidate];
  let held = 0;
  for (let i = chain.length - 1; i >= 0 && chain[i] === todayCandidate; i--) held++;

  const settled = held >= T.persistDays;
  const phase = settled ? todayCandidate : (adoptedPhase ?? todayCandidate);
  const confidence = held >= T.persistDays * 2 ? 'HIGH' : settled ? 'MODERATE' : 'LOW';
  return { phase, heldDays: held, settled, confidence };
}

export const PERSIST_DAYS = T.persistDays;
