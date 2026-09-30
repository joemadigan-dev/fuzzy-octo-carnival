// Zero-coupon STRIP maths.
//
// The failure this locks out is a fabricated price for a named CUSIP. The
// table must come out of the current proxy yield and the real remaining
// maturity every time, and it must refuse to produce anything at all when
// it has no yield to work from.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STRIP, yearsBetween, zeroPrice, modifiedDuration, convexity, stripPayoff,
  DEFAULT_SHIFTS_BP,
} from '../src/compute/duration.ts';

const near = (a: number, b: number, tol: number, what: string) =>
  assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b} (tol ${tol})`);

// ── the reference security ────────────────────────────────────────────

test('the reference security is the one in the brief and is not configurable', () => {
  assert.equal(STRIP.cusip, '912803HS5');
  assert.equal(STRIP.maturity, '2056-02-15');
  assert.equal(STRIP.coupon, 0);
});

test('remaining maturity is measured, never assumed', () => {
  near(yearsBetween('2026-09-30', '2056-02-15'), 29.38, 0.02, 'years to 2056');
  // and it shrinks as time passes, which is the whole point of roll-down
  const a = yearsBetween('2026-09-30', STRIP.maturity);
  const b = yearsBetween('2027-09-30', STRIP.maturity);
  near(a - b, 1, 0.01, 'one year later is one year shorter');
});

// ── pricing ───────────────────────────────────────────────────────────

test('a zero prices at par when the yield is zero', () => {
  near(zeroPrice(0, 29.38), 100, 1e-9, 'par at 0%');
});

test('price falls as yield rises, monotonically', () => {
  let prev = Infinity;
  for (const y of [0, 1, 2, 3, 4, 5, 6, 8, 10]) {
    const p = zeroPrice(y, 29.38);
    assert.ok(p < prev, `price must fall from ${y - 1}% to ${y}%`);
    prev = p;
  }
});

test('the semi-annual convention is the Treasury one, not annual', () => {
  // 5% for 10 years: semi-annual gives 100/1.025^20, annual would give
  // 100/1.05^10. They differ by ~0.6 points and only one is right.
  near(zeroPrice(5, 10), 100 / Math.pow(1.025, 20), 1e-9, 'semi-annual');
  const annual = 100 / Math.pow(1.05, 10);
  const rel = Math.abs(zeroPrice(5, 10) - annual) / annual;
  assert.ok(rel > 0.004,
    `must not be annual compounding — the two conventions differ by ${(rel * 100).toFixed(2)}%`);
});

test('nonsense inputs give NaN rather than a number', () => {
  for (const [y, t] of [[NaN, 29], [5, NaN], [5, 0], [5, -3], [-250, 29]] as [number, number][]) {
    assert.ok(Number.isNaN(zeroPrice(y, t)), `zeroPrice(${y}, ${t}) must be NaN`);
  }
});

test('duration of a zero is its maturity, discounted one period', () => {
  near(modifiedDuration(5.56, 29.38), 29.38 / 1.0278, 1e-6, 'modified duration');
  // the brief says ~28-29 years; this is the check that we are in that world
  const d = modifiedDuration(5.56, 29.38);
  assert.ok(d > 28 && d < 29, `expected ~28-29y, got ${d}`);
});

test('convexity is large and positive — that is the thesis', () => {
  const c = convexity(5.56, 29.38);
  assert.ok(c > 700, `a 29-year zero should be very convex, got ${c}`);
});

// ── the payoff table ──────────────────────────────────────────────────

test('the worked example in the brief reproduces', () => {
  // brief: "-100bp | +~40% | $10,000 -> ~$14,000" at the current proxy
  const p = stripPayoff(5.56, '2026-09-30')!;
  const down100 = p.rows.find((r) => r.shiftBp === -100)!;
  near(down100.returnPct, 39.4, 0.6, '-100bp return');
  near(down100.valueEnd, 13940, 80, '-100bp on $10,000');
});

test('the zero-shift row earns the yield, not nothing', () => {
  // A zero held for a year with an unchanged curve rolls down one year of
  // discounting. Reporting 0% there would understate the base case.
  const p = stripPayoff(5.56, '2026-09-30')!;
  const flat = p.rows.find((r) => r.shiftBp === 0)!;
  near(flat.returnPct, 5.64, 0.15, 'roll-down at an unchanged yield');
});

test('the table is symmetric in shifts but convex in outcome', () => {
  const p = stripPayoff(5.56, '2026-09-30')!;
  const up = p.rows.find((r) => r.shiftBp === 150)!;
  const down = p.rows.find((r) => r.shiftBp === -150)!;
  assert.ok(down.returnPct > 0 && up.returnPct < 0, 'signs must be opposite');
  assert.ok(down.returnPct > Math.abs(up.returnPct),
    `convexity means the gain exceeds the loss: +${down.returnPct} vs ${up.returnPct}`);
});

test('a rise in yields is shown at full size, not softened', () => {
  const p = stripPayoff(5.56, '2026-09-30')!;
  const up150 = p.rows.find((r) => r.shiftBp === 150)!;
  assert.ok(up150.returnPct < -25,
    `+150bp on a 29-year zero is a large loss; got ${up150.returnPct}%`);
  assert.ok(up150.valueEnd < 7500, 'the dollar column must show it too');
});

test('every shift in the brief is present', () => {
  const p = stripPayoff(5.56, '2026-09-30')!;
  assert.deepEqual(p.rows.map((r) => r.shiftBp), DEFAULT_SHIFTS_BP);
  assert.deepEqual(DEFAULT_SHIFTS_BP, [-150, -100, -50, 0, 50, 100, 150]);
});

test('the table is computed from the inputs, never hard-coded', () => {
  // Same shift, two different proxy yields -> different returns. If any
  // row were a constant this fails.
  const lo = stripPayoff(3.0, '2026-09-30')!.rows.find((r) => r.shiftBp === -100)!;
  const hi = stripPayoff(7.0, '2026-09-30')!.rows.find((r) => r.shiftBp === -100)!;
  assert.notEqual(lo.returnPct.toFixed(4), hi.returnPct.toFixed(4));
  // and a later valuation date has less maturity left, so less sensitivity
  const early = stripPayoff(5.56, '2026-09-30')!.rows.find((r) => r.shiftBp === -100)!;
  const late = stripPayoff(5.56, '2046-09-30')!.rows.find((r) => r.shiftBp === -100)!;
  assert.ok(early.returnPct > late.returnPct * 2,
    'a 29-year zero must be far more sensitive than a 9-year one');
});

test('notional scales the dollar column and nothing else', () => {
  const a = stripPayoff(5.56, '2026-09-30', 10000)!;
  const b = stripPayoff(5.56, '2026-09-30', 25000)!;
  for (const [x, y] of a.rows.map((r, i) => [r, b.rows[i]] as const)) {
    near(x.returnPct, y.returnPct, 1e-12, 'returns are notional-independent');
    near(y.valueEnd / x.valueEnd, 2.5, 1e-9, 'dollars scale');
  }
});

// ── refusing to invent ────────────────────────────────────────────────

test('no proxy yield means no table at all', () => {
  assert.equal(stripPayoff(null, '2026-09-30'), null);
  assert.equal(stripPayoff(5.56, null), null);
  assert.equal(stripPayoff(null, null), null);
});

test('a maturity inside the holding period yields nothing rather than nonsense', () => {
  assert.equal(stripPayoff(5.56, '2055-09-30'), null, 'under a year to run');
  assert.equal(stripPayoff(5.56, '2060-01-01'), null, 'already matured');
});

test('the caveat and the proxy are carried in the payload, not left to the UI', () => {
  const p = stripPayoff(5.56, '2026-09-30')!;
  assert.match(p.caveat, /not a forecast/i);
  assert.match(p.caveat, /proxy/i);
  assert.match(p.caveat, /912803HS5/, 'must name the CUSIP it is NOT quoting');
  assert.match(p.proxy, /DGS30/);
  assert.equal(p.proxyAsOf, '2026-09-30', 'the source date travels with the number');
});

// ── the 2027 recession map ────────────────────────────────────────────
//
// The panel's whole purpose is that three of its four rows involve a
// recession and they do not share a sign. If they ever did, the module
// would have quietly become "recession = buy bonds".

test('the recession scenarios do not share a sign', async () => {
  const { scenarioMap } = await import('../src/scoring/duration-scenarios.ts');
  const s = scenarioMap(stripPayoff(5.56, '2026-09-30'));
  const stag = s.find((x) => x.id === 'stagflation')!;
  const disi = s.find((x) => x.id === 'disinflationary')!;
  assert.ok(stag.returnPct! < 0, `stagflation must be negative, got ${stag.returnPct}`);
  assert.ok(disi.returnPct! > 0, `disinflationary must be positive, got ${disi.returnPct}`);
  assert.equal(stag.implication, 'Negative');
});

test('the four scenarios are ordered adverse-first and are all present', async () => {
  const { scenarioMap } = await import('../src/scoring/duration-scenarios.ts');
  const s = scenarioMap(stripPayoff(5.56, '2026-09-30'));
  assert.deepEqual(s.map((x) => x.id),
    ['stagflation', 'mild', 'disinflationary', 'deep']);
});

test('deeper rate falls are increasingly convex, not linear', async () => {
  const { scenarioMap } = await import('../src/scoring/duration-scenarios.ts');
  const payoff = stripPayoff(5.56, '2026-09-30')!;
  const s = scenarioMap(payoff);
  // Convexity does NOT show up as a rising return per basis point — the
  // fixed roll-down component dilutes that ratio and it is not monotonic.
  // It shows up as a growing EXCESS over what modified duration alone
  // predicts, which is the textbook signature and the thing that makes a
  // zero worth holding rather than a shorter bond.
  const roll = payoff.rows.find((r) => r.shiftBp === 0)!.returnPct;
  const linear = (shiftBp: number) => roll + payoff.modifiedDuration * (-shiftBp / 100);
  const excess = (id: string) => {
    const x = s.find((y) => y.id === id)!;
    return x.returnPct! - linear(x.shiftBp);
  };
  const mild = excess('mild'), disi = excess('disinflationary'), deep = excess('deep');
  assert.ok(mild > 0 && disi > mild && deep > disi,
    `excess over the linear estimate must grow with the move: ${mild} < ${disi} < ${deep}`);
});

test('convexity softens the adverse case as well as amplifying the good one', async () => {
  const { scenarioMap } = await import('../src/scoring/duration-scenarios.ts');
  const payoff = stripPayoff(5.56, '2026-09-30')!;
  const stag = scenarioMap(payoff).find((x) => x.id === 'stagflation')!;
  const roll = payoff.rows.find((r) => r.shiftBp === 0)!.returnPct;
  const linear = roll + payoff.modifiedDuration * (-stag.shiftBp / 100);
  assert.ok(stag.returnPct! > linear,
    `the loss should be smaller than linear duration implies: ${stag.returnPct} vs ${linear}`);
  // but it is still a large loss, and must be shown as one
  assert.ok(stag.returnPct! < -10, `still materially negative, got ${stag.returnPct}`);
});

test('no scenario carries a probability', async () => {
  const { scenarioMap } = await import('../src/scoring/duration-scenarios.ts');
  for (const s of scenarioMap(stripPayoff(5.56, '2026-09-30'))) {
    const text = `${s.label} ${s.yieldPath} ${s.implication} ${s.mechanism}`;
    assert.doesNotMatch(text, /\b\d+\s?%\s?(chance|probability|likely)|\bprobability\b|\bodds\b/i,
      `invented a likelihood: ${text}`);
    assert.equal((s as Record<string, unknown>).probability, undefined);
  }
});

test('scenarios state their logic even with no yield to price them', async () => {
  const { scenarioMap } = await import('../src/scoring/duration-scenarios.ts');
  const s = scenarioMap(null);
  assert.equal(s.length, 4);
  for (const x of s) {
    assert.equal(x.returnPct, null, 'no invented figure');
    assert.equal(x.valueEnd, null);
    assert.ok(x.mechanism.length > 40, 'but the reasoning survives');
  }
});

test('scenario figures move with the curve', async () => {
  const { scenarioMap } = await import('../src/scoring/duration-scenarios.ts');
  const a = scenarioMap(stripPayoff(5.56, '2026-09-30'));
  const b = scenarioMap(stripPayoff(3.00, '2026-09-30'));
  const ra = a.find((x) => x.id === 'disinflationary')!.returnPct!;
  const rb = b.find((x) => x.id === 'disinflationary')!.returnPct!;
  assert.notEqual(ra.toFixed(3), rb.toFixed(3), 'must not be hard-coded');
});
