// V2 panel logic: transmission map, supplier signal, Hunter cross,
// thesis test and data caveats.
//
// THE CENTRAL DISCIPLINE HERE is that an elevated AI Capital score is not
// a credit event and must never be rendered as one. Six companies
// spending heavily is a capital-cycle observation; transmission is that
// showing up in what lenders charge. So every credit node below is driven
// by credit data alone — the AI Capital score is deliberately NOT an
// input to any of them — and "confirmed" requires the credit nodes
// themselves to have moved.
//
// Everything is generated from the components and the series. No sentence
// in this file is a conclusion typed in advance; they are assembled from
// whichever readings are actually present, and they say UNKNOWN where a
// reading is missing rather than assuming it is benign.

import thresholds from '../../config/thresholds.json' with { type: 'json' };
import type { Point } from '../sources/types.ts';
import type { CompanyMetrics } from '../compute/ai-capital-metrics.ts';
import type { AiCapitalScore } from './ai-capital-score.ts';
import { COMPANIES } from '../registry/companies.ts';
import { latest, change } from './common.ts';

const T = thresholds.ai_transmission;
const TS = thresholds.ai_supplier;
const TH = thresholds.hunter_ai;

export type NodeState = 'GREEN' | 'AMBER' | 'RED' | 'UNKNOWN';

export interface TransmissionNode {
  id: string;
  label: string;
  state: NodeState;
  /** What the state was read from — shown under the node. */
  detail: string;
}

export interface Transmission {
  nodes: TransmissionNode[];
  status: 'NOT CONFIRMED' | 'EARLY SIGNS' | 'FORMING' | 'CONFIRMED' | 'UNKNOWN';
  explanation: string;
}

const bandOf = (level: number | null, widen: number | null, t: { level_amber: number; level_red: number; widen_60d_amber: number; widen_60d_red: number }): NodeState => {
  if (level === null) return 'UNKNOWN';
  if (level >= t.level_red || (widen !== null && widen >= t.widen_60d_red)) return 'RED';
  if (level >= t.level_amber || (widen !== null && widen >= t.widen_60d_amber)) return 'AMBER';
  return 'GREEN';
};

/** Spreads are STORED IN PERCENT (5.5 means 550bp), so a move of 0.5
 *  percentage points is 50bp. Stated explicitly because mixing the two is
 *  the unit error that already produced one wrong reading in V1. */
const toBp = (pctPoints: number) => pctPoints * 100;

/** One credit node from its spread series. */
function creditNode(
  id: string, label: string, seriesId: string, m: Map<string, Point[]>,
  t: { level_amber: number; level_red: number; widen_60d_amber: number; widen_60d_red: number },
): TransmissionNode {
  const pts = m.get(seriesId) ?? [];
  const cur = latest(pts);
  if (!cur) {
    return { id, label, state: 'UNKNOWN', detail: `No ${label} spread data — UNKNOWN, which is not the same as calm.` };
  }
  const w60 = change(pts, 60);
  const state = bandOf(cur.value, w60, t);
  return {
    id, label, state,
    detail: `${toBp(cur.value).toFixed(0)}bp on ${cur.date}`
      + (w60 === null
        ? ', 60-day change unavailable'
        : `, ${w60 >= 0 ? '+' : ''}${toBp(w60).toFixed(0)}bp over 60 days`),
  };
}

/** The AI CREDIT node: the deployers' own borrowing, from their filings.
 *
 *  Named carefully. There is no traded "AI credit" index, and inventing a
 *  proxy from equity or spread data would be exactly the sort of fabricated
 *  number this system is built to avoid. What CAN be measured from the
 *  filings is how much the build-out is being funded with debt, so that is
 *  what this node reports, and the label says so. */
