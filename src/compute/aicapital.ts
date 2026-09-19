// Capital-efficiency measures over the stored quarterly facts.
//
// THE QUESTION these are built to answer is not "is capex large" — it is
// obviously large, and largeness alone is not evidence of anything. It is
// whether the capital being deployed is producing incremental profit,
// incremental cash, or neither. A company can spend $100bn a year
// profitably for a decade; a company can also spend $100bn a year into a
// falling return on each additional dollar, and only the second is what
// the Noble/Chanos thesis actually claims. So the headline measures here
// are INCREMENTAL: change in trailing-twelve-month profit against the
// change in the capital base that produced it.
//
// WHAT IS DELIBERATELY NOT DONE. None of this identifies "AI capex" —
// none of these companies disclose it. Capex here is total capex, and the
// page says so. Estimating an AI share would be inventing the number the
// whole analysis turns on (§22).
//
// UNKNOWN IS NOT ZERO, and the arithmetic below is where that is easiest
// to violate: a missing quarter silently summing as zero would understate
// a TTM by up to a quarter of its value, and a near-zero denominator would
// turn a rounding error into a ratio of several thousand percent that
// reads like a finding. Both are refused outright.

export interface Quarter {
  periodEnd: string;
  value: number;
  basis: 'reported' | 'derived';
  accn: string;
  filed: string;
  form: string;
}

/** How a measure should be read. Declared rather than inferred: a ratio
 *  displayed as a level, or a dollar figure read as a percentage, is the
 *  class of bug that already produced one wrong reading in V1 — a
 *  market-cap-to-GDP ratio of 2.56 compared against a threshold of 160
 *  and reported as normal. Every number below says what it is. */
export type Unit = 'usd_bn' | 'ratio' | 'fraction';

/** A computed measure, or an explicit statement of why there isn't one. */
export interface Measure {
  value: number | null;
  unit: Unit;
  /** Populated when value is null. Shown to the reader verbatim. */
  unknown?: string;
  /** Quarters the number was built from, newest last. */
  periods?: string[];
  /** Set where the measure could be computed on more than one basis, to
   *  say which was actually used. */
  basisNote?: string;
}

/** SEC values are raw dollars. Everything displayed is billions. */
const BN = 1e9;

const known = (v: number, periods: string[], unit: Unit): Measure => ({ value: v, unit, periods });
const unknown = (why: string, unit: Unit): Measure => ({ value: null, unit, unknown: why });

/** Series as a period-keyed map, oldest first. */
export type Series = Quarter[];

const sorted = (s: Series): Series => [...s].sort((a, b) => a.periodEnd.localeCompare(b.periodEnd));

/** The four quarters ending at `periodEnd`, or null if any is absent.
 *
 *  Contiguity is checked by POSITION in the company's own quarter
 *  sequence, not by calendar arithmetic: Oracle's quarters end in
 *  February, May, August and November, Nvidia's on a Sunday 84–98 days
 *  apart. A calendar-offset check would reject both as gappy. */
export function trailingFour(s: Series, periodEnd: string): Series | null {
  const q = sorted(s);
  const i = q.findIndex((x) => x.periodEnd === periodEnd);
  if (i < 3) return null;
  const window = q.slice(i - 3, i + 1);
  // Reject a window that spans more than ~15 months: that is a gap in the
  // stored data dressed up as four consecutive quarters.
  const span = (Date.parse(window[3].periodEnd) - Date.parse(window[0].periodEnd)) / 86400000;
  if (span > 300) return null;
  return window;
}

/** Trailing-twelve-month sum of a flow, in $bn. All four quarters or
 *  nothing: three quarters summed and presented as a year understates it
 *  by a quarter, which is exactly the silent-zero failure being refused. */
export function ttm(s: Series, periodEnd: string, label: string): Measure {
  const w = trailingFour(s, periodEnd);
  if (!w) return unknown(`${label}: fewer than four consecutive quarters are available to ${periodEnd}.`, 'usd_bn');
  return known(w.reduce((a, x) => a + x.value, 0) / BN, w.map((x) => x.periodEnd), 'usd_bn');
}

/** Value of a stock at a period end. */
export function at(s: Series, periodEnd: string): Quarter | null {
  return sorted(s).find((x) => x.periodEnd === periodEnd) ?? null;
}

/** The newest period end at which EVERY given series has a value, or null.
 *  Used for balance-sheet items that are tagged on different cadences:
 *  taking each one's own newest date would pair borrowings from one
 *  quarter with cash from another and call the difference net debt. */
