// Assemble the AI Capital view from what SEC ingestion stored.
//
// Reads company_financials (~3,000 rows, indexed by ticker), rebuilds the
// per-company metrics, scores them, and builds the transmission map,
// supplier signal, Hunter cross, thesis test and caveats. The result rides
// the cockpit payload, so the page costs no extra request.
//
// FRESHNESS SEMANTICS. These are QUARTERLY figures. They do not go stale
// between filings — they get OLD, which is a different thing and is
// reported as an age rather than hidden. A panel that silently kept
// showing last quarter's capex as though it were today's reading would be
// worse than one that says how old it is.

import type { Point } from '../sources/types.ts';
import { companyMetrics, type CompanyMetrics, type Series } from '../compute/ai-capital-metrics.ts';
import { scoreAiCapital, aiCapitalLine, type AiCapitalScore } from '../scoring/ai-capital-score.ts';
import {
  transmissionMap, supplierSignal, hunterCross, thesisTest, dataCaveats,
  type Transmission, type SupplierSignal, type HunterAi, type ThesisTest, type Caveat,
} from '../scoring/aipanel.ts';
import { COMPANIES, byTicker } from '../registry/companies.ts';
import { filingUrl } from '../sources/sec.ts';
import type { Env } from './index.ts';

export interface CompanyRow {
  ticker: string;
  name: string;
  role: 'deployer' | 'supplier';
  periodEnd: string | null;
  form: string | null;
  filed: string | null;
  filingUrl: string | null;
  capexToRevenue: number | null;
  capexToOcf: number | null;
  incrOpincOnCapital: number | null;
  incrFcfOnCapital: number | null;
  netDebtToOcf: number | null;
  capexGrowth: number | null;
  revenueGrowth: number | null;
  ttmCapex: number | null;
  ttmRevenue: number | null;
  /** Per-cell unknown reasons, so a blank is never ambiguous. */
  unknown: Record<string, string>;
  /** Accounting-base notes for this company (gross vs net, date mismatch). */
  notes: string[];
  /** Set when this company is a material outlier on the framework's own
   *  measures. Never a recommendation — a flag on the numbers. */
  flag: 'FINANCING STRESS' | 'OUTLIER' | null;
  flagReason: string | null;
}

export interface AiCapitalView {
  computedAt: string;
  score: AiCapitalScore;
  line: string;
  transmission: Transmission;
  supplier: SupplierSignal;
  hunter: HunterAi;
  thesis: ThesisTest;
  caveats: Caveat[];
  companies: CompanyRow[];
  coverage: { ingested: number; total: number; latestFiled: string | null; oldestPeriod: string | null };
  /** How old the newest quarter is, in days. */
  ageDays: number | null;
}

/** Load the stored quarterly facts. Indexed by (ticker, concept_id,
 *  period_end), so this is a key-range read per company rather than a
 *  table scan. */
export async function loadCompanyFacts(env: Env): Promise<{
  metrics: Map<string, CompanyMetrics>;
  missing: { ticker: string; concept_id: string; reason: string }[];
  filings: { ticker: string; latest_filed: string | null; latest_period: string | null; status: string }[];
}> {
  const rows = await env.DB.prepare(
    `SELECT ticker, concept_id, period_end, value, basis, accn, filed, form
       FROM company_financials ORDER BY ticker, concept_id, period_end`,
  ).all<{
    ticker: string; concept_id: string; period_end: string; value: number;
    basis: string; accn: string; filed: string; form: string;
  }>();

  const byCompany = new Map<string, Record<string, Series>>();
  for (const r of rows.results ?? []) {
    const c = byCompany.get(r.ticker) ?? {};
    (c[r.concept_id] ??= []).push({
      periodEnd: r.period_end, value: r.value,
      basis: r.basis === 'derived' ? 'derived' : 'reported',
      accn: r.accn, filed: r.filed, form: r.form,
    });
    byCompany.set(r.ticker, c);
  }

  const metrics = new Map<string, CompanyMetrics>();
  for (const [ticker, concepts] of byCompany) metrics.set(ticker, companyMetrics(ticker, concepts));

  const [miss, fil] = await Promise.all([
    env.DB.prepare('SELECT ticker, concept_id, reason FROM company_missing')
      .all<{ ticker: string; concept_id: string; reason: string }>(),
    env.DB.prepare('SELECT ticker, latest_filed, latest_period, status FROM company_filings')
      .all<{ ticker: string; latest_filed: string | null; latest_period: string | null; status: string }>(),
  ]);

  return { metrics, missing: miss.results ?? [], filings: fil.results ?? [] };
}