function aiCreditNode(all: Map<string, CompanyMetrics>): TransmissionNode {
  const dep = COMPANIES.filter((c) => c.role === 'deployer')
    .map((c) => all.get(c.ticker)).filter((x): x is CompanyMetrics => !!x);
  const nd = dep.map((m) => m.measures.net_debt_to_ocf?.value).filter((v): v is number => typeof v === 'number');
  if (!nd.length) {
    return {
      id: 'ai_credit', label: 'AI CREDIT', state: 'UNKNOWN',
      detail: 'Borrowings against operating cash flow could not be read for any deployer — UNKNOWN, not calm.',
    };
  }
  const worst = Math.max(...nd);
  const t = T.ai_credit;
  const state: NodeState = worst >= t.net_debt_ocf_red ? 'RED' : worst >= t.net_debt_ocf_amber ? 'AMBER' : 'GREEN';
  const who = dep.find((m) => m.measures.net_debt_to_ocf?.value === worst)?.ticker ?? '';
  return {
    id: 'ai_credit', label: 'AI CREDIT', state,
    detail: `Issuer leverage, not a traded spread: highest net debt / operating cash flow is ${who} at ${worst.toFixed(2)}x`
      + ` (${nd.length}/${dep.length} deployers readable).`,
  };
}

export function transmissionMap(
  ai: AiCapitalScore, all: Map<string, CompanyMetrics>, m: Map<string, Point[]>,
): Transmission {
  // The first node is the capital-cycle reading; every node after it is
  // credit. The AI Capital score deliberately does NOT feed the credit
  // nodes — if it did, this panel would confirm its own premise.
  const capital: TransmissionNode = {
    id: 'ai_capital', label: 'AI CAPITAL',
    state: ai.status === 'UNKNOWN' ? 'UNKNOWN'
      : ai.score >= 3.5 ? 'RED' : ai.score >= 2.5 ? 'AMBER' : 'GREEN',
    detail: `${ai.status} — ${ai.score.toFixed(1)}/5 from company filings, evidence ${ai.evidenceAvailable}/${ai.evidenceTotal}.`,
  };
  const nodes: TransmissionNode[] = [
    capital,
    aiCreditNode(all),
    creditNode('ccc', 'CCC', 'ccc_oas', m, T.ccc),
    creditNode('bb', 'BB/B', 'bb_oas', m, T.bb),
    creditNode('hy', 'HY', 'hy_oas', m, T.hy),
    creditNode('ig', 'IG', 'ig_oas', m, T.ig),
  ];

  // Only the market credit nodes decide the status. `ai_credit` is the
  // issuers' own balance sheets, which is the mechanism rather than the
  // evidence, and `ai_capital` is the premise.
  const market = nodes.filter((n) => ['ccc', 'bb', 'hy', 'ig'].includes(n.id));
  const reds = market.filter((n) => n.state === 'RED');
  const ambers = market.filter((n) => n.state === 'AMBER');
  const unknowns = market.filter((n) => n.state === 'UNKNOWN');
  const c = T.confirmation;

  let status: Transmission['status'];
  let explanation: string;

  if (unknowns.length === market.length) {
    status = 'UNKNOWN';
    explanation = 'No credit spread data is available, so whether capital stress is reaching credit markets cannot be assessed. That is not the same as it being calm.';
  } else if (reds.length >= c.confirmed_min_red) {
    status = 'CONFIRMED';
    explanation = `${reds.map((n) => n.label).join(' and ')} are at stressed levels. Deteriorating capital economics and deteriorating credit are now visible together.`;
  } else if (reds.length === 1 || ambers.length >= c.forming_min_amber) {
    status = 'FORMING';
    explanation = `${[...reds, ...ambers].map((n) => n.label).join(', ')} ${reds.length + ambers.length === 1 ? 'is' : 'are'} off their calm levels. Not yet a broad credit move, but the first place one would appear.`;
  } else if (ambers.length === 1) {
    status = 'EARLY SIGNS';
    explanation = `${ambers[0].label} has moved off its calm level while the rest of the ladder has not. One node is noise more often than it is a signal.`;
  } else {
    status = 'NOT CONFIRMED';
    explanation = capital.state === 'GREEN'
      ? 'Neither capital economics nor credit markets are showing stress.'
      : `Capital intensity is elevated, but ${market.filter((n) => n.state === 'GREEN').map((n) => n.label).join(', ')} remain at calm levels. `
        + 'Elevated spending has not shown up in the price of credit.';
  }
  if (unknowns.length && unknowns.length < market.length) {
    explanation += ` ${unknowns.map((n) => n.label).join(', ')} unavailable — read as unknown, not calm.`;
  }
  return { nodes, status, explanation };
}

// ── supplier signal ───────────────────────────────────────────────────

