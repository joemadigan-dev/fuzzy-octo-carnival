// THE AI CAPITAL STRESS SCORE — 0 to 5, five components, each worth at
// most 1, each carrying the sentence and the number behind it.
//
// WHAT THIS IS NOT. It is not a bubble detector, and it does not assume a
// bubble exists. The brief is explicit that the score must permit the
// Noble/Chanos thesis to be WRONG, and a score that can only ever count
// evidence FOR a proposition is not a measurement of it. So every
// component below has two thresholds: one above which it contributes
// stress, and one below which it reports, in as many words, that the
// evidence points the other way. A company funding a large build-out from
// surplus cash at a healthy incremental return scores zero here AND says
// why — which is a finding, not a silence.
//
// The five components, in the order the evidence would actually move:
//
//   1 INTENSITY    how much is being spent, and how fast that is growing
//                  relative to the revenue it serves
//   2 FUNDING      whether operating cash flow covers it
//   3 RETURNS      what each additional dollar of capital is earning —
//                  the claim itself
//   4 FINANCING    whether the build-out is moving onto borrowed money,
//                  which is the only way this reaches credit markets
//   5 DIVERGENCE   supplier against buyers, the first thing to move when
//                  a capital cycle turns
//
// Components 1 and 2 can be high in a perfectly healthy boom. Alone they
// are not stress, and the wording says so. It is 3 and 4 together that
// carry the thesis, and 5 that would time it.
//
// UNKNOWN IS NOT ZERO. A component with no data contributes 0 and is
// flagged unknown, so an incomplete reading is low AND visibly incomplete
// rather than being renormalised into false confidence. Quarterly data
// goes stale between filings; that is reported as an age, not hidden.

import thresholds from '../../config/thresholds.json' with { type: 'json' };
import { build, noData, type Component, type Score } from './common.ts';
import type { CompanyMetrics, Measure } from '../compute/aicapital.ts';
import { COMPANIES, byTicker } from '../registry/companies.ts';

const T = thresholds.ai_capital;

const pct = (m: Measure | undefined): string =>
  m?.value === null || m?.value === undefined ? '—' : `${(m.value * 100).toFixed(0)}%`;
const x = (m: Measure | undefined): string =>
  m?.value === null || m?.value === undefined ? '—' : `${m.value.toFixed(2)}x`;

/** Mean of the available values, or null when none are. Deliberately not
 *  zero-filled: averaging a missing company in as zero would drag every
 *  aggregate toward calm.
 *
 *  Used ONLY for quantities that are not commensurable across companies —
 *  chiefly incremental returns, whose denominators are on a gross basis
 *  for some companies and a net basis for others and so must not be added
 *  together. Anything measured in dollars uses `share` instead. */
function mean(vals: (number | null | undefined)[]): { value: number | null; n: number; of: number } {
  const ok = vals.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  return { value: ok.length ? ok.reduce((a, b) => a + b, 0) / ok.length : null, n: ok.length, of: vals.length };
}

/** A GROUP RATIO: total dollars over total dollars, across the companies
 *  where both sides are available.
 *
 *  This is not interchangeable with averaging the companies' own ratios,
 *  and the difference is not small. Oracle spends 105% of its revenue on
 *  capital and Amazon 22%; the mean of the five deployers' ratios is 46%,
 *  while the group actually spends 32% of its revenue. The mean answers
 *  "what does the typical company do", which is not the question a
 *  sector-level capital-cycle reading is asking, and it overstates the
 *  finding by half. Both sides must come from the same companies, or the
 *  ratio compares one group's spending with another group's revenue. */
function share(
  rows: CompanyMetrics[], numId: string, denId: string,
): { value: number | null; n: number; of: number; num: number; den: number } {
  let num = 0; let den = 0; let n = 0;
  for (const m of rows) {
    const a = val(m, numId);
    const b = val(m, denId);
    if (a === null || b === null) continue;
    num += a; den += b; n++;
  }
  return { value: n && Math.abs(den) > 1e-9 ? num / den : null, n, of: rows.length, num, den };
}

