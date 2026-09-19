// SEC XBRL normalisation. The failure mode being locked out is a parsing
// error that silently becomes a number — §25: "Never allow a parsing
// failure to silently become zero."

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toQuarters, extractConcept, filingUrl, type RawFact } from '../src/sources/sec.ts';
import { CONCEPTS, conceptById } from '../src/registry/companies.ts';

const f = (start: string | undefined, end: string, val: number, o: Partial<RawFact> = {}): RawFact => ({
  start, end, val, form: o.form ?? '10-Q', filed: o.filed ?? '2026-01-01',
  accn: o.accn ?? '0000000000-00-000000', fy: o.fy, fp: o.fp,
});

test('cumulative year-to-date flows are reduced to discrete quarters', () => {
  // Microsoft's real FY2026 shape: Q1 discrete, Q2/Q3 both ways, FY only cumulative.
  const q = toQuarters([
    f('2025-07-01', '2025-09-30', 19.39, { filed: '2025-10-29' }),
    f('2025-07-01', '2025-12-31', 49.27, { filed: '2026-01-28' }),
    f('2025-10-01', '2025-12-31', 29.88, { filed: '2026-01-28' }),
    f('2025-07-01', '2026-03-31', 80.15, { filed: '2026-04-29' }),
    f('2026-01-01', '2026-03-31', 30.88, { filed: '2026-04-29' }),
    f('2025-07-01', '2026-06-30', 115.95, { form: '10-K', filed: '2026-07-29' }),
  ], 'flow');
  const v = Object.fromEntries(q.map((x) => [x.periodEnd, Number(x.value.toFixed(2))]));
  assert.equal(v['2025-09-30'], 19.39);
  assert.equal(v['2025-12-31'], 29.88, 'must use the discrete Q2, not the 6-month cumulative');
  assert.equal(v['2026-03-31'], 30.88);
  assert.equal(v['2026-06-30'], 35.80, 'Q4 must be derived as FY less nine months');
  // and the four discrete quarters must reconstruct the reported full year
  const sum = q.reduce((s, x) => s + x.value, 0);
  assert.ok(Math.abs(sum - 115.95) < 0.01, `quarters must sum to the 10-K figure, got ${sum}`);
});

test('a derived quarter says it was derived, and from what', () => {
  const q = toQuarters([
    f('2025-01-01', '2025-03-31', 10),
    f('2025-01-01', '2025-06-30', 25),
    f('2025-01-01', '2025-09-30', 45, { form: '10-K' }),
  ], 'flow');
  const jun = q.find((x) => x.periodEnd === '2025-06-30')!;
  assert.equal(jun.basis, 'derived');
  assert.equal(jun.value, 15);
  assert.match(jun.derivedFrom ?? '', /cumulative/);
  const mar = q.find((x) => x.periodEnd === '2025-03-31')!;
  assert.equal(mar.basis, 'reported');
});

test('a quarter that can be neither found nor derived is OMITTED, not zero', () => {
  // only a full year, with no stepping stones at all
  const q = toQuarters([f('2025-01-01', '2025-12-31', 100, { form: '10-K' })], 'flow');
  assert.equal(q.length, 0, 'must produce nothing rather than a fabricated quarter');
});

test('stocks take the instant, never a duration', () => {
  const q = toQuarters([
    f(undefined, '2026-03-31', 40.26),
    f('2026-01-01', '2026-03-31', 999),   // a duration fact must be ignored
  ], 'stock');
  assert.equal(q.length, 1);
  assert.equal(q[0].value, 40.26);
});

test('restatements: the most recently FILED value wins', () => {
  const q = toQuarters([
    f('2025-01-01', '2025-03-31', 10, { filed: '2025-04-30' }),
    f('2025-01-01', '2025-03-31', 12, { filed: '2025-08-01', accn: 'AMENDED' }),
  ], 'flow');
  assert.equal(q.length, 1);
  assert.equal(q[0].value, 12, 'the amended figure supersedes the original');
  assert.equal(q[0].accn, 'AMENDED', 'and the citation points at the amendment');
});

test('duplicate identical facts collapse to one quarter', () => {
  const q = toQuarters([
    f('2025-01-01', '2025-03-31', 10),
    f('2025-01-01', '2025-03-31', 10),
  ], 'flow');
  assert.equal(q.length, 1);
});

test('forms other than 10-Q and 10-K are ignored', () => {
  const q = toQuarters([
    f('2025-01-01', '2025-03-31', 10, { form: '8-K' }),
    f('2025-01-01', '2025-03-31', 11, { form: 'S-1' }),
  ], 'flow');
  assert.equal(q.length, 0);
});

test('a 52/53-week fiscal quarter still counts as a quarter', () => {
  // Nvidia's quarters end on a Sunday and vary 84-98 days
  const q = toQuarters([f('2026-04-28', '2026-07-26', 2.68)], 'flow');
  assert.equal(q.length, 1, '89-day fiscal quarter must be recognised');
});

test('an unresolvable concept reports MISSING with a reason, not zero', () => {
  const s = extractConcept({}, conceptById.get('cip')!);
  assert.equal(s.quarters.length, 0);
  assert.match(s.missing ?? '', /NOT DISCLOSED/);
  assert.deepEqual(s.tags, []);
});

test('a multi-tag chain sums only periods present in EVERY part', () => {
  const s = extractConcept({
    Depreciation: { units: { USD: [f('2025-01-01', '2025-03-31', 8), f('2025-04-01', '2025-06-30', 9)] } },
    AmortizationOfIntangibleAssets: { units: { USD: [f('2025-01-01', '2025-03-31', 1)] } },
  }, conceptById.get('da')!);
  assert.equal(s.quarters.length, 1, 'the un-paired quarter must be dropped, not half-counted');
  assert.equal(s.quarters[0].value, 9);
  assert.deepEqual(s.tags, ['Depreciation', 'AmortizationOfIntangibleAssets']);
});

test('a stale chain loses to a current one, whatever the preference order', () => {
  // Microsoft's real case: InterestExpense retired after FY2024,
  // InterestExpenseNonoperating current.
  const s = extractConcept({
    InterestExpense: { units: { USD: [f('2024-01-01', '2024-03-31', 0.8, { filed: '2024-04-01' })] } },
    InterestExpenseNonoperating: { units: { USD: [f('2026-04-01', '2026-06-30', 0.84, { filed: '2026-07-29' })] } },
  }, conceptById.get('interest_expense')!);
  assert.deepEqual(s.tags, ['InterestExpenseNonoperating'], 'the abandoned tag must not win on order alone');
});

test('preference order still decides between two current chains', () => {
  const s = extractConcept({
    RevenueFromContractWithCustomerExcludingAssessedTax: { units: { USD: [f('2026-04-01', '2026-06-30', 90)] } },
    Revenues: { units: { USD: [f('2026-04-01', '2026-06-30', 91)] } },
  }, conceptById.get('revenue')!);
  assert.deepEqual(s.tags, ['RevenueFromContractWithCustomerExcludingAssessedTax']);
});

test('every concept declares a kind and at least one chain', () => {
  for (const c of CONCEPTS) {
    assert.ok(c.chains.length > 0, `${c.id} needs a chain`);
    assert.ok(c.kind === 'flow' || c.kind === 'stock', `${c.id} needs a kind`);
  }
});

test('the filing URL points at the real EDGAR index', () => {
  const u = filingUrl('0000789019', '0001193125-26-323660');
  assert.equal(u, 'https://www.sec.gov/Archives/edgar/data/789019/000119312526323660/0001193125-26-323660-index.htm');
});
