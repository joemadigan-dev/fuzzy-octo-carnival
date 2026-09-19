// SEC XBRL — filing discovery, extraction and normalisation.
//
// Source: data.sec.gov companyfacts, which is the structured form of what
// the company filed. NOT a scraped financial site: every value here comes
// with the accession number of the 10-Q or 10-K it was tagged in, and the
// UI shows that reference beside the number.
//
// THE HARD PART is that cash-flow-statement facts are reported CUMULATIVE
// year-to-date. Microsoft's FY2026 capex arrives as:
//
//   Q1  2025-07-01..2025-09-30   $19.4bn   (3 months — discrete)
//   Q2  2025-07-01..2025-12-31   $49.3bn   (6 months — cumulative)
//   Q2  2025-10-01..2025-12-31   $29.9bn   (3 months — also tagged)
//   FY  2025-07-01..2026-06-30  $116.0bn   (12 months)
//
// Reading the cumulative figure as a quarter would overstate capex by up
// to 4x, and reading the FY figure as Q4 by 4x again. So flows are reduced
// to DISCRETE quarters: prefer a ~quarter-length fact where one exists,
// otherwise derive it by subtracting the previous cumulative figure in the
// same fiscal year. A quarter that can be neither found nor derived is
// omitted — never zero.
//
// Fiscal years are the company's own: Microsoft ends 30 June, Oracle
// 31 May, Nvidia late January. Quarters are keyed by period end, and
// year-on-year comparisons use the same fiscal quarter a year earlier
// rather than a calendar offset.

import {
  ACCEPTED_FORMS, CONCEPTS, SEC_USER_AGENT, type Company, type ConceptDef,
} from '../registry/companies.ts';

export interface RawFact {
  start?: string;
  end: string;
  val: number;
  form: string;
  fy?: number;
  fp?: string;
  filed: string;
  accn: string;
  frame?: string;
}

/** One normalised quarterly observation, with its provenance. */
export interface QuarterValue {
  /** Period end, which is the quarter's identity. */
  periodEnd: string;
  periodStart?: string;
  value: number;
  form: string;
  filed: string;
  accn: string;
  fy?: number;
  fp?: string;
  /** How this number was arrived at — shown in the UI. */
  basis: 'reported' | 'derived';
  /** For a derived quarter, what it was derived from. */
  derivedFrom?: string;
}

export interface ConceptSeries {
  conceptId: string;
  /** The XBRL tag(s) actually used, for the audit trail. */
  tags: string[];
  quarters: QuarterValue[];
  /** Set when no chain resolved. UNKNOWN, never zero. */
  missing?: string;
}

const DAY = 86400000;
const days = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / DAY);

/** A fact covering roughly one quarter. Fiscal quarters run 84–98 days. */
const isQuarterly = (f: RawFact) => f.start !== undefined && days(f.start, f.end) >= 80 && days(f.start, f.end) <= 100;
/** Cumulative periods: half, three-quarter and full year. */
const isCumulative = (f: RawFact) => f.start !== undefined && days(f.start, f.end) > 100;

/** Latest filing wins for a given period — this is how restatements and
 *  amended filings are handled: the most recently filed value for a period
 *  supersedes earlier ones, and the accession recorded is the one the
 *  number actually came from. */
function pickLatest(facts: RawFact[]): RawFact | null {
  if (!facts.length) return null;
  return facts.reduce((best, f) => (f.filed > best.filed ? f : best));
}