export function latestCommon(all: Series[]): string | null {
  if (!all.length || all.some((s) => !s.length)) return null;
  const sets = all.map((s) => new Set(s.map((x) => x.periodEnd)));
  const ends = [...sets[0]].filter((e) => sets.every((m) => m.has(e))).sort();
  return ends.length ? ends[ends.length - 1] : null;
}

/** The period end four quarters before `periodEnd` in this company's own
 *  sequence — the same fiscal quarter a year earlier. */
export function yearAgo(s: Series, periodEnd: string): string | null {
  const q = sorted(s);
  const i = q.findIndex((x) => x.periodEnd === periodEnd);
  return i >= 4 ? q[i - 4].periodEnd : null;
}

/** A ratio is refused when its denominator is too small to carry meaning.
 *
 *  Expressed relative to the SCALE of the quantity rather than as an
 *  absolute floor, because these companies differ by an order of
 *  magnitude and a fixed threshold would be wrong for most of them. A
 *  capital base that grew by less than 2% of itself has not meaningfully
 *  changed, and dividing a profit swing by it produces a number that
 *  looks like a return and is actually noise. */
const MIN_DENOM_FRACTION = 0.02;

export function incremental(
  numerator: Measure, numeratorPrior: Measure,
  denomNow: number | null, denomPrior: number | null,
  labels: { num: string; den: string },
): Measure {
  if (numerator.value === null) return unknown(numerator.unknown!, 'fraction');
  if (numeratorPrior.value === null) return unknown(`${labels.num} a year earlier is unavailable, so the change cannot be measured.`, 'fraction');
  if (denomNow === null || denomPrior === null) {
    return unknown(`${labels.den} is not available for both period ends, so incremental return cannot be computed.`, 'fraction');
  }
  const dNum = numerator.value - numeratorPrior.value;
  const dDen = (denomNow - denomPrior) / BN;
  const scale = Math.max(Math.abs(denomNow), Math.abs(denomPrior)) / BN;
  if (dDen <= 0) {
    return unknown(`${labels.den} did not grow over the year, so there is no incremental capital to earn a return on.`, 'fraction');
  }
  if (dDen < scale * MIN_DENOM_FRACTION) {
    return unknown(`${labels.den} grew by less than ${(MIN_DENOM_FRACTION * 100).toFixed(0)}% — too little to compute a meaningful incremental return.`, 'fraction');
  }
  return known(dNum / dDen, numerator.periods ?? [], 'fraction');
}

/** Simple ratio with the same refusal rules, for intensity measures. */
export function ratio(num: Measure, den: Measure, label: string, unit: Unit = 'fraction'): Measure {
  if (num.value === null) return unknown(num.unknown!, unit);
  if (den.value === null) return unknown(den.unknown!, unit);
  if (Math.abs(den.value) < 1e-9) return unknown(`${label}: denominator is zero.`, unit);
  return known(num.value / den.value, num.periods ?? [], unit);
}

/** Element-wise difference of two flows over the same quarters, used for
 *  free cash flow. Quarters present in only one side are dropped rather
 *  than treated as zero on the missing side. */
export function minus(a: Series, b: Series): Series {
  const bm = new Map(b.map((x) => [x.periodEnd, x]));
  return sorted(a).filter((x) => bm.has(x.periodEnd)).map((x) => {
    const y = bm.get(x.periodEnd)!;
    return {
      ...x,
      value: x.value - y.value,
      basis: (x.basis === 'derived' || y.basis === 'derived' ? 'derived' : 'reported') as 'reported' | 'derived',
    };
  });
}

export interface CompanyMetrics {
  ticker: string;
  periodEnd: string | null;
  /** Filing the newest facts came from, for the citation. */
  accn: string | null;
  filed: string | null;
  form: string | null;
  measures: Record<string, Measure>;
}

/**
 * All measures for one company at its newest complete quarter.
 *
 * `concepts` is keyed by concept id as stored. A concept that is absent
 * propagates as UNKNOWN through everything that needed it, and stops
 * there — it never becomes a zero contribution to a score.
 */