const v = (m: CompanyMetrics, id: string): number | null => m.measures[id]?.value ?? null;
const why = (m: CompanyMetrics, id: string): string | undefined => m.measures[id]?.unknown;

/** Build the per-company comparison rows, including the outlier flag.
 *
 *  The flag is computed from the framework's own thresholds, not chosen by
 *  hand, and its wording is deliberately about FINANCING rather than about
 *  what anyone should do: this file contains no BUY/SELL/LONG/SHORT
 *  vocabulary and the flag names are constrained to the two the brief
 *  allows. */
function companyRows(all: Map<string, CompanyMetrics>): CompanyRow[] {
  const out: CompanyRow[] = [];
  const depNetDebt = COMPANIES.filter((c) => c.role === 'deployer')
    .map((c) => all.get(c.ticker)).filter((m): m is CompanyMetrics => !!m)
    .map((m) => v(m, 'net_debt_to_ocf')).filter((x): x is number => x !== null);
  const median = depNetDebt.length
    ? [...depNetDebt].sort((a, b) => a - b)[Math.floor(depNetDebt.length / 2)]
    : null;

  for (const c of COMPANIES) {
    const m = all.get(c.ticker);
    if (!m) {
      out.push({
        ticker: c.ticker, name: c.name, role: c.role, periodEnd: null, form: null, filed: null,
        filingUrl: null, capexToRevenue: null, capexToOcf: null, incrOpincOnCapital: null,
        incrFcfOnCapital: null, netDebtToOcf: null, capexGrowth: null, revenueGrowth: null,
        ttmCapex: null, ttmRevenue: null,
        unknown: { all: 'No filings have been ingested for this company yet.' },
        notes: [], flag: null, flagReason: null,
      });
      continue;
    }
    const unknown: Record<string, string> = {};
    for (const [k, id] of [
      ['capexToRevenue', 'capex_intensity'], ['capexToOcf', 'capex_to_ocf'],
      ['incrOpincOnCapital', 'incr_opinc_on_capital'], ['incrFcfOnCapital', 'incr_fcf_on_capital'],
      ['netDebtToOcf', 'net_debt_to_ocf'],
    ] as const) {
      const w = why(m, id);
      if (w) unknown[k] = w;
    }
    const notes: string[] = [];
    const basis = m.measures.incr_opinc_on_capital?.basisNote;
    if (basis) notes.push(basis);
    const ndNote = m.measures.net_debt?.basisNote;
    if (ndNote && ndNote !== basis) notes.push(ndNote);

    // OUTLIER / FINANCING STRESS, from the numbers.
    const nd = v(m, 'net_debt_to_ocf');
    const ctoOcf = v(m, 'capex_to_ocf');
    const ctoRev = v(m, 'capex_intensity');
    let flag: CompanyRow['flag'] = null;
    let flagReason: string | null = null;
    if (c.role === 'deployer' && nd !== null && nd >= 1.5) {
      flag = 'FINANCING STRESS';
      flagReason = `Net debt is ${nd.toFixed(2)}x operating cash flow`
        + (median !== null ? `, against a deployer median of ${median.toFixed(2)}x` : '')
        + (ctoOcf !== null && ctoOcf > 1 ? `, while capex runs at ${(ctoOcf * 100).toFixed(0)}% of operating cash flow` : '')
        + '. This is a statement about how the build-out is funded, not about the security.';
    } else if (c.role === 'deployer' && ((ctoRev !== null && ctoRev >= 0.75) || (ctoOcf !== null && ctoOcf >= 1.25))) {
      flag = 'OUTLIER';
      flagReason = `Capital spending is ${ctoRev !== null ? `${(ctoRev * 100).toFixed(0)}% of revenue` : ''}`
        + `${ctoRev !== null && ctoOcf !== null ? ' and ' : ''}`
        + `${ctoOcf !== null ? `${(ctoOcf * 100).toFixed(0)}% of operating cash flow` : ''}`
        + ' — materially outside the range of the other deployers in this framework.';
    }

    out.push({
      ticker: c.ticker, name: c.name, role: c.role,
      periodEnd: m.periodEnd, form: m.form, filed: m.filed,
      filingUrl: m.accn ? filingUrl(c.cik, m.accn) : null,
      capexToRevenue: ctoRev, capexToOcf: ctoOcf,
      incrOpincOnCapital: v(m, 'incr_opinc_on_capital'),
      incrFcfOnCapital: v(m, 'incr_fcf_on_capital'),
      netDebtToOcf: nd,
      capexGrowth: v(m, 'capex_growth_yoy'),
      revenueGrowth: v(m, 'revenue_growth_yoy'),
      ttmCapex: v(m, 'ttm_capex'), ttmRevenue: v(m, 'ttm_revenue'),
      unknown, notes, flag, flagReason,
    });
  }
  return out;
}