/** Reduce one tag's raw facts to discrete quarters. */
export function toQuarters(facts: RawFact[], kind: 'flow' | 'stock'): QuarterValue[] {
  const usable = facts.filter((f) => ACCEPTED_FORMS.includes(f.form));
  if (!usable.length) return [];

  if (kind === 'stock') {
    // Instants: one value per period end, most recently filed wins.
    const byEnd = new Map<string, RawFact[]>();
    for (const f of usable) {
      if (f.start !== undefined) continue;           // a stock has no duration
      (byEnd.get(f.end) ?? byEnd.set(f.end, []).get(f.end)!).push(f);
    }
    return [...byEnd.entries()]
      .map(([end, fs]) => {
        const b = pickLatest(fs)!;
        return { periodEnd: end, value: b.val, form: b.form, filed: b.filed, accn: b.accn,
                 fy: b.fy, fp: b.fp, basis: 'reported' as const };
      })
      .sort((a, b) => a.periodEnd.localeCompare(b.periodEnd));
  }

  // FLOWS. Reported quarters first.
  const out = new Map<string, QuarterValue>();
  const byEndQ = new Map<string, RawFact[]>();
  for (const f of usable.filter(isQuarterly)) {
    (byEndQ.get(f.end) ?? byEndQ.set(f.end, []).get(f.end)!).push(f);
  }
  for (const [end, fs] of byEndQ) {
    const b = pickLatest(fs)!;
    out.set(end, { periodEnd: end, periodStart: b.start, value: b.val, form: b.form,
                   filed: b.filed, accn: b.accn, fy: b.fy, fp: b.fp, basis: 'reported' });
  }

  // Then derive the quarters only reported cumulatively — characteristically
  // Q4, which appears solely inside the 10-K's full-year figure.
  const cumulative = usable.filter(isCumulative);
  const byStart = new Map<string, RawFact[]>();
  for (const f of cumulative) {
    const k = f.start!;
    (byStart.get(k) ?? byStart.set(k, []).get(k)!).push(f);
  }
  for (const [start, group] of byStart) {
    // longest period first, so the full year is reduced by the nine months
    const sorted = [...group].sort((a, b) => days(start, b.end) - days(start, a.end));
    for (const long of sorted) {
      if (out.has(long.end)) continue;
      // the next-shortest cumulative period sharing this start
      const shorter = sorted
        .filter((s) => days(start, s.end) < days(start, long.end))
        .sort((a, b) => days(start, b.end) - days(start, a.end))[0];
      let prior: number | null = null;
      let fromLabel = '';
      if (shorter && days(shorter.end, long.end) >= 80 && days(shorter.end, long.end) <= 100) {
        prior = pickLatest(group.filter((g) => g.end === shorter.end))!.val;
        fromLabel = `${long.form} cumulative ${start}..${long.end} less ${start}..${shorter.end}`;
      } else {
        // no cumulative stepping-stone: sum the discrete quarters we have
        const inYear = [...out.values()].filter((q) => q.periodEnd > start && q.periodEnd < long.end);
        const covered = inYear.reduce((s, q) => s + q.value, 0);
        const spanned = inYear.length;
        const expected = Math.round(days(start, long.end) / 91) - 1;
        if (spanned === expected && spanned > 0) {
          prior = covered;
          fromLabel = `${long.form} cumulative ${start}..${long.end} less ${spanned} reported quarters`;
        }
      }
      if (prior === null) continue;                  // cannot derive → omit
      const b = pickLatest(group.filter((g) => g.end === long.end))!;
      out.set(long.end, {
        periodEnd: long.end,
        periodStart: shorter?.end,
        value: b.val - prior,
        form: b.form, filed: b.filed, accn: b.accn, fy: b.fy, fp: b.fp,
        basis: 'derived', derivedFrom: fromLabel,
      });
    }
  }

  return [...out.values()].sort((a, b) => a.periodEnd.localeCompare(b.periodEnd));
}

/** A chain whose newest quarter is older than this is treated as
 *  abandoned. Companies retire tags: Microsoft stopped tagging
 *  `InterestExpense` after FY2024 but the historical facts remain, so
 *  taking the first chain that merely RESOLVES returns two-year-old
 *  numbers while a current alternative sits in the next chain. */
const CHAIN_STALE_DAYS = 200;

/** Resolve one concept against a companyfacts blob.
 *
 *  Chains are ordered by preference, but preference only decides between
 *  chains that are equally CURRENT. The first chain within
 *  CHAIN_STALE_DAYS of the freshest available wins; if none is current,
 *  the freshest wins outright. Order still breaks ties, so the better tag
 *  is chosen whenever both are up to date. */