/** Year-on-year growth of a group total, both years from the same set. */
function groupGrowth(rows: CompanyMetrics[], nowId: string, priorId: string) {
  return share(rows, nowId, priorId).value === null
    ? { value: null as number | null, n: 0, of: rows.length }
    : (() => { const s = share(rows, nowId, priorId); return { value: s.value! - 1, n: s.n, of: s.of }; })();
}

/** The deployers only. Nvidia is the supplier: its revenue is the mirror
 *  image of their spending, so including it in a capex-intensity average
 *  would net the two sides of the same transaction against each other. */
const deployersOf = (all: Map<string, CompanyMetrics>) =>
  COMPANIES.filter((c) => c.role === 'deployer').map((c) => all.get(c.ticker)).filter((m): m is CompanyMetrics => !!m);

const val = (m: CompanyMetrics | undefined, id: string): number | null => m?.measures[id]?.value ?? null;

// ── 1. INTENSITY ──────────────────────────────────────────────────────

function intensity(all: Map<string, CompanyMetrics>): Component {
  const dep = deployersOf(all);
  const ci = share(dep, 'ttm_capex', 'ttm_revenue');
  const capexG = groupGrowth(dep, 'ttm_capex', 'ttm_capex_prior');
  const revG = groupGrowth(dep, 'ttm_revenue', 'ttm_revenue_prior');
  const gap = capexG.value === null || revG.value === null ? null : capexG.value - revG.value;
  if (ci.value === null) return noData('Capex intensity across the deployers');

  const t = T.intensity;
  const ciPct = `${(ci.value * 100).toFixed(0)}%`;
  const gapPct = gap === null ? '—' : `${(gap * 100).toFixed(0)}pp`;
  // Partial evidence is reported on EVERY branch, not only the alarming
  // ones. A reassuring sentence built on three of five companies is the
  // more dangerous place to omit the count, not the less.
  const cover = ci.n < ci.of ? ` (${ci.n}/${ci.of} companies.)` : '';

  if (ci.value >= t.capex_to_revenue_extreme || (gap ?? 0) >= t.capex_growth_gap_extreme) {
    return { delta: 1, reason:
      `The deployers together spend ${ciPct} of their revenue on physical assets, and their combined capex is growing `
      + `${gapPct} faster than their combined revenue.${cover} A build-out expanding far faster than the revenue it `
      + `serves is the precondition for the thesis — not, on its own, evidence that returns have failed.` };
  }
  if (ci.value >= t.capex_to_revenue_elevated || (gap ?? 0) >= t.capex_growth_gap_elevated) {
    return { delta: 0.5, reason:
      `The deployers together spend ${ciPct} of their revenue on physical assets, with combined capex growing ${gapPct} `
      + `faster than combined revenue.${cover} Elevated against their own history, but a large capital programme is `
      + `normal in a genuine technology build-out.` };
  }
  if (ci.value <= t.capex_to_revenue_contradicts) {
    return { delta: 0, reason:
      `Combined capex is ${ciPct} of combined revenue — below the ${(t.capex_to_revenue_contradicts * 100).toFixed(0)}% `
      + `level that would mark an unusual build-out at all.${cover} EVIDENCE AGAINST a capital-cycle excess.` };
  }
  return { delta: 0, reason:
    `Combined capex is ${ciPct} of combined revenue, within the range these companies have sustained before.${cover}` };
}

// ── 2. FUNDING ────────────────────────────────────────────────────────

