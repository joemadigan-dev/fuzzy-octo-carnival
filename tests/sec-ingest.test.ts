// Ingestion pacing and write shape.
//
// Two failure modes are locked out here. The first is cost: a 3–5MB
// download per company on an hourly cron, against quarterly data that
// changes four times a year, with the D1 free tier already breached once.
// The second is the worse one — a fetch or parse failure overwriting good
// stored quarters with nothing, or with zeros.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dueCompanies, financialRows } from '../src/scheduled/sec.ts';
import { COMPANIES } from '../src/registry/companies.ts';
import type { CompanyFacts } from '../src/sources/sec.ts';

const NOW = Date.parse('2026-09-19T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW - h * 3600000).toISOString();
const row = (ticker: string, h: number, status = 'ok') =>
  ({ ticker, facts_hash: 'x', checked_at: hoursAgo(h), status });

test('a company checked within the day is not re-downloaded', () => {
  const rows = COMPANIES.map((c) => row(c.ticker, 2));
  assert.deepEqual(dueCompanies(rows, NOW), [], 'nothing may be due an hour after a sweep');
});

test('only one company is fetched per run', () => {
  const rows = COMPANIES.map((c) => row(c.ticker, 48));
  assert.equal(dueCompanies(rows, NOW).length, 1, 'six 4MB downloads in one run is the thing being prevented');
});

test('the company checked longest ago goes first', () => {
  const rows = [
    row('MSFT', 21), row('GOOGL', 90), row('AMZN', 30),
    row('META', 25), row('ORCL', 40), row('NVDA', 22),
  ];
  assert.equal(dueCompanies(rows, NOW)[0].ticker, 'GOOGL');
});

test('a company never checked has priority over any that has been', () => {
  const rows = COMPANIES.filter((c) => c.ticker !== 'ORCL').map((c) => row(c.ticker, 1000));
  assert.equal(dueCompanies(rows, NOW)[0].ticker, 'ORCL');
});

test('an empty table makes every company due, still one at a time', () => {
  const due = dueCompanies([], NOW, 99);
  assert.equal(due.length, COMPANIES.length);
  assert.equal(dueCompanies([], NOW).length, 1);
});

test('round-robin reaches all six across a day of runs', () => {
  // Start empty, run every 3h as the heavy gate allows, stamping each
  // fetch. All six must have been fetched inside 24h.
  const stamped = new Map<string, number>();
  for (let h = 0; h < 24; h += 3) {
    const at = NOW + h * 3600000;
    const rows = [...stamped].map(([ticker, when]) => ({
      ticker, facts_hash: 'x', status: 'ok', checked_at: new Date(when).toISOString(),
    }));
    for (const c of dueCompanies(rows, at)) stamped.set(c.ticker, at);
  }
  assert.equal(stamped.size, COMPANIES.length, `only fetched ${[...stamped.keys()]}`);
});

// ── write shape ──────────────────────────────────────────────────────

const facts = (concepts: CompanyFacts['concepts']): CompanyFacts => ({
  cik: '0000789019', entityName: 'MICROSOFT CORP', concepts,
  latestAccession: 'A', latestFiled: '2026-07-29', latestPeriodEnd: '2026-06-30',
  retrievedAt: '2026-09-19T12:00:00.000Z',
});
const q = (periodEnd: string, value: number, basis: 'reported' | 'derived' = 'reported') =>
  ({ periodEnd, value, basis, form: '10-Q', filed: '2026-07-29', accn: 'A' });

test('every stored row carries the filing it came from', () => {
  const { financials } = financialRows(facts({
    capex: { conceptId: 'capex', tags: ['PaymentsToAcquirePropertyPlantAndEquipment'], quarters: [q('2026-06-30', 35.8, 'derived')] },
  }), 'MSFT');
  assert.equal(financials.length, 1);
  const [ticker, concept, periodEnd, , value, basis, derivedFrom, tags, form, filed, accn] = financials[0];
  assert.equal(ticker, 'MSFT');
  assert.equal(concept, 'capex');
  assert.equal(periodEnd, '2026-06-30');
  assert.equal(value, 35.8);
  assert.equal(basis, 'derived');
  assert.equal(tags, 'PaymentsToAcquirePropertyPlantAndEquipment');
  assert.equal(form, '10-Q');
  assert.equal(filed, '2026-07-29');
  assert.equal(accn, 'A');
  assert.equal(derivedFrom, null, 'absent provenance is null, not an empty string');
});

test('a multi-tag concept records both tags it summed', () => {
  const { financials } = financialRows(facts({
    da: { conceptId: 'da', tags: ['Depreciation', 'AmortizationOfIntangibleAssets'], quarters: [q('2026-06-30', 9)] },
  }), 'MSFT');
  assert.equal(financials[0][7], 'Depreciation,AmortizationOfIntangibleAssets');
});

test('an undisclosed concept becomes a stated reason, never a zero row', () => {
  const { financials, missing } = financialRows(facts({
    cip: { conceptId: 'cip', tags: [], quarters: [], missing: 'NOT DISCLOSED — this company does not separately tag construction in progress.' },
  }), 'MSFT');
  assert.equal(financials.length, 0, 'no row may be written for a metric that does not exist');
  assert.deepEqual(missing, [['cip', 'NOT DISCLOSED — this company does not separately tag construction in progress.']]);
});

test('a concept that resolved but yielded no quarters is also recorded as missing', () => {
  const { financials, missing } = financialRows(facts({
    capex: { conceptId: 'capex', tags: ['PaymentsToAcquirePropertyPlantAndEquipment'], quarters: [] },
  }), 'MSFT');
  assert.equal(financials.length, 0);
  assert.equal(missing.length, 1, 'an empty series must be explained, not silently absent');
});

test('the number of bound parameters per row matches the insert', () => {
  const { financials } = financialRows(facts({
    capex: { conceptId: 'capex', tags: ['T'], quarters: [q('2026-06-30', 1)] },
  }), 'MSFT');
  // 13 columns, 7 rows per statement → 91 params, under D1's 100 cap.
  assert.equal(financials[0].length, 13);
  assert.ok(financials[0].length * 7 <= 100);
});
