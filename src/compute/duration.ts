// Zero-coupon Treasury maths for the 2056 STRIP block.
//
// THE SECURITY. US Treasury principal STRIP, CUSIP 912803HS5, maturing
// 15 February 2056, zero coupon. Nothing here is a price feed: there is no
// free, reliable public quote for an individual STRIP CUSIP, so every
// figure in this file is MODELLED from the 30-year constant-maturity
// Treasury yield as a proxy and must be labelled as such wherever it is
// displayed. A fabricated price for a named CUSIP would be the worst
// single thing this dashboard could do, because it would look exactly like
// a real one.
//
// WHY A ZERO IS THE INSTRUMENT. Duration on a zero is its maturity
// (Macaulay), so at ~29 years it is roughly twice the duration of the
// 10-year note and it has no coupons to reinvest. That makes it the
// cleanest available expression of one idea and one idea only: the long
// discount rate falls. It is equally the cleanest way to lose money if the
// long discount rate rises, and the table below is symmetric for that
// reason — the +150bp row is shown at the same size as the −150bp row.
//
// THE RETURN CONVENTION. P1 is priced one year forward, on a maturity
// shortened by one year, so the 0bp row is not 0% — it is approximately
// the yield, earned as roll-down. That is the actual holding-period return
// of a zero when nothing happens, and hiding it would understate the base
// case.

/** Semi-annual compounding, matching Treasury quoting convention. */
const PERIODS_PER_YEAR = 2;

export const STRIP = {
  cusip: '912803HS5',
  maturity: '2056-02-15',
  coupon: 0,
  label: 'UST PRINCIPAL STRIP',
} as const;

/** Whole and fractional years between two ISO dates, on a 365.25-day year.
 *
 *  Not day-count-exact. A STRIP's true price needs an actual/actual
 *  accrual against the settlement date, and this module does not have a
 *  settlement date — it has a yield curve point. The approximation is
 *  worth about a day of maturity, which moves the modelled return by less
 *  than the width of the rendered number; claiming more precision than
 *  that would be false. */
export function yearsBetween(fromIso: string, toIso: string): number {
  const a = Date.parse(fromIso + 'T00:00:00Z');
  const b = Date.parse(toIso + 'T00:00:00Z');
  if (!Number.isFinite(a) || !Number.isFinite(b)) return NaN;
  return (b - a) / (365.25 * 86400000);
}

/** Price per 100 face of a zero, `years` from maturity at yield `yPct`. */
export function zeroPrice(yPct: number, years: number): number {
  if (!Number.isFinite(yPct) || !Number.isFinite(years) || years <= 0) return NaN;
  const r = yPct / 100 / PERIODS_PER_YEAR;
  // A zero yield is legitimate (price = par); a yield at or below -200%
  // annualised is not a market, it is a data error, and NaN is the honest
  // answer rather than a complex number.
  if (1 + r <= 0) return NaN;
  return 100 / Math.pow(1 + r, PERIODS_PER_YEAR * years);
}

/** Macaulay duration of a zero is its maturity; modified duration divides
 *  by (1 + y/m). Reported for the header line, not used in the payoff
 *  table — the table reprices exactly rather than approximating. */
export function modifiedDuration(yPct: number, years: number): number {
  if (!Number.isFinite(yPct) || !Number.isFinite(years) || years <= 0) return NaN;
  return years / (1 + yPct / 100 / PERIODS_PER_YEAR);
}

/** Convexity of a zero, in the usual (years²) units. */
export function convexity(yPct: number, years: number): number {
  if (!Number.isFinite(yPct) || !Number.isFinite(years) || years <= 0) return NaN;
  const r = yPct / 100 / PERIODS_PER_YEAR;
  const n = PERIODS_PER_YEAR * years;
  return (n * (n + 1)) / (Math.pow(1 + r, 2) * PERIODS_PER_YEAR * PERIODS_PER_YEAR);
}

export interface PayoffRow {
  /** Parallel shift applied to the proxy yield, in basis points. */
  shiftBp: number;
  /** Proxy yield after the shift, in percent. */
  yieldAfter: number;
  /** Total return over one year, in percent. */
  returnPct: number;
  /** What the notional becomes. */
  valueEnd: number;
}

export interface Payoff {
  /** The proxy used, stated so the table can never be read as a quote. */
  proxy: string;
  proxyYield: number;
  proxyAsOf: string;
  /** Years to maturity at the valuation date. */
  yearsToMaturity: number;
  /** Years remaining after the one-year holding period. */
  yearsForward: number;
  modifiedDuration: number;
  convexity: number;
  price: number;
  notional: number;
  rows: PayoffRow[];
  /** Never optional, never configurable. */
  caveat: string;
}

export const DEFAULT_SHIFTS_BP = [-150, -100, -50, 0, 50, 100, 150];

/** One-year-forward payoff table for a zero, repriced exactly at each
 *  shift. Returns null when the proxy yield or date is missing — an empty
 *  block is correct, an invented one is not. */
export function stripPayoff(
  proxyYieldPct: number | null,
  proxyAsOf: string | null,
  notional = 10000,
  shiftsBp: number[] = DEFAULT_SHIFTS_BP,
  maturity: string = STRIP.maturity,
): Payoff | null {
  if (proxyYieldPct === null || proxyAsOf === null) return null;
  const T = yearsBetween(proxyAsOf, maturity);
  // Below a year to run this stops being a duration instrument and the
  // one-year-forward convention has nothing left to price.
  if (!Number.isFinite(T) || T <= 1) return null;
  const p0 = zeroPrice(proxyYieldPct, T);
  if (!Number.isFinite(p0) || p0 <= 0) return null;

  const rows: PayoffRow[] = [];
  for (const shiftBp of shiftsBp) {
    const yAfter = proxyYieldPct + shiftBp / 100;
    const p1 = zeroPrice(yAfter, T - 1);
    if (!Number.isFinite(p1)) continue;
    const returnPct = (p1 / p0 - 1) * 100;
    rows.push({
      shiftBp,
      yieldAfter: yAfter,
      returnPct,
      valueEnd: notional * (1 + returnPct / 100),
    });
  }
  if (!rows.length) return null;

  return {
    proxy: '30Y Treasury constant-maturity yield (DGS30)',
    proxyYield: proxyYieldPct,
    proxyAsOf,
    yearsToMaturity: T,
    yearsForward: T - 1,
    modifiedDuration: modifiedDuration(proxyYieldPct, T),
    convexity: convexity(proxyYieldPct, T),
    price: p0,
    notional,
    rows,
    caveat: 'Illustrative duration sensitivity — not a forecast. Modelled from the 30Y Treasury yield as a proxy; no live price for CUSIP 912803HS5 is used.',
  };
}
