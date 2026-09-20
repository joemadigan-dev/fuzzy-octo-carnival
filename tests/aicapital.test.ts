// Capital-efficiency arithmetic.
//
// Every test here exists because the corresponding mistake would produce a
// PLAUSIBLE number rather than an obvious failure: a three-quarter TTM
// that looks like a year, a ratio inflated by a denominator that barely
// moved, a free cash flow computed against a quarter that only one of its
// two inputs has. Those are the ones that get believed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ttm, trailingFour, yearAgo, latestCommon, incremental, ratio, minus,
  companyMetrics, type Quarter, type Series,
} from '../src/compute/ai-capital-metrics.ts';

const BN = 1e9;
const q = (periodEnd: string, value: number): Quarter =>
  ({ periodEnd, value: value * BN, basis: 'reported', accn: 'A', filed: '2026-07-29', form: '10-Q' });

/** Four calendar quarters of a given year, each worth `v`. */
const year = (y: number, v: number): Series =>
  [q(`${y}-03-31`, v), q(`${y}-06-30`, v), q(`${y}-09-30`, v), q(`${y}-12-31`, v)];

test('a trailing year is four quarters or nothing', () => {
  const s = year(2025, 10);
  assert.equal(ttm(s, '2025-12-31', 'Capex').value, 40);
  // only three quarters precede 2025-09-30
  const partial = ttm(s, '2025-09-30', 'Capex');
  assert.equal(partial.value, null, 'three quarters must not be summed and called a year');
  assert.match(partial.unknown ?? '', /fewer than four/);
});

test('a gap in the stored quarters is not papered over', () => {
  // 2025 Q2 missing: the four "consecutive" rows span 21 months
  const s = [q('2024-09-30', 10), q('2024-12-31', 10), q('2025-03-31', 10), q('2025-12-31', 10)];
  assert.equal(trailingFour(s, '2025-12-31'), null);
  assert.equal(ttm(s, '2025-12-31', 'Capex').value, null, 'a gappy window must not become a TTM');
});

test('a 52/53-week fiscal year is still a year', () => {
  // Nvidia: quarters end on a Sunday, the year spans 364 days
  const s = [q('2025-10-26', 1), q('2026-01-25', 1), q('2026-04-26', 1), q('2026-07-26', 1)];
  assert.equal(ttm(s, '2026-07-26', 'Capex').value, 4, 'a Sunday-ending fiscal year must not be rejected as gappy');
});

test('a non-calendar fiscal year is still a year', () => {
  // Oracle: quarters end Aug/Nov/Feb/May
  const s = [q('2025-11-30', 1), q('2026-02-28', 1), q('2026-05-31', 1), q('2026-08-31', 1)];
  assert.equal(ttm(s, '2026-08-31', 'Capex').value, 4);
});

test('the year-ago quarter is four positions back, not 365 days back', () => {
  const s = [q('2025-08-31', 1), q('2025-11-30', 1), q('2026-02-28', 1), q('2026-05-31', 1), q('2026-08-31', 1)];
  assert.equal(yearAgo(s, '2026-08-31'), '2025-08-31');
  assert.equal(yearAgo(s, '2026-05-31'), null, 'not enough history is null, not the oldest available');
});

test('TTM figures come back in billions, not raw dollars', () => {
  assert.equal(ttm(year(2025, 28.9875), '2025-12-31', 'Capex').value, 115.95);
});

// ── incremental returns ───────────────────────────────────────────────

const M = (v: number | null) => v === null
  ? { value: null, unit: 'usd_bn' as const, unknown: 'unavailable' }
  : { value: v, unit: 'usd_bn' as const, periods: ['2026-06-30'] };

test('incremental return is the change in profit over the change in capital', () => {
  // profit +20, capital base 100 → 150
  const r = incremental(M(120), M(100), 150 * BN, 100 * BN, { num: 'Operating income', den: 'The capital base' });
  assert.equal(r.value, 0.4, '20 more profit on 50 more capital is 40%');
  assert.equal(r.unit, 'fraction');
});

test('a capital base that barely moved refuses to be a denominator', () => {
  // +20 profit on +1 of a 100 base would read as 2000%
  const r = incremental(M(120), M(100), 101 * BN, 100 * BN, { num: 'Operating income', den: 'The capital base' });
  assert.equal(r.value, null, 'a 1% move in the base must not produce a 2000% return');
  assert.match(r.unknown ?? '', /less than 2%/);
});

test('a shrinking capital base yields UNKNOWN, not a negative-denominator ratio', () => {
  const r = incremental(M(120), M(100), 80 * BN, 100 * BN, { num: 'Operating income', den: 'The capital base' });
  assert.equal(r.value, null);
  assert.match(r.unknown ?? '', /did not grow/);
  assert.ok(!/-/.test(String(r.value)), 'sign confusion here would invert the finding');
});

test('falling profit on a growing base is reported as negative, not suppressed', () => {
  const r = incremental(M(80), M(100), 150 * BN, 100 * BN, { num: 'Free cash flow', den: 'The capital base' });
  assert.equal(r.value, -0.4, 'a genuinely negative incremental return is the finding, not an error');
});

test('a missing input propagates its reason rather than a zero', () => {
  const r = incremental(M(null), M(100), 150 * BN, 100 * BN, { num: 'Operating income', den: 'The capital base' });
  assert.equal(r.value, null);
  assert.equal(r.unknown, 'unavailable');
});

