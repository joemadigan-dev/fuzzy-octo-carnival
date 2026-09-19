// Unit semantics — the class of bug that silently invalidates a dashboard.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asBn, asBp, asPercent, unitOf, UNITS } from '../src/scoring/units.ts';
import thresholds from '../config/thresholds.json' with { type: 'json' };

test('the Market Cap / GDP bug: 2.56 ratio is 256 percent', () => {
  assert.ok(Math.abs(asPercent('eq_gdp', 2.56) - 256) < 1e-9);
  assert.equal(unitOf('eq_gdp'), 'ratio');
});

test('2.56 ratio crosses the 160% extreme valuation threshold', () => {
  const extreme = thresholds.bust.valuation.mcap_gdp_extreme;
  assert.equal(extreme, 160);
  assert.ok(asPercent('eq_gdp', 2.56) >= extreme, 'must register as extreme');
  // and the raw value must NOT — this is the failure being locked out
  assert.ok(2.56 < extreme, 'raw ratio would read as normal, which was the bug');
});

test('credit spreads are stored in percent, so bp conversion is x100', () => {
  assert.equal(unitOf('hy_oas'), 'percent');
  assert.equal(asBp('hy_oas', 2.70), 270);
  assert.equal(asPercent('hy_oas', 2.70), 2.70);
});

test('yields are percent and the curve in bp is (10y - 2y) x 100', () => {
  assert.equal(unitOf('us10y'), 'percent');
  assert.equal(unitOf('us2y'), 'percent');
  const curveBp = (4.94 - 4.67) * 100;
  assert.ok(Math.abs(curveBp - 27) < 1e-9);
});

test('the Fed balance sheet is stored in $tn and reports in $bn', () => {
  assert.equal(unitOf('walcl'), 'usd_tn');
  assert.equal(asBn('walcl', 6.75), 6750);
  // a 13-week change of 0.5tn is the $500bn intervention threshold
  assert.equal(asBn('walcl', 0.5), thresholds.liquidity.walcl_qe_13w_bn);
});

test('sofr_iorb and the real-yield impulse are already basis points', () => {
  assert.equal(unitOf('sofr_iorb'), 'bp');
  assert.equal(asBp('sofr_iorb', -2), -2);
  assert.equal(asPercent('real_yield_impulse', 75), 0.75);
});

test('scoring an undeclared series throws rather than guessing', () => {
  assert.throws(() => unitOf('not_a_real_series'), /no unit declared/);
});

test('a unit that has no percent meaning refuses to convert', () => {
  assert.equal(unitOf('spx'), 'index');
  assert.throws(() => asPercent('spx', 7651), /no meaning in percent/);
  assert.throws(() => asBn('gold', 4425), /no meaning in billions/);
});

test('every series the cockpit scores has a declared unit', () => {
  for (const id of ['eq_gdp', 'erp', 'hy_oas', 'ccc_oas', 'bb_oas', 'ig_oas',
    'us10y', 'us2y', 'vix', 'walcl', 'net_liq', 'spx', 'gold', 'silver',
    'copper', 'wti', 'put_call', 'breadth_conf', 'margin_debt', 'sofr_iorb']) {
    assert.ok(UNITS[id], `${id} must declare a unit`);
  }
});