function funding(all: Map<string, CompanyMetrics>): Component {
  const dep = deployersOf(all);
  const r = share(dep, 'ttm_capex', 'ttm_ocf');
  if (r.value === null) return noData('Capex against operating cash flow');

  const t = T.funding;
  const over = dep.filter((m) => (val(m, 'capex_to_ocf') ?? 0) >= t.capex_to_ocf_extreme)
    .map((m) => m.ticker);
  const asPct = `${(r.value * 100).toFixed(0)}%`;
  const cover = r.n < r.of ? ` (${r.n}/${r.of} companies.)` : '';

  if (over.length >= 2 || r.value >= t.capex_to_ocf_extreme) {
    return { delta: 1, reason:
      `Combined capex is ${asPct} of the deployers' combined operating cash flow`
      + (over.length ? `, and exceeds it outright at ${over.join(', ')}` : '')
      + `.${cover} Spending beyond the cash the business generates has to be funded from the balance sheet or from lenders.` };
  }
  if (r.value >= t.capex_to_ocf_elevated || over.length === 1) {
    return { delta: 0.5, reason:
      `Combined capex is ${asPct} of combined operating cash flow`
      + (over.length ? `, exceeding it at ${over[0]}` : '')
      + `.${cover} Still covered in aggregate, but the margin between what is spent and what is earned in cash is thin.` };
  }
  if (r.value <= t.capex_to_ocf_contradicts) {
    return { delta: 0, reason:
      `Combined capex is ${asPct} of combined operating cash flow — the build-out is comfortably self-funded. `
      + `EVIDENCE AGAINST the claim that this spending depends on external finance.${cover}` };
  }
  return { delta: 0, reason:
    `Combined capex is ${asPct} of combined operating cash flow, covered by the cash the businesses generate.${cover}` };
}

// ── 3. RETURNS — the thesis itself ────────────────────────────────────

function returns(all: Map<string, CompanyMetrics>): Component {
  const dep = deployersOf(all);
  const inc = mean(dep.map((m) => val(m, 'incr_opinc_on_capital')));
  const fcf = mean(dep.map((m) => val(m, 'incr_fcf_on_capital')));
  if (inc.value === null) {
    return noData('Incremental operating income per additional dollar of capital');
  }

  const t = T.returns;
  const thin = dep.filter((m) => {
    const v = val(m, 'incr_opinc_on_capital');
    return v !== null && v < t.incr_return_thin;
  }).map((m) => m.ticker);
  const avg = `${(inc.value * 100).toFixed(0)}%`;
  const fcfNote = fcf.value === null ? ''
    : ` Incremental free cash flow on the same capital is ${(fcf.value * 100).toFixed(0)}%.`;
  const cover = inc.n < inc.of ? ` (${inc.n} of ${inc.of} deployers; the rest do not tag a capital base at both period ends.)` : '';

  if (inc.value < t.incr_return_negative) {
    return { delta: 1, reason:
      `Each additional dollar of capital is associated with LESS operating income than a year ago (${avg}).${fcfNote} `
      + `This is the central claim of the thesis, and it is what the filings currently show.${cover}` };
  }
  if (inc.value < t.incr_return_thin) {
    return { delta: 1, reason:
      `Incremental operating income is ${avg} per additional dollar of capital — below any plausible cost of that `
      + `capital, so the marginal spending is not currently covering its own financing cost.${fcfNote}${cover}` };
  }
  if (thin.length >= 2) {
    return { delta: 0.5, reason:
      `Incremental return averages ${avg}, but is below ${(t.incr_return_thin * 100).toFixed(0)}% at ${thin.join(', ')}. `
      + `The aggregate is held up by the stronger names rather than being broad.${fcfNote}${cover}` };
  }
  if (inc.value >= t.incr_return_contradicts) {
    return { delta: 0, reason:
      `Each additional dollar of capital is earning ${avg} more operating income than a year ago — above the `
      + `${(t.incr_return_contradicts * 100).toFixed(0)}% mark, and above a normal cost of capital.${fcfNote} `
      + `EVIDENCE AGAINST the claim that this capital is being destroyed.${cover}` };
  }
  return { delta: 0.5, reason:
    `Incremental return is ${avg} per additional dollar of capital — positive, but not clearly above what the `
    + `capital costs.${fcfNote}${cover}` };
}