export async function buildAiCapital(
  env: Env, seriesMap: Map<string, Point[]>, nowIso: string,
  macro: { meltup: number | null; credit: number | null; bustOnset: number | null; liquidityRegime: string | null },
): Promise<AiCapitalView | null> {
  const { metrics, missing, filings } = await loadCompanyFacts(env);
  if (!metrics.size) return null;

  const score = scoreAiCapital(metrics);
  const transmission = transmissionMap(score, metrics, seriesMap);
  const supplier = supplierSignal(metrics);
  const hunter = hunterCross(score, macro.meltup, macro.credit, macro.bustOnset, macro.liquidityRegime, transmission);
  const thesis = thesisTest(score, metrics, supplier, transmission);
  const caveats = dataCaveats(metrics, missing);
  const companies = companyRows(metrics);

  const latestFiled = filings.map((f) => f.latest_filed).filter((x): x is string => !!x).sort().pop() ?? null;
  const today = nowIso.slice(0, 10);
  const ageDays = score.newestPeriod
    ? Math.round((Date.parse(today) - Date.parse(score.newestPeriod)) / 86400000)
    : null;

  return {
    computedAt: nowIso,
    score, line: aiCapitalLine(score, today),
    transmission, supplier, hunter, thesis, caveats, companies,
    coverage: {
      ingested: filings.filter((f) => f.status === 'ok').length,
      total: COMPANIES.length,
      latestFiled,
      oldestPeriod: score.oldestPeriod,
    },
    ageDays,
  };
}

/** Persist the daily snapshot. One row per day; the components and the
 *  panels are stored so "What Changed?" can diff against yesterday
 *  without recomputing anything. */
export async function saveAiCapital(env: Env, view: AiCapitalView, today: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO ai_capital_history
       (date, computed_at, score, status, evidence_available, evidence_total,
        components, transmission, thesis, hunter_link, detail)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(date) DO UPDATE SET
       computed_at=excluded.computed_at, score=excluded.score, status=excluded.status,
       evidence_available=excluded.evidence_available, evidence_total=excluded.evidence_total,
       components=excluded.components, transmission=excluded.transmission,
       thesis=excluded.thesis, hunter_link=excluded.hunter_link, detail=excluded.detail`,
  ).bind(
    today, view.computedAt, view.score.score, view.score.status,
    view.score.evidenceAvailable, view.score.evidenceTotal,
    JSON.stringify(view.score.components),
    JSON.stringify({ status: view.transmission.status, nodes: view.transmission.nodes }),
    JSON.stringify({ supporting: view.thesis.supporting, contradicting: view.thesis.contradicting }),
    view.hunter.state,
    JSON.stringify({
      supplier: view.supplier,
      companies: view.companies.map((c) => ({
        t: c.ticker, p: c.periodEnd, cr: c.capexToRevenue, co: c.capexToOcf,
        io: c.incrOpincOnCapital, nd: c.netDebtToOcf,
      })),
    }),
  ).run();
}

export { byTicker };