export type SupplierState = 'ALIGNED' | 'SUPPLIER LAGGING' | 'SUPPLIER DIVERGENCE' | 'UNKNOWN';

export interface SupplierSignal {
  state: SupplierState;
  supplierTicker: string;
  supplierGrowth: number | null;
  deployerCapexGrowth: number | null;
  gap: number | null;
  explanation: string;
}

export function supplierSignal(all: Map<string, CompanyMetrics>): SupplierSignal {
  const sup = COMPANIES.find((c) => c.role === 'supplier')!;
  const s = all.get(sup.ticker);
  const supplierGrowth = s?.measures.revenue_growth_yoy?.value ?? null;

  const dep = COMPANIES.filter((c) => c.role === 'deployer')
    .map((c) => all.get(c.ticker)).filter((x): x is CompanyMetrics => !!x);
  let now = 0, prior = 0, n = 0;
  for (const m of dep) {
    const a = m.measures.ttm_capex?.value;
    const b = m.measures.ttm_capex_prior?.value;
    if (typeof a === 'number' && typeof b === 'number') { now += a; prior += b; n++; }
  }
  const deployerCapexGrowth = n && prior > 0 ? now / prior - 1 : null;

  if (supplierGrowth === null || deployerCapexGrowth === null) {
    return {
      state: 'UNKNOWN', supplierTicker: sup.ticker, supplierGrowth, deployerCapexGrowth, gap: null,
      explanation: `Either ${sup.ticker} revenue growth or aggregate deployer capex growth is unavailable, so the supplier signal cannot be read.`,
    };
  }
  const gap = supplierGrowth - deployerCapexGrowth;
  const pct = (v: number) => `${(v * 100).toFixed(0)}%`;
  const pp = `${Math.abs(gap * 100).toFixed(0)}pp`;

  if (Math.abs(gap) <= TS.aligned_within) {
    return {
      state: 'ALIGNED', supplierTicker: sup.ticker, supplierGrowth, deployerCapexGrowth, gap,
      explanation: `${sup.ticker} revenue ${pct(supplierGrowth)} against deployer capex ${pct(deployerCapexGrowth)} — ${pp} apart. `
        + 'Supplier and buyers moving together is what a functioning capital cycle looks like, and is the reading that would break first if demand were rolling over.',
    };
  }
  if (gap <= -TS.lagging_gap) {
    return {
      state: 'SUPPLIER LAGGING', supplierTicker: sup.ticker, supplierGrowth, deployerCapexGrowth, gap,
      explanation: `Deployer capex is growing ${pct(deployerCapexGrowth)} while ${sup.ticker} revenue grows only ${pct(supplierGrowth)} — a ${pp} shortfall. `
        + 'Spending rising faster than the supplier’s book means the money is going somewhere other than chips.',
    };
  }
  if (gap >= TS.divergence_gap) {
    return {
      state: 'SUPPLIER DIVERGENCE', supplierTicker: sup.ticker, supplierGrowth, deployerCapexGrowth, gap,
      explanation: `${sup.ticker} revenue is growing ${pct(supplierGrowth)} while its customers’ capex grows ${pct(deployerCapexGrowth)} — a ${pp} gap. `
        + 'The supplier out-running the buyers is the shape a capital cycle makes when orders have been pulled forward.',
    };
  }
  return {
    state: 'ALIGNED', supplierTicker: sup.ticker, supplierGrowth, deployerCapexGrowth, gap,
    explanation: `${sup.ticker} revenue ${pct(supplierGrowth)} against deployer capex ${pct(deployerCapexGrowth)} — ${pp} apart, inside the range that counts as moving together.`,
  };
}

// ── Hunter × AI Capital ───────────────────────────────────────────────

export type HunterAiState = 'NO CONNECTION' | 'EARLY WATCH' | 'TRANSMISSION FORMING' | 'BUST TRANSMISSION CONFIRMED';

export interface HunterAi {
  state: HunterAiState;
  explanation: string;
  inputs: { label: string; value: string }[];
}