// ── 4. FINANCING — the only route to credit ───────────────────────────

function financing(all: Map<string, CompanyMetrics>): Component {
  const dep = deployersOf(all);
  const nd = dep.map((m) => ({ t: m.ticker, v: val(m, 'net_debt_to_ocf') }))
    .filter((r): r is { t: string; v: number } => r.v !== null);
  if (!nd.length) return noData('Net debt against operating cash flow');

  const t = T.financing;
  const worst = nd.reduce((a, b) => (b.v > a.v ? b : a));
  const stressed = nd.filter((r) => r.v >= t.net_debt_to_ocf_elevated);
  const avg = nd.reduce((s, r) => s + r.v, 0) / nd.length;
  const cover = nd.length < dep.length ? ` (${nd.length} of ${dep.length} deployers.)` : '';

  if (stressed.length >= 2 || worst.v >= t.net_debt_to_ocf_extreme) {
    return { delta: 1, reason:
      `${worst.t} carries net debt of ${worst.v.toFixed(2)}x operating cash flow`
      + (stressed.length >= 2 ? `, and ${stressed.length} deployers are above ${t.net_debt_to_ocf_elevated}x` : '')
      + `. Borrowed money funding the build-out is the mechanism by which a capital-spending problem becomes `
      + `a credit problem — without it there is no transmission.${cover}` };
  }
  if (stressed.length === 1) {
    return { delta: 0.5, reason:
      `${worst.t} is financing its build-out with borrowings at ${worst.v.toFixed(2)}x operating cash flow, against `
      + `an average of ${avg.toFixed(2)}x across the deployers. One name, not the group.${cover}` };
  }
  if (avg <= t.net_debt_to_ocf_contradicts) {
    return { delta: 0, reason:
      `Deployers carry net debt of ${avg.toFixed(2)}x operating cash flow on average, the highest being ${worst.t} at `
      + `${worst.v.toFixed(2)}x. The build-out is being funded from cash, not credit. EVIDENCE AGAINST a `
      + `transmission channel into credit markets.${cover}` };
  }
  return { delta: 0, reason:
    `Net debt averages ${avg.toFixed(2)}x operating cash flow, highest at ${worst.t} (${worst.v.toFixed(2)}x) — `
    + `within the range these balance sheets have carried before.${cover}` };
}

// ── 5. DIVERGENCE — supplier against buyers ───────────────────────────

function divergence(all: Map<string, CompanyMetrics>): Component {
  const supplierTicker = COMPANIES.find((c) => c.role === 'supplier')!.ticker;
  const sup = all.get(supplierTicker);
  const supGrowth = val(sup, 'revenue_growth_yoy');
  const dep = deployersOf(all);
  const depCapex = groupGrowth(dep, 'ttm_capex', 'ttm_capex_prior');

  if (supGrowth === null || depCapex.value === null) {
    return noData(`${supplierTicker} revenue growth against deployer capex growth`);
  }

  const t = T.divergence;
  const gap = supGrowth - depCapex.value;
  const s = `${(supGrowth * 100).toFixed(0)}%`;
  const d = `${(depCapex.value * 100).toFixed(0)}%`;
  const g = `${(Math.abs(gap) * 100).toFixed(0)}pp`;

  if (gap >= t.divergence_gap_extreme) {
    return { delta: 1, reason:
      `${supplierTicker} revenue is growing ${s} while its customers' capex grows ${d} — a ${g} gap. `
      + `The supplier out-running the buyers is the shape a capital cycle makes when orders have been pulled `
      + `forward: it resolves either by the buyers spending more, or by the supplier's growth falling to meet them.` };
  }
  if (gap <= -t.divergence_gap_extreme) {
    return { delta: 1, reason:
      `Deployer capex is growing ${d} while ${supplierTicker} revenue grows ${s} — a ${g} gap the other way. `
      + `Spending rising faster than the supplier's book means the money is going somewhere other than chips.` };
  }
  if (Math.abs(gap) >= t.divergence_gap_elevated) {
    return { delta: 0.5, reason:
      `${supplierTicker} revenue is growing ${s} against deployer capex at ${d}, a gap of ${g}. `
      + `Worth watching: supplier and buyers normally move together, and the supplier turns first.` };
  }
  if (Math.abs(gap) <= t.aligned_contradicts) {
    return { delta: 0, reason:
      `${supplierTicker} revenue (${s}) and deployer capex (${d}) are moving together, ${g} apart. `
      + `Supplier and buyers in step is what a functioning capital cycle looks like. `
      + `EVIDENCE AGAINST a turn having begun.` };
  }
  return { delta: 0, reason:
    `${supplierTicker} revenue is growing ${s} against deployer capex at ${d} — broadly in step.` };
}

