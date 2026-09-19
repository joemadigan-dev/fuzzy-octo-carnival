// MARKET SETUP — one deterministic sentence, section 9.
//
// Built from the model's own outputs by fixed rules. No language model, no
// randomness, no hidden state: the same inputs always produce the same
// sentence, and every clause names the reading that produced it, so the
// sentence can be checked against the cards above it.
//
// Shape: [what equities are doing] + [what valuation says] + [what credit
// says] + [the principal pressure, if any]. Clauses are omitted when their
// evidence is unavailable rather than guessed at.

import type { Score } from './common.ts';
import type { BustResult } from './bust.ts';
import type { CreditResult } from './credit.ts';
import type { LiquidityResult } from './liquidity.ts';
import type { PhaseResult } from './phase.ts';

export interface SetupInput {
  phase: PhaseResult;
  meltup: Score;
  bust: BustResult;
  credit: CreditResult;
  liquidity: LiquidityResult;
  ret6m: number | null;
  ret3mPace: number | null;     // 3m return scaled to a 6m pace
  drawdown: number | null;
  valuationPct: number | null;  // equity market cap / GDP, in percent
  erp: number | null;
  commoditiesLeading: number;
}

type Role = 'momentum' | 'drawdown' | 'valuation' | 'credit' | 'pressure' | 'commodities';

export interface Clause { role: Role; text: string; because: string }

export interface Setup {
  sentence: string;
  /** Each clause with the reading behind it, so the sentence is auditable. */
  clauses: Clause[];
}

export function marketSetup(i: SetupInput): Setup {
  const c: Clause[] = [];

  // 1. equities — level and direction of travel
  if (i.ret6m === null) {
    c.push({ role: 'momentum', text: 'equity momentum is unreadable', because: 'no six-month S&P return available' });
  } else {
    const accel = i.ret3mPace !== null ? i.ret3mPace - i.ret6m : null;
    const strength = i.ret6m >= 22 ? 'parabolic' : i.ret6m >= 10 ? 'strong' : i.ret6m > 0 ? 'positive but unremarkable' : 'negative';
    const drift = accel === null ? '' : accel >= 5 ? ' and still accelerating' : accel <= -5 ? ' but decelerating' : ' and steady';
    c.push({
      role: 'momentum',
      text: `equity momentum is ${strength}${drift}`,
      because: `S&P six-month return ${i.ret6m > 0 ? '+' : ''}${i.ret6m.toFixed(1)}%`
        + (i.ret3mPace === null ? '' : `, three-month pace ${i.ret3mPace > 0 ? '+' : ''}${i.ret3mPace.toFixed(1)}%`),
    });
  }

  // 2. drawdown overrides the momentum clause when it is material
  if (i.drawdown !== null && i.drawdown <= -10) {
    c.push({
      role: 'drawdown',
      text: `the index is ${Math.abs(i.drawdown).toFixed(0)}% off its one-year high`,
      because: `S&P drawdown ${i.drawdown.toFixed(1)}%`,
    });
  }

  // 3. valuation
  if (i.valuationPct !== null || i.erp !== null) {
    const stretched = (i.valuationPct !== null && i.valuationPct >= 160) || (i.erp !== null && i.erp <= 3.5);
    const parts: string[] = [];
    if (i.valuationPct !== null) parts.push(`market cap / GDP ${i.valuationPct.toFixed(0)}%`);
    if (i.erp !== null) parts.push(`implied ERP ${i.erp.toFixed(2)}%`);
    c.push({
      role: 'valuation',
      text: stretched ? 'valuations are stretched' : 'valuations are not extreme',
      because: parts.join(', '),
    });
  }

  // 4. credit — the clause that most often carries the answer
  c.push({
    role: 'credit',
    text: i.credit.systemic
      ? 'credit stress has reached investment grade'
      : i.credit.score >= 3 ? 'credit is deteriorating below investment grade'
      : i.credit.score >= 1.5 ? 'credit is showing isolated stress'
      : 'broad credit remains calm',
    because: `Credit Canary ${i.credit.score.toFixed(1)}/5, ${i.credit.stage}`,
  });

  // 5. the principal pressure — at most one, the most severe present
  const pressure =
    i.credit.systemic ? null   // already said above; do not repeat it
    : i.liquidity.rateLeg === 'RATES COLLAPSING — DEFLATIONARY CONFIRMATION'
      ? { role: 'pressure' as Role, text: 'collapsing long yields alongside widening spreads are the principal signal',
          because: `10Y ${i.liquidity.us10y?.toFixed(2)}%, credit ${i.liquidity.creditWord}` }
    : i.liquidity.rateLeg === 'RATES RISING — PRESSURE BUILDING'
      ? { role: 'pressure' as Role, text: `rising Treasury yields are the principal pressure signal`,
          because: `10Y ${i.liquidity.us10y?.toFixed(2)}%` }
    : i.liquidity.qe.active
      ? { role: 'pressure' as Role, text: 'the balance sheet is expanding at intervention scale',
          because: i.liquidity.qe.detail }
    : i.liquidity.regime === 'CONTRACTING'
      ? { role: 'pressure' as Role, text: 'liquidity is draining', because: `Fed balance sheet ${i.liquidity.walcl13wBn?.toFixed(0)}bn over 13 weeks` }
    : null;
  if (pressure) c.push(pressure);

  if (i.commoditiesLeading >= 3) {
    c.push({ role: 'commodities', text: 'commodities are leading broadly', because: `${i.commoditiesLeading} of four ahead of the S&P over six months` });
  }

  return { sentence: assemble(c), clauses: c };
}

/** Assemble by ROLE, not by position, so the grammar is fixed and cannot
 *  produce "X but Y and Z, but W". The shape is always:
 *
 *    <state clauses joined with "and">, but <credit>; <pressure>.
 *
 *  "but" appears at most once, at the single junction where the evidence
 *  genuinely conflicts — conditions versus what credit is doing. When
 *  credit agrees with the rest, the contrast is dropped and everything is
 *  joined plainly. */
function assemble(clauses: Clause[]): string {
  if (!clauses.length) return 'Not enough evidence to characterise conditions.';
  const by = (r: Role) => clauses.filter((x) => x.role === r).map((x) => x.text);

  const state = [...by('momentum'), ...by('drawdown'), ...by('valuation')];
  const credit = by('credit');
  const tail = [...by('pressure'), ...by('commodities')];

  // does credit contradict the state clauses, or agree with them?
  const stretched = state.some((t) => /stretched|parabolic|strong/.test(t));
  const creditCalm = credit.some((t) => /calm/.test(t));
  const contrast = stretched && creditCalm;

  const head = joinAnd(state);
  let body = head;
  if (credit.length) {
    body = head
      ? `${head}${contrast ? ', but ' : ', and '}${joinAnd(credit)}`
      : joinAnd(credit);
  }
  if (tail.length) body = body ? `${body}; ${joinAnd(tail)}` : joinAnd(tail);

  return body.charAt(0).toUpperCase() + body.slice(1) + '.';
}

/** Oxford-free join: "a", "a and b", "a, b and c". */
function joinAnd(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}