test('a missing capital base says so specifically', () => {
  const r = incremental(M(120), M(100), null, 100 * BN, { num: 'Operating income', den: 'The capital base' });
  assert.match(r.unknown ?? '', /not available for both period ends/);
});

test('a ratio refuses a zero denominator', () => {
  assert.equal(ratio(M(10), M(0), 'Capex intensity').value, null);
});

// ── series arithmetic ─────────────────────────────────────────────────

test('free cash flow drops quarters only one side reports', () => {
  const ocf = [q('2025-03-31', 10), q('2025-06-30', 12)];
  const capex = [q('2025-06-30', 4)];
  const fcf = minus(ocf, capex);
  assert.equal(fcf.length, 1, 'a quarter with OCF but no capex must not become FCF = OCF');
  assert.equal(fcf[0].value / BN, 8);
});

test('free cash flow inherits derived provenance from either side', () => {
  const ocf = [{ ...q('2025-06-30', 12), basis: 'reported' as const }];
  const capex = [{ ...q('2025-06-30', 4), basis: 'derived' as const }];
  assert.equal(minus(ocf, capex)[0].basis, 'derived');
});

test('balance-sheet items are paired on a date both actually report', () => {
  // Oracle's shape: borrowings annual, cash quarterly
  const debt = [q('2025-05-31', 92), q('2026-05-31', 129)];
  const cash = [q('2026-02-28', 38), q('2026-05-31', 31), q('2026-08-31', 36)];
  assert.equal(latestCommon([debt, cash]), '2026-05-31',
    'pairing May borrowings with August cash would invent a net debt figure');
  assert.equal(latestCommon([debt, []]), null);
});

// ── the assembled company view ────────────────────────────────────────

function concepts(over: Partial<Record<string, Series>> = {}): Record<string, Series> {
  const base: Record<string, Series> = {
    revenue: [...year(2024, 100), ...year(2025, 120)],
    capex: [...year(2024, 20), ...year(2025, 40)],
    ocf: [...year(2024, 50), ...year(2025, 55)],
    operating_income: [...year(2024, 30), ...year(2025, 36)],
    ppe_gross: [...year(2024, 200), ...year(2025, 300)],
    ppe: [...year(2024, 150), ...year(2025, 220)],
    debt: [...year(2024, 40), ...year(2025, 60)],
    cash: [...year(2024, 30), ...year(2025, 25)],
  };
  return { ...base, ...over } as Record<string, Series>;
}

test('the reference quarter needs both revenue and capex, not just any concept', () => {
  // a balance-sheet item filed for a later quarter must not set the period
  const c = concepts({ debt: [...year(2024, 40), ...year(2025, 60), q('2026-03-31', 70)] });
  assert.equal(companyMetrics('TEST', c).periodEnd, '2025-12-31');
});

test('capex intensity is capex over revenue, as a fraction', () => {
  const m = companyMetrics('TEST', concepts()).measures;
  assert.equal(m.capex_intensity.value, 160 / 480);
  assert.equal(m.capex_intensity.unit, 'fraction');
});

test('the gross capital base is preferred and named', () => {
  const m = companyMetrics('TEST', concepts()).measures;
  // TTM opinc 144 vs 120 = +24; gross base 300 - 200 = +100 → 24%
  assert.equal(m.incr_opinc_on_capital.value, 0.24);
  assert.match(m.incr_opinc_on_capital.basisNote ?? '', /before depreciation/);
});

test('with no gross base it falls back to net and says it is not comparable', () => {
  const c = concepts();
  delete c.ppe_gross;
  const m = companyMetrics('TEST', c).measures;
  // net base 220 - 150 = +70 → 24/70
  assert.ok(Math.abs((m.incr_opinc_on_capital.value ?? 0) - 24 / 70) < 1e-9);
  assert.match(m.incr_opinc_on_capital.basisNote ?? '', /not directly comparable/i);
});

test('with no capital base at all the incremental measures are UNKNOWN, not zero', () => {
  const c = concepts();
  delete c.ppe_gross;
  delete c.ppe;
  const m = companyMetrics('TEST', c).measures;
  assert.equal(m.incr_opinc_on_capital.value, null);
  assert.equal(m.incr_ocf_on_capital.value, null);
  // the capex-only variant needs no balance sheet and must still work
  assert.ok(m.incr_opinc_per_capex.value !== null, 'the measure that needs no balance sheet must survive');
});

test('a company with no capex at all yields no period and no measures', () => {
  const c = concepts();
  delete c.capex;
  const m = companyMetrics('TEST', c);
  assert.equal(m.periodEnd, null);
  assert.deepEqual(m.measures, {});
});

test('every measure declares a unit', () => {
  const m = companyMetrics('TEST', concepts()).measures;
  for (const [id, meas] of Object.entries(m)) {
    assert.ok(['usd_bn', 'ratio', 'fraction'].includes(meas.unit), `${id} has no declared unit`);
  }
});

test('a balance sheet older than the flows carries that date, not the flows date', () => {
  const c = concepts({ debt: [...year(2024, 40), q('2025-03-31', 60)] });
  const m = companyMetrics('TEST', c).measures;
  assert.deepEqual(m.net_debt.periods, ['2025-03-31']);
  assert.match(m.net_debt.basisNote ?? '', /Balance sheet as of 2025-03-31/);
});

test('every stored value is cited to the filing it came from', () => {
  const m = companyMetrics('TEST', concepts());
  assert.equal(m.accn, 'A');
  assert.equal(m.filed, '2026-07-29');
});