// ── assembly ──────────────────────────────────────────────────────────

export type AiStatus = 'NO SIGNAL' | 'WATCH' | 'ELEVATED' | 'STRESS' | 'CRITICAL' | 'UNKNOWN';

export interface AiCapitalScore extends Score {
  status: AiStatus;
  /** Newest period end across the companies, and the oldest — the honest
   *  bound on how current any of this is. */
  newestPeriod: string | null;
  oldestPeriod: string | null;
  /** Components that positively CONTRADICT the thesis, for §19's
   *  supporting-vs-contradicting panel. */
  contradicting: string[];
  supporting: string[];
}

export function aiCapitalStatus(score: number, evidenceAvailable: number): AiStatus {
  if (evidenceAvailable === 0) return 'UNKNOWN';
  const t = T.status;
  if (score >= 4.5) return 'CRITICAL';
  if (score >= t.stress) return 'STRESS';
  if (score >= t.elevated) return 'ELEVATED';
  if (score >= t.watch) return 'WATCH';
  return 'NO SIGNAL';
}

export function scoreAiCapital(all: Map<string, CompanyMetrics>): AiCapitalScore {
  const components = [intensity(all), funding(all), returns(all), financing(all), divergence(all)];
  const s = build(components, 5);

  const periods = [...all.values()].map((m) => m.periodEnd).filter((p): p is string => !!p).sort();

  // A component only counts as contradicting when it says so in terms.
  // "Nothing triggered" is not evidence against a claim; a measured value
  // on the far side of a stated threshold is.
  const contradicting = components.filter((c) => /EVIDENCE AGAINST/.test(c.reason)).map((c) => c.reason);
  const supporting = components.filter((c) => !c.unknown && c.delta > 0).map((c) => c.reason);

  return {
    ...s,
    status: aiCapitalStatus(s.score, s.evidenceAvailable),
    newestPeriod: periods.length ? periods[periods.length - 1] : null,
    oldestPeriod: periods.length ? periods[0] : null,
    contradicting,
    supporting,
  };
}

/** The one line that goes under Market Setup. Deliberately a LINE, not a
 *  sixth card — §11 of the brief is explicit that the five-card cockpit is
 *  not to be redesigned. */
export function aiCapitalLine(s: AiCapitalScore, today: string): string {
  if (s.status === 'UNKNOWN' || s.newestPeriod === null) {
    return 'AI CAPITAL: UNKNOWN — no company filings have been ingested yet.';
  }
  const ageDays = Math.round((Date.parse(today) - Date.parse(s.newestPeriod)) / 86400000);
  const age = ageDays <= 120
    ? `most recent quarter ends ${s.newestPeriod}`
    : `most recent quarter ends ${s.newestPeriod}, ${Math.round(ageDays / 30)} months ago`;
  return `AI CAPITAL: ${s.status} (${s.score.toFixed(1)}/5, evidence ${s.evidenceAvailable}/${s.evidenceTotal}) — ${age}.`;
}

export { byTicker, pct, x };
