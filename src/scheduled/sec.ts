// SEC ingestion: fetch → normalise → store quarterly facts.
//
// PACING. companyfacts is a 3–5MB document per company and serves no ETag
// or Last-Modified, so there is no cheap way to ask "has this changed?" —
// the only honest answer comes from downloading it and comparing what was
// extracted. That makes an hourly re-fetch of six companies both wasteful
// and pointless: these are QUARTERLY statements. One company is checked
// per heavy run, round-robin, and only if its own last check is older than
// CHECK_INTERVAL_HOURS. Six companies on an ~8-run day is a full sweep
// roughly daily, at one SEC request per run — far inside the 10/second
// limit, and nowhere near the Worker's subrequest budget.
//
// WRITES. Extraction is hashed, and an unchanged hash writes nothing but
// the `checked_at` stamp. A filing genuinely changes about four times a
// year per company, so the steady state is one row written per run and a
// few hundred on the days a 10-Q lands. This matters: D1's free tier
// allows 100k writes a day and this Worker has already been over it once.
//
// FAILURE. A fetch or parse failure is recorded as a failure — status
// 'failed' with the reason — and leaves the previously stored quarters
// exactly as they were. It never writes a zero, never writes a partial
// company, and never silently marks the company as checked-and-fine.

import { COMPANIES, CONCEPTS, type Company } from '../registry/companies.ts';
import { fetchCompanyFacts, normaliseCompanyFacts, type CompanyFacts } from '../sources/sec.ts';
import type { Env } from './index.ts';

/** How stale a company's facts may get before it is re-checked. */
const CHECK_INTERVAL_HOURS = 20;
/** Companies fetched per run. One: see the pacing note above. */
const COMPANIES_PER_RUN = 1;

interface FilingRow {
  ticker: string;
  facts_hash: string | null;
  checked_at: string;
  status: string;
}

/** Stable fingerprint of everything extracted. Any change to any value,
 *  basis, accession or missing-reason changes the hash — which is what
 *  makes "nothing changed, write nothing" safe. Restatements of older
 *  quarters are caught by this too, where watching only the newest
 *  accession would miss them. */
