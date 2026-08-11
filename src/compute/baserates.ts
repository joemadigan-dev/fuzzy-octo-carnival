// LONG-HORIZON BASE RATES — the counterweight to a gauge that reads in
// days and weeks.
//
// From starting valuations comparable to today's, what did equities
// actually do over the following 1, 3, 5 and 10 years? Every outcome is
// listed individually and the spread is the headline. The mean of a
// handful of overlapping, non-independent historical windows is noise, and
// reporting it would manufacture a forecast out of nothing.
//
// Anchor: Damodaran's ANNUAL implied ERP (1961-), not the Altitude
// percentile. The brief asked for "the current Altitude percentile", but
// Altitude only exists from 2001 — about five non-overlapping 10-year
// windows, which cannot support a base rate. ERP is the same idea
// (starting valuation) with four times the history, and it is the measure
// this cluster is built on. The substitution is stated in the UI.

import type { Point } from '../sources/types.ts';

export interface BaseRateOutcome {
  year: number;
  erp: number;
  r1: number | null; r3: number | null; r5: number | null; r10: number | null;
}

export interface BaseRateResult {
  /** today's ERP and where it sits in the annual distribution */
  currentErp: number | null;
  currentPct: number | null;
  /** the comparable band actually used */
  band: { loPct: number; hiPct: number; loErp: number; hiErp: number } | null;
  outcomes: BaseRateOutcome[];
  /** min / median / max per horizon — never a mean */
  spread: Record<'r1' | 'r3' | 'r5' | 'r10', { lo: number; med: number; hi: number; n: number } | null>;
  /** same horizons across ALL years, for context on how special the band is */
  allSpread: Record<'r1' | 'r3' | 'r5' | 'r10', { lo: number; med: number; hi: number; n: number } | null>;
  note: string;
}

const HORIZONS = { r1: 1, r3: 3, r5: 5, r10: 10 } as const;

/** Annualised total return over the N years FOLLOWING year y. */
function forward(retByYear: Map<number, number>, y: number, n: number): number | null {
  let growth = 1;
  for (let k = 1; k <= n; k++) {
    const r = retByYear.get(y + k);
    if (r === undefined) return null;
    growth *= 1 + r / 100; // stored as percent
  }
  return (Math.pow(growth, 1 / n) - 1) * 100;
}

function stats(vals: number[]): { lo: number; med: number; hi: number; n: number } | null {
  if (!vals.length) return null;
  const s = [...vals].sort((a, b) => a - b);
  const m = s.length >> 1;
  return {
    lo: r2(s[0]),
    med: r2(s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2),
    hi: r2(s[s.length - 1]),
    n: s.length,
  };
}

const r2 = (n: number) => Math.round(n * 100) / 100;

export function computeBaseRates(m: Map<string, Point[]>): BaseRateResult {
  const empty: BaseRateResult = {
    currentErp: null, currentPct: null, band: null, outcomes: [],
    spread: { r1: null, r3: null, r5: null, r10: null },
    allSpread: { r1: null, r3: null, r5: null, r10: null },
    note: 'no data',
  };

  const erpAnnual = m.get('erp_annual') ?? [];
  const rets = m.get('spx_annual_ret') ?? [];
  const erpNow = m.get('erp') ?? [];
  if (erpAnnual.length < 20 || rets.length < 30) return empty;

  const retByYear = new Map<number, number>();
  for (const p of rets) retByYear.set(Number(p.date.slice(0, 4)), p.value);

  // every historical year with a starting valuation and a forward record
  const all: BaseRateOutcome[] = erpAnnual.map((p) => {
    const y = Number(p.date.slice(0, 4));
    return {
      year: y, erp: r2(p.value),
      r1: nz(forward(retByYear, y, HORIZONS.r1)),
      r3: nz(forward(retByYear, y, HORIZONS.r3)),
      r5: nz(forward(retByYear, y, HORIZONS.r5)),
      r10: nz(forward(retByYear, y, HORIZONS.r10)),
    };
  });

  // today's valuation, on the monthly headline series
  const currentErp = erpNow.length ? r2(erpNow[erpNow.length - 1].value) : null;
  if (currentErp === null) return { ...empty, note: 'no current ERP' };

  const sortedErp = all.map((o) => o.erp).sort((a, b) => a - b);
  let below = 0;
  for (const v of sortedErp) if (v <= currentErp) below++;
  const currentPct = r2((below / sortedErp.length) * 100);

  // comparable = within ±12 percentile points, widened until at least 10
  // years qualify. A base rate off four observations is not a base rate.
  let half = 12;
  let comparable: BaseRateOutcome[] = [];
  let loErp = 0, hiErp = 0;
  while (half <= 50) {
    const loPct = Math.max(0, currentPct - half), hiPct = Math.min(100, currentPct + half);
    loErp = quantile(sortedErp, loPct);
    hiErp = quantile(sortedErp, hiPct);
    comparable = all.filter((o) => o.erp >= loErp && o.erp <= hiErp);
    if (comparable.length >= 10) break;
    half += 6;
  }

  const pick = (rows: BaseRateOutcome[], k: 'r1' | 'r3' | 'r5' | 'r10') =>
    stats(rows.map((o) => o[k]).filter((v): v is number => v !== null));

  return {
    currentErp,
    currentPct,
    band: { loPct: r2(Math.max(0, currentPct - half)), hiPct: r2(Math.min(100, currentPct + half)), loErp: r2(loErp), hiErp: r2(hiErp) },
    outcomes: comparable.sort((a, b) => a.year - b.year),
    spread: { r1: pick(comparable, 'r1'), r3: pick(comparable, 'r3'), r5: pick(comparable, 'r5'), r10: pick(comparable, 'r10') },
    allSpread: { r1: pick(all, 'r1'), r3: pick(all, 'r3'), r5: pick(all, 'r5'), r10: pick(all, 'r10') },
    note: `Starting valuations within ±${half} percentile points of today's implied ERP.`,
  };
}

function quantile(sorted: number[], pct: number): number {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round((pct / 100) * sorted.length) - 1));
  return sorted[i];
}

function nz(v: number | null): number | null {
  return v === null ? null : r2(v);
}