export function companyMetrics(ticker: string, concepts: Record<string, Series>): CompanyMetrics {
  const g = (id: string): Series => concepts[id] ?? [];
  const revenue = g('revenue');
  const capex = g('capex');
  const ocf = g('ocf');
  const opinc = g('operating_income');
  const da = g('da');
  const ppeGross = g('ppe_gross');
  const ppe = g('ppe');
  const debt = g('debt');
  const cash = g('cash');
  const fcf = minus(ocf, capex);

  // The reference quarter is the newest for which capex and revenue both
  // exist — the two every measure below depends on. Taking the newest
  // quarter of ANY concept would pick up a balance-sheet item filed
  // without the cash-flow statement and report a quarter whose headline
  // numbers are missing.
  const capexEnds = new Set(capex.map((x) => x.periodEnd));
  const candidates = sorted(revenue).filter((x) => capexEnds.has(x.periodEnd));
  const ref = candidates.length ? candidates[candidates.length - 1].periodEnd : null;

  const measures: Record<string, Measure> = {};
  if (!ref) {
    return { ticker, periodEnd: null, accn: null, filed: null, form: null, measures };
  }

  const prior = yearAgo(revenue, ref);

  const ttmCapex = ttm(capex, ref, 'Capital expenditure');
  const ttmRevenue = ttm(revenue, ref, 'Revenue');
  const ttmOcf = ttm(ocf, ref, 'Operating cash flow');
  const ttmOpinc = ttm(opinc, ref, 'Operating income');
  const ttmFcf = ttm(fcf, ref, 'Free cash flow');
  const ttmDa = ttm(da, ref, 'Depreciation & amortisation');

  measures.ttm_capex = ttmCapex;
  measures.ttm_revenue = ttmRevenue;
  measures.ttm_ocf = ttmOcf;
  measures.ttm_opinc = ttmOpinc;
  measures.ttm_fcf = ttmFcf;
  measures.ttm_da = ttmDa;

  // Capex intensity: what share of revenue is going into physical assets.
  measures.capex_intensity = ratio(ttmCapex, ttmRevenue, 'Capex intensity');
  // Capex against the cash actually generated. Above 1 means the building
  // programme is larger than operating cash flow — it is being financed.
  measures.capex_to_ocf = ratio(ttmCapex, ttmOcf, 'Capex / operating cash flow');
  // Capex against depreciation: how fast the asset base is growing
  // relative to the rate at which the existing one is being written off.
  measures.capex_to_da = ratio(ttmCapex, ttmDa, 'Capex / D&A', 'ratio');

  if (prior) {
    const pOpinc = ttm(opinc, prior, 'Operating income');
    const pOcf = ttm(ocf, prior, 'Operating cash flow');
    const pFcf = ttm(fcf, prior, 'Free cash flow');
    const pRev = ttm(revenue, prior, 'Revenue');
    const pCapex = ttm(capex, prior, 'Capital expenditure');

    // The year-earlier levels are published alongside the current ones, not
    // just consumed here. Group readings — what the deployers spend as a
    // SHARE of what they earn — have to be computed by summing the dollars
    // and then dividing, not by averaging five companies' ratios: an
    // equal-weighted mean of Oracle's 105% with Amazon's 22% says the group
    // spends 46% of revenue when the group actually spends 32%. Both are
    // arithmetic; only one answers the question, and the wrong one reads as
    // a much more dramatic finding than the data supports.
    measures.ttm_revenue_prior = pRev;
    measures.ttm_capex_prior = pCapex;
    measures.ttm_ocf_prior = pOcf;
    measures.ttm_opinc_prior = pOpinc;
    measures.ttm_fcf_prior = pFcf;

    // THE CAPITAL BASE. Stated as what it is — the physical asset base —
    // and not called invested capital, because the textbook
    // debt-plus-equity-less-cash figure needs shareholders' equity, which
    // is not among the concepts extracted. Naming a narrower measure
    // accurately beats half-computing a broader one.
    //
    // Gross is preferred: depreciation policy differs between these
    // companies, and a net base lets faster write-offs shrink the
    // denominator and flatter the return. But only Microsoft, Alphabet
    // and Meta tag a gross figure every quarter — for Amazon and Nvidia
    // it appears once a year — so the net base is used where gross is
    // unavailable at BOTH period ends, and the substitution is recorded
    // rather than hidden.
    const base = (s: Series) => {
      const a = at(s, ref)?.value ?? null;
      const b = at(s, prior)?.value ?? null;
      return a !== null && b !== null ? { now: a, prior: b } : null;
    };
    const gross = base(ppeGross);
    const net = base(ppe);
    const chosen = gross ?? net;
    const baseLabel = gross
      ? 'the property base before depreciation'
      : 'the property base net of depreciation';
    const basisNote = gross
      ? `Computed on ${baseLabel}.`
      : net
        ? `Computed on ${baseLabel}: this company does not tag a gross figure at both period ends. `
          + 'Not directly comparable with a company measured on the gross base.'
        : undefined;

    const withNote = (m: Measure): Measure =>
      m.value !== null && basisNote ? { ...m, basisNote } : m;

    const num = { now: chosen?.now ?? null, prior: chosen?.prior ?? null };
    measures.incr_opinc_on_capital = withNote(
      incremental(ttmOpinc, pOpinc, num.now, num.prior, { num: 'Operating income', den: `The value of ${baseLabel}` }));
    measures.incr_ocf_on_capital = withNote(
      incremental(ttmOcf, pOcf, num.now, num.prior, { num: 'Operating cash flow', den: `The value of ${baseLabel}` }));
    measures.incr_fcf_on_capital = withNote(
      incremental(ttmFcf, pFcf, num.now, num.prior, { num: 'Free cash flow', den: `The value of ${baseLabel}` }));

    // The simpler variant the brief also asks for: incremental profit and
    // revenue per dollar of capex actually spent over the year. This one
    // needs no balance sheet at all, so it survives where the others go
    // UNKNOWN — and it is the more direct reading of "is the spending
    // earning anything".
    measures.incr_opinc_per_capex = (ttmOpinc.value !== null && pOpinc.value !== null && ttmCapex.value !== null && ttmCapex.value > 0)
      ? known((ttmOpinc.value - pOpinc.value) / ttmCapex.value, ttmOpinc.periods!, 'fraction')
      : unknown('Operating income or trailing capex is unavailable for this period.', 'fraction');
    measures.incr_revenue_per_capex = (ttmRevenue.value !== null && pRev.value !== null && ttmCapex.value !== null && ttmCapex.value > 0)
      ? known((ttmRevenue.value - pRev.value) / ttmCapex.value, ttmRevenue.periods!, 'fraction')
      : unknown('Revenue or trailing capex is unavailable for this period.', 'fraction');

    // Growth rates, for the "is this accelerating" reading.
    measures.capex_growth_yoy = (ttmCapex.value !== null && pCapex.value !== null && pCapex.value > 0)
      ? known((ttmCapex.value - pCapex.value) / pCapex.value, ttmCapex.periods!, 'fraction')
      : unknown('A year-earlier capex figure is unavailable.', 'fraction');
    measures.revenue_growth_yoy = (ttmRevenue.value !== null && pRev.value !== null && pRev.value > 0)
      ? known((ttmRevenue.value - pRev.value) / pRev.value, ttmRevenue.periods!, 'fraction')
      : unknown('A year-earlier revenue figure is unavailable.', 'fraction');
  }

  // Balance-sheet position. Net debt is the financing question: the
  // hyperscalers have historically built from surplus cash, and a shift
  // to net borrowing is the change that would matter for credit.
  // BALANCE-SHEET ITEMS REPORT THEIR OWN DATE. Pinning them to the
  // reference quarter throws away real readings: Oracle — the company
  // whose financing is most worth watching — tags the current portion of
  // its borrowings only at fiscal year end, so a debt figure forced to
  // the latest quarter is UNKNOWN while a complete one sits four months
  // back. An older number, labelled with its date, beats no number; a
  // number silently presented as current does not, which is why the
  // period travels with the value and the panel prints "as of".
  const asOf = latestCommon([debt, cash]) ?? ref;
  const d = at(debt, asOf)?.value ?? null;
  const c = at(cash, asOf)?.value ?? null;
  const staleNote = asOf !== ref
    ? `Balance sheet as of ${asOf}, the most recent date at which this company tags both borrowings and cash; `
      + `the income and cash-flow figures above are to ${ref}.`
    : undefined;
  const dated = (m: Measure): Measure => (m.value !== null && staleNote ? { ...m, basisNote: staleNote } : m);

  measures.debt = dated(d === null
    ? unknown('Total borrowings are not separately tagged in this filing.', 'usd_bn')
    : known(d / BN, [asOf], 'usd_bn'));
  measures.cash = dated(c === null
    ? unknown('Cash and equivalents are not tagged for this period.', 'usd_bn')
    : known(c / BN, [asOf], 'usd_bn'));
  measures.net_debt = dated((d === null || c === null)
    ? unknown('Net debt needs both borrowings and cash; one of them is unavailable.', 'usd_bn')
    : known((d - c) / BN, [asOf], 'usd_bn'));
  measures.net_debt_to_ocf = dated((d === null || c === null || ttmOcf.value === null || ttmOcf.value <= 0)
    ? unknown('Net debt against operating cash flow needs both, and positive cash flow.', 'ratio')
    : known((d - c) / BN / ttmOcf.value, [asOf], 'ratio'));

  const src = at(revenue, ref) ?? at(capex, ref);
  return {
    ticker, periodEnd: ref,
    accn: src?.accn ?? null, filed: src?.filed ?? null, form: src?.form ?? null,
    measures,
  };
}