async function fingerprint(facts: CompanyFacts): Promise<string> {
  const parts: string[] = [];
  for (const id of CONCEPTS.map((c) => c.id)) {
    const s = facts.concepts[id];
    if (!s) continue;
    if (s.missing) { parts.push(`${id}\tMISSING\t${s.missing}`); continue; }
    parts.push(`${id}\t${s.tags.join('+')}`);
    for (const q of s.quarters) parts.push(`${q.periodEnd}\t${q.value}\t${q.basis}\t${q.accn}`);
  }
  const bytes = new TextEncoder().encode(parts.join('\n'));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Which company to look at this run: the one checked longest ago, and
 *  only if that was long enough ago to be worth a 4MB download. A company
 *  that has never been checked has no row and sorts first. */
export function dueCompanies(rows: FilingRow[], nowMs: number, limit = COMPANIES_PER_RUN): Company[] {
  const byTicker = new Map(rows.map((r) => [r.ticker, r]));
  const due = COMPANIES.filter((c) => {
    const r = byTicker.get(c.ticker);
    if (!r) return true;
    return (nowMs - Date.parse(r.checked_at)) / 3600000 >= CHECK_INTERVAL_HOURS;
  });
  due.sort((a, b) => {
    const ra = byTicker.get(a.ticker)?.checked_at ?? '';
    const rb = byTicker.get(b.ticker)?.checked_at ?? '';
    return ra.localeCompare(rb);
  });
  return due.slice(0, limit);
}

/** Rows for one company's extracted quarters, plus the reasons for
 *  whatever could not be extracted. Pure, so the write shape is testable
 *  without a database. */
export function financialRows(facts: CompanyFacts, ticker: string): {
  financials: (string | number | null)[][];
  missing: [string, string][];
} {
  const financials: (string | number | null)[][] = [];
  const missing: [string, string][] = [];
  for (const def of CONCEPTS) {
    const s = facts.concepts[def.id];
    if (!s) continue;
    if (s.missing || !s.quarters.length) {
      missing.push([def.id, s.missing ?? `No usable quarters for ${def.label}.`]);
      continue;
    }
    const tags = s.tags.join(',');
    for (const q of s.quarters) {
      financials.push([
        ticker, def.id, q.periodEnd, q.periodStart ?? null, q.value, q.basis,
        q.derivedFrom ?? null, tags, q.form, q.filed, q.accn, q.fy ?? null, q.fp ?? null,
      ]);
    }
  }
  return { financials, missing };
}

/** A schema that has not been migrated yet is a KNOWN state, not a fault.
 *  Code reaches production ahead of its migration routinely — they are
 *  two separate operations against two separate systems — and reporting
 *  that as a failure buries it among real ones and makes the run look
 *  broken when it is merely waiting. */
const isMissingTable = (e: unknown) => /no such table/i.test(String(e));

export async function ingestSec(env: Env, nowIso: string, nowMs: number): Promise<string[]> {
  const log: string[] = [];
  let res: { results?: FilingRow[] };
  try {
    res = await env.DB.prepare('SELECT ticker, facts_hash, checked_at, status FROM company_filings')
      .all<FilingRow>();
  } catch (e) {
    if (isMissingTable(e)) {
      return ['sec: schema 0006 not applied yet — skipping ingestion (no data written, nothing lost)'];
    }
    throw e;
  }
  const existing = new Map((res.results ?? []).map((r) => [r.ticker, r]));
  const due = dueCompanies(res.results ?? [], nowMs);

  if (!due.length) {
    log.push('sec: all six companies checked within the last day — nothing due');
    return log;
  }

  for (const company of due) {
    try {
      const blob = await fetchCompanyFacts(company);
      const facts = normaliseCompanyFacts(blob, company, nowIso);
      const hash = await fingerprint(facts);
      const prev = existing.get(company.ticker);

      if (prev?.facts_hash === hash && prev.status === 'ok') {
        await env.DB.prepare('UPDATE company_filings SET checked_at = ?, note = NULL WHERE ticker = ?')
          .bind(nowIso, company.ticker).run();
        log.push(`sec ${company.ticker}: unchanged since ${prev.checked_at.slice(0, 10)} — 1 row written`);
        continue;
      }

      const { financials, missing } = financialRows(facts, company.ticker);
      if (!financials.length) {
        // Every concept failed. That is a parser or upstream problem, not
        // a company that reports nothing — so it is a FAILURE, and the
        // rows already stored are left untouched.
        throw new Error('no concept resolved — refusing to overwrite stored quarters');
      }

      await writeCompany(env, company, facts, hash, financials, missing, nowIso);
      const derivedCount = financials.filter((r) => r[5] === 'derived').length;
      log.push(
        `sec ${company.ticker}: ${financials.length} quarterly facts `
        + `(${derivedCount} derived), ${missing.length} concept(s) not disclosed, `
        + `latest ${facts.latestPeriodEnd ?? '?'} filed ${facts.latestFiled ?? '?'}`,
      );
    } catch (e) {
      const msg = String(e).slice(0, 300);
      if (isMissingTable(e)) {
        log.push(`sec ${company.ticker}: schema 0006 not applied yet — skipping`);
        continue;
      }
      await env.DB.prepare(
        `INSERT INTO company_filings (ticker, cik, checked_at, status, note)
         VALUES (?,?,?,'failed',?)
         ON CONFLICT(ticker) DO UPDATE SET checked_at=excluded.checked_at,
           status='failed', note=excluded.note`,
      ).bind(company.ticker, company.cik, nowIso, msg).run();
      log.push(`sec ${company.ticker}: FETCH FAILED — ${msg} (stored quarters left in place)`);
    }
  }
  return log;
}

async function writeCompany(
  env: Env, company: Company, facts: CompanyFacts, hash: string,
  financials: (string | number | null)[][], missing: [string, string][], nowIso: string,
): Promise<void> {
  const stmts: D1PreparedStatement[] = [];
  const ROWS_PER_STMT = 7; // 13 params/row → 91, under D1's 100-param cap
  for (let i = 0; i < financials.length; i += ROWS_PER_STMT) {
    const chunk = financials.slice(i, i + ROWS_PER_STMT);
    const sql = `INSERT INTO company_financials
        (ticker, concept_id, period_end, period_start, value, basis, derived_from,
         tags, form, filed, accn, fy, fp)
      VALUES ${chunk.map(() => '(?,?,?,?,?,?,?,?,?,?,?,?,?)').join(',')}
      ON CONFLICT(ticker, concept_id, period_end) DO UPDATE SET
        period_start=excluded.period_start, value=excluded.value, basis=excluded.basis,
        derived_from=excluded.derived_from, tags=excluded.tags, form=excluded.form,
        filed=excluded.filed, accn=excluded.accn, fy=excluded.fy, fp=excluded.fp`;
    stmts.push(env.DB.prepare(sql).bind(...chunk.flat()));
  }

  // Missing reasons are replaced wholesale for this company: a concept
  // that has started resolving must stop being listed as undisclosed.
  stmts.push(env.DB.prepare('DELETE FROM company_missing WHERE ticker = ?').bind(company.ticker));
  for (const [conceptId, reason] of missing) {
    stmts.push(env.DB.prepare(
      'INSERT INTO company_missing (ticker, concept_id, reason, noted_at) VALUES (?,?,?,?)',
    ).bind(company.ticker, conceptId, reason, nowIso));
  }

  stmts.push(env.DB.prepare(
    `INSERT INTO company_filings
       (ticker, cik, entity_name, latest_accession, latest_filed, latest_period,
        facts_hash, checked_at, changed_at, status, note)
     VALUES (?,?,?,?,?,?,?,?,?,'ok',NULL)
     ON CONFLICT(ticker) DO UPDATE SET
       entity_name=excluded.entity_name, latest_accession=excluded.latest_accession,
       latest_filed=excluded.latest_filed, latest_period=excluded.latest_period,
       facts_hash=excluded.facts_hash, checked_at=excluded.checked_at,
       changed_at=excluded.changed_at, status='ok', note=NULL`,
  ).bind(
    company.ticker, company.cik, facts.entityName, facts.latestAccession,
    facts.latestFiled, facts.latestPeriodEnd, hash, nowIso, nowIso,
  ));

  const SLICE = 40;
  for (let i = 0; i < stmts.length; i += SLICE) await env.DB.batch(stmts.slice(i, i + SLICE));
}