export function hunterCross(
  ai: AiCapitalScore,
  meltup: number | null,
  creditScore: number | null,
  bustOnset: number | null,
  liquidityRegime: string | null,
  tr: Transmission,
): HunterAi {
  const inputs = [
    { label: 'Melt-Up Score', value: meltup === null ? 'UNKNOWN' : `${meltup.toFixed(1)}/5` },
    { label: 'AI Capital Stress', value: ai.status === 'UNKNOWN' ? 'UNKNOWN' : `${ai.score.toFixed(1)}/5 ${ai.status}` },
    { label: 'Credit Canary', value: creditScore === null ? 'UNKNOWN' : `${creditScore.toFixed(1)}/5` },
    { label: 'Rates / Liquidity', value: liquidityRegime ?? 'UNKNOWN' },
    { label: 'Bust Onset', value: bustOnset === null ? 'UNKNOWN' : `${bustOnset.toFixed(1)}/5` },
  ];

  if (ai.status === 'UNKNOWN') {
    return { state: 'NO CONNECTION', inputs,
      explanation: 'No company filings have been read, so there is nothing to connect to the macro picture yet.' };
  }

  const credit = creditScore ?? 0;
  const onset = bustOnset ?? 0;

  // CONFIRMED needs credit to have actually moved — in the ladder AND in
  // the broad credit score AND with equity onset evidence. An elevated
  // capital score on its own can never reach this state, which is the
  // whole point of the matrix.
  if (tr.status === 'CONFIRMED' && credit >= TH.confirmed_credit_score && onset >= TH.confirmed_bust_onset) {
    return { state: 'BUST TRANSMISSION CONFIRMED', inputs,
      explanation: `AI capital stress at ${ai.score.toFixed(1)}/5 alongside stressed speculative credit, a broad credit score of ${credit.toFixed(1)}/5 and equity onset evidence at ${onset.toFixed(1)}/5. All three legs are present.` };
  }
  if (ai.score >= TH.forming_ai_score && (tr.status === 'FORMING' || tr.status === 'CONFIRMED' || credit >= TH.forming_credit_score)) {
    return { state: 'TRANSMISSION FORMING', inputs,
      explanation: `AI capital stress at ${ai.score.toFixed(1)}/5 and credit beginning to move (${tr.status.toLowerCase()}, broad credit ${credit.toFixed(1)}/5). The link is appearing but is not yet broad.` };
  }
  if (ai.score >= TH.watch_ai_score) {
    return { state: 'EARLY WATCH', inputs,
      explanation: `AI capital stress is ${ai.status.toLowerCase()} at ${ai.score.toFixed(1)}/5, but the Credit Canary is ${credit.toFixed(1)}/5 and transmission is ${tr.status.toLowerCase()}. `
        + 'Stretched capital spending with calm credit is a watch condition, not a bust: the mechanism that would carry it into markets has not engaged.' };
  }
  return { state: 'NO CONNECTION', inputs,
    explanation: `AI capital stress is ${ai.score.toFixed(1)}/5 and credit is calm. Neither leg of a capital-to-credit transmission is present.` };
}

// ── Noble / Chanos thesis test ────────────────────────────────────────

export interface ThesisTest {
  supporting: string[];
  contradicting: string[];
  verdict: string;
}