export function extractConcept(
  usGaap: Record<string, { units?: Record<string, RawFact[]> }>,
  def: ConceptDef,
): ConceptSeries {
  const resolved: { chain: string[]; quarters: QuarterValue[]; latest: string }[] = [];
  for (const chain of def.chains) {
    const parts = chain.map((tag) => {
      const facts = usGaap[tag]?.units?.USD ?? [];
      return { tag, quarters: toQuarters(facts as RawFact[], def.kind) };
    });
    if (parts.some((p) => !p.quarters.length)) continue;

    // Single tag: done. Several tags: sum them on matching period ends, and
    // only where EVERY part has that period — a partial sum would silently
    // understate (Microsoft's D&A without intangible amortisation).
    let quarters: QuarterValue[];
    if (parts.length === 1) {
      quarters = parts[0].quarters;
    } else {
      const maps = parts.map((p) => new Map(p.quarters.map((q) => [q.periodEnd, q])));
      const ends = [...maps[0].keys()].filter((e) => maps.every((m) => m.has(e)));
      if (!ends.length) continue;
      quarters = ends.sort().map((end) => {
        const rows = maps.map((m) => m.get(end)!);
        const lead = rows[0];
        return {
          ...lead,
          value: rows.reduce((s, r) => s + r.value, 0),
          basis: rows.some((r) => r.basis === 'derived') ? ('derived' as const) : ('reported' as const),
          derivedFrom: rows.map((r) => r.derivedFrom).filter(Boolean).join('; ') || undefined,
        };
      });
    }
    resolved.push({ chain, quarters, latest: quarters[quarters.length - 1].periodEnd });
  }

  if (!resolved.length) {
    return {
      conceptId: def.id, tags: [], quarters: [],
      missing: def.whenMissing ?? `No tagged facts found for ${def.label}.`,
    };
  }
  const freshest = resolved.reduce((a, b2) => (b2.latest > a.latest ? b2 : a)).latest;
  const cutoff = new Date(Date.parse(freshest) - CHAIN_STALE_DAYS * DAY).toISOString().slice(0, 10);
  const chosen = resolved.find((r) => r.latest >= cutoff) ?? resolved[0];
  return { conceptId: def.id, tags: chosen.chain, quarters: chosen.quarters };
}

export interface CompanyFacts {
  cik: string;
  entityName: string;
  concepts: Record<string, ConceptSeries>;
  /** Newest accession seen across everything extracted. */
  latestAccession: string | null;
  latestFiled: string | null;
  latestPeriodEnd: string | null;
  retrievedAt: string;
}

export function normaliseCompanyFacts(blob: unknown, company: Company, retrievedAt: string): CompanyFacts {
  const b = blob as { cik?: number; entityName?: string; facts?: { 'us-gaap'?: Record<string, { units?: Record<string, RawFact[]> }> } };
  const usGaap = b.facts?.['us-gaap'] ?? {};
  const concepts: Record<string, ConceptSeries> = {};
  for (const def of CONCEPTS) concepts[def.id] = extractConcept(usGaap, def);

  let latestAccession: string | null = null;
  let latestFiled: string | null = null;
  let latestPeriodEnd: string | null = null;
  for (const s of Object.values(concepts)) {
    for (const q of s.quarters) {
      if (!latestFiled || q.filed > latestFiled) { latestFiled = q.filed; latestAccession = q.accn; }
      if (!latestPeriodEnd || q.periodEnd > latestPeriodEnd) latestPeriodEnd = q.periodEnd;
    }
  }
  return {
    cik: company.cik, entityName: b.entityName ?? company.name,
    concepts, latestAccession, latestFiled, latestPeriodEnd, retrievedAt,
  };
}

/** The filing this number came from, for the citation beside it. */
export const filingUrl = (cik: string, accn: string): string =>
  `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accn.replace(/-/g, '')}/${accn}-index.htm`;

export async function fetchCompanyFacts(company: Company): Promise<unknown> {
  const url = `https://data.sec.gov/api/xbrl/companyfacts/CIK${company.cik}.json`;
  const res = await fetch(url, {
    headers: { 'user-agent': SEC_USER_AGENT, accept: 'application/json', 'accept-encoding': 'gzip' },
  });
  if (!res.ok) throw new Error(`SEC companyfacts ${res.status} for ${company.ticker}`);
  return res.json();
}