export function thesisTest(
  ai: AiCapitalScore, all: Map<string, CompanyMetrics>, sup: SupplierSignal, tr: Transmission,
): ThesisTest {
  const supporting = [...ai.supporting];
  const contradicting = [...ai.contradicting];

  // Company-level evidence, stated per company rather than in aggregate,
  // because "several deployers" is the claim and the names are the test.
  const dep = COMPANIES.filter((c) => c.role === 'deployer')
    .map((c) => all.get(c.ticker)).filter((x): x is CompanyMetrics => !!x);

  const burners = dep.filter((m) => (m.measures.capex_to_ocf?.value ?? 0) > 1);
  if (burners.length) {
    supporting.push(`${burners.map((m) => m.ticker).join(' and ')} spent more on capital than ${burners.length > 1 ? 'they' : 'it'} generated in operating cash over the trailing year.`);
  }
  const negFcf = dep.filter((m) => (m.measures.incr_fcf_on_capital?.value ?? 1) < 0);
  if (negFcf.length >= 2) {
    supporting.push(`Incremental free cash flow per additional dollar of capital is negative at ${negFcf.map((m) => m.ticker).join(', ')} — the build-out is consuming cash faster than it is returning it.`);
  }
  const strong = dep.filter((m) => (m.measures.incr_opinc_on_capital?.value ?? -1) >= 0.15);
  if (strong.length) {
    contradicting.push(`${strong.map((m) => m.ticker).join(' and ')} ${strong.length > 1 ? 'are' : 'is'} still earning 15% or more in incremental operating income per additional dollar of capital.`);
  }
  const selfFunded = dep.filter((m) => {
    const nd = m.measures.net_debt_to_ocf?.value;
    return typeof nd === 'number' && nd < 0.5;
  });
  if (selfFunded.length >= 3) {
    contradicting.push(`${selfFunded.map((m) => m.ticker).join(', ')} carry net debt below 0.5x operating cash flow — the spending is coming from cash, not from lenders.`);
  }
  // The supplier reading is NOT added here. It is already one of the five
  // scored components, so pushing the panel's wording of it as well listed
  // the same fact twice under two different sentences — which reads as two
  // independent pieces of evidence when it is one.
  if (tr.status === 'NOT CONFIRMED' || tr.status === 'EARLY SIGNS') {
    contradicting.push(`Credit transmission is ${tr.status.toLowerCase()}: ${tr.explanation}`);
  } else if (tr.status === 'FORMING' || tr.status === 'CONFIRMED') {
    supporting.push(`Credit transmission is ${tr.status.toLowerCase()}: ${tr.explanation}`);
  }

  // The verdict is assembled from which side actually has evidence — it is
  // not a stored sentence, and it must not read as a call either way.
  const nSup = supporting.length;
  const nCon = contradicting.length;
  const verdict = ai.status === 'UNKNOWN'
    ? 'No company filings have been read yet, so the thesis can be neither supported nor contradicted.'
    : `${nSup} reading${nSup === 1 ? '' : 's'} support the thesis and `
      + `${nCon} contradict it. `
      + (tr.status === 'CONFIRMED'
        ? 'Capital stress and credit stress are now visible together.'
        : sup.state === 'ALIGNED'
          ? 'Capital intensity and funding requirements are elevated, but supplier demand remains consistent with hyperscaler spending. An AI-capex downturn is not yet confirmed.'
          : 'Capital intensity is elevated and the supplier signal has moved, but broad credit has not confirmed it.');

  return { supporting, contradicting, verdict };
}

// ── data caveats ──────────────────────────────────────────────────────

export interface Caveat { ticker: string | null; text: string }

/** Accounting comparability limits, generated from what was actually
 *  extracted rather than from a stored list, so they cannot drift out of
 *  date when a company changes its tagging. */
export function dataCaveats(all: Map<string, CompanyMetrics>, missing: { ticker: string; concept_id: string; reason: string }[]): Caveat[] {
  const out: Caveat[] = [];
  for (const c of COMPANIES) {
    const m = all.get(c.ticker);
    if (!m) continue;
    const basis = m.measures.incr_opinc_on_capital?.basisNote ?? '';
    if (/net of depreciation/.test(basis)) {
      out.push({ ticker: c.ticker, text: 'Incremental return computed on NET property, not gross — this company does not tag a gross figure at both period ends. Not directly comparable with the companies measured on the gross base.' });
    }
    const nd = m.measures.net_debt?.basisNote ?? '';
    if (/Balance sheet as of/.test(nd)) out.push({ ticker: c.ticker, text: nd });
    for (const id of ['ttm_da', 'capex_to_da'] as const) {
      const meas = m.measures[id];
      if (meas && meas.value === null && id === 'capex_to_da') {
        out.push({ ticker: c.ticker, text: `Capex / D&A unavailable: ${meas.unknown ?? 'depreciation could not be assembled for four consecutive quarters'}` });
      }
    }
  }
  const cip = missing.filter((x) => x.concept_id === 'cip');
  if (cip.length) {
    out.push({ ticker: null, text: `Construction in progress is NOT DISCLOSED by ${cip.map((x) => x.ticker).join(', ')} — recorded as unknown and never estimated.` });
  }
  out.push({ ticker: null, text: 'None of these companies discloses AI-specific capital expenditure. Every capex figure here is TOTAL capex, and no AI share is estimated.' });
  return out;
}
