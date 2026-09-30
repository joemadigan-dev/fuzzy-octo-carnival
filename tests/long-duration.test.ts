// LONG DURATION / TREASURY CONVEXITY.
//
// The failure this file exists to lock out is the syllogism "recession is
// coming, therefore long bonds". A 29-year zero is indifferent to GDP; it
// responds to the long discount rate. So the tests that matter most here
// are the ones that hold the score DOWN: growth deteriorating while
// inflation accelerates must score nothing from the macro pillar, and no
// amount of recession evidence may produce an EXCEPTIONAL reading while
// the stagflation veto is live.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Point } from '../src/sources/types.ts';
import {
  longDurationSetup, decompose, bandOf, percentileOfLatest,
  type MacroInputs,
} from '../src/scoring/long-duration.ts';
import thresholds from '../config/thresholds.json' with { type: 'json' };

const T = thresholds.long_duration;
const DAY = 86400000;
const END = Date.UTC(2026, 8, 30); // 2026-09-30

/** A daily series of `n` business-ish days ending at END, built by a
 *  function of the index so a trend can be dialled in. */
function series(n: number, f: (i: number, n: number) => number): Point[] {
  const out: Point[] = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(END - (n - 1 - i) * DAY);
    out.push({ date: d.toISOString().slice(0, 10), value: f(i, n) });
  }
  return out;
}

/** Flat history then a linear ramp over the last `rampDays`. */
const ramp = (n: number, from: number, to: number, rampDays: number) =>
  series(n, (i) => {
    const start = n - rampDays;
    if (i < start) return from;
    return from + ((to - from) * (i - start)) / (rampDays - 1);
  });

/** A long rise to `peak`, then a recent move to `end` over `moveDays`.
 *
 *  This shape, not a flat-then-move ramp, is what the percentile pillar
 *  actually has to read in production: a 30Y real yield that climbed for a
 *  decade and has just eased 15bp is still near the top of its own
 *  distribution. A flat-then-decline fixture puts the latest value at the
 *  BOTTOM of its history and the module correctly scores it as expensive —
 *  which is right, and made the first version of these tests wrong. */
const trendThenMove = (n: number, from: number, peak: number, end: number, moveDays: number) =>
  series(n, (i) => {
    const start = n - moveDays;
    if (i < start) return from + ((peak - from) * i) / (start - 1);
    return peak + ((end - peak) * (i - start)) / (moveDays - 1);
  });

/** Monthly index series (for core CPI), `months` points ending at END. */
function monthly(months: number, f: (i: number) => number): Point[] {
  const out: Point[] = [];
  for (let i = 0; i < months; i++) {
    const d = new Date(Date.UTC(2026, 8 - (months - 1 - i), 1));
    out.push({ date: d.toISOString().slice(0, 10), value: f(i) });
  }
  return out;
}

/** Core CPI index growing at a steady annual `pct`, optionally
 *  accelerating to `recentPct` over the last three months. */
function coreCpi(pct: number, recentPct = pct): Point[] {
  return monthly(40, (i) => {
    let v = 300;
    for (let k = 1; k <= i; k++) {
      const r = k > 40 - 4 ? recentPct : pct;
      v *= Math.pow(1 + r / 100, 1 / 12);
    }
    return v;
  });
}

// ── macro-input stubs ─────────────────────────────────────────────────

const macro = (o: {
  bust?: number; onset?: number; credit?: number; stage?: string;
  phase?: string; rateLeg?: string; regime?: string;
} = {}): MacroInputs => ({
  phase: { phase: o.phase ?? 'NORMAL / PRE-MELT-UP' } as MacroInputs['phase'],
  bust: { score: o.bust ?? 0, level: 'NORMAL', onset: o.onset ?? 0 } as MacroInputs['bust'],
  credit: { score: o.credit ?? 0, stage: o.stage ?? 'CALM' } as MacroInputs['credit'],
  liquidity: {
    rateLeg: o.rateLeg ?? 'RATES STABLE',
    regime: o.regime ?? 'NEUTRAL',
  } as MacroInputs['liquidity'],
});

// ── series worlds ─────────────────────────────────────────────────────

/** Cheap long duration: 30Y real yield at the top of its own history. */
function cheapValuation(): Map<string, Point[]> {
  const m = new Map<string, Point[]>();
  m.set('us30y', series(1200, (i, n) => 2 + (3.6 * i) / n));        // ends ~5.6
  m.set('us30y_real', series(1200, (i, n) => 0.3 + (3.0 * i) / n)); // ends ~3.3
  m.set('term_premium', series(1200, (i, n) => -0.2 + (1.2 * i) / n));
  m.set('us2y', series(300, () => 4.9));
  m.set('wti', series(300, () => 96));
  return m;
}

const setBe = (m: Map<string, Point[]>) => {
  const nom = m.get('us30y')!, real = m.get('us30y_real')!;
  m.set('be30', nom.map((p, i) => ({ date: p.date, value: p.value - real[i].value })));
  return m;
};

/** Inflation falling: breakeven down, core disinflating, oil down. Long
 *  yields remain historically high — they eased, they did not collapse. */
function disinflation(m: Map<string, Point[]>): Map<string, Point[]> {
  m.set('us30y', trendThenMove(1200, 2.0, 5.6, 5.25, 90));      // breakeven -20bp
  m.set('us30y_real', trendThenMove(1200, 0.3, 3.3, 3.15, 90));
  setBe(m);
  m.set('core_cpi', coreCpi(3.2, 1.6));
  m.set('wti', ramp(300, 96, 78, 91));
  return m;
}

/** Inflation accelerating: breakeven up hard, core hot, oil shock. */
function stagflation(m: Map<string, Point[]>): Map<string, Point[]> {
  m.set('us30y', trendThenMove(1200, 2.0, 5.2, 6.0, 90));       // breakeven +75bp
  m.set('us30y_real', trendThenMove(1200, 0.3, 3.3, 3.35, 90));
  setBe(m);
  m.set('core_cpi', coreCpi(2.6, 5.2));
  m.set('wti', ramp(300, 78, 112, 91));
  return m;
}

const recessionMacro = () => macro({
  bust: 4.0, onset: 1.6, credit: 3.0, stage: 'SYSTEMIC CREDIT STRESS',
  phase: 'BUST UNDERWAY', rateLeg: 'RATES COLLAPSING — DEFLATIONARY CONFIRMATION',
});

// ══ THE CENTRAL GUARANTEE ═════════════════════════════════════════════

test('recession alone does NOT produce a long-duration signal when inflation is accelerating', () => {
  const r = longDurationSetup(stagflation(cheapValuation()), recessionMacro());

  assert.equal(r.inflationCompatibility, 0,
    'accelerating inflation must zero the gate, not merely reduce it');
  assert.equal(r.pillars.macro, 0,
    `the macro pillar must contribute nothing, got ${r.pillars.macro}`);
  assert.equal(r.regime, 'Stagflation');
  assert.equal(r.veto.state, 'ACTIVE');
  assert.ok(r.score.score <= T.veto.cap_active,
    `capped at ${T.veto.cap_active}, got ${r.score.score}`);
  assert.ok(!['ATTRACTIVE', 'EXCEPTIONAL'].includes(r.band),
    `band must not be favourable, got ${r.band}`);
});

test('the withheld macro evidence is stated, not silently dropped', () => {
  const r = longDurationSetup(stagflation(cheapValuation()), recessionMacro());
  const gate = r.contradicting.find((s) => s.includes('MACRO PILLAR SCORED ZERO'));
  assert.ok(gate, 'the gate must explain itself in the evidence list');
  assert.match(gate!, /pts of macro evidence/,
    'it must say how much evidence was withheld');
  assert.match(gate!, /deliberately withheld/);
});

test('the same recession WITH falling inflation scores materially higher', () => {
  const stag = longDurationSetup(stagflation(cheapValuation()), recessionMacro());
  const disi = longDurationSetup(disinflation(cheapValuation()), recessionMacro());

  assert.equal(disi.inflationCompatibility, 1);
  assert.ok(disi.pillars.macro > 1.2,
    `macro pillar should be near its 1.75 cap, got ${disi.pillars.macro}`);
  assert.ok(disi.score.score >= stag.score.score + 1.5,
    `disinflationary recession ${disi.score.score} must clearly exceed stagflationary ${stag.score.score}`);
  assert.equal(disi.regime, 'Disinflationary recession');
});

test('growth weakness with no inflation move is a slowdown, not a recession call', () => {
  const m = disinflation(cheapValuation());
  const r = longDurationSetup(m, macro({ bust: 2.6, credit: 1.6, stage: 'SPECULATIVE CREDIT DETERIORATING' }));
  assert.equal(r.regime, 'Disinflationary slowdown');
});

// ══ the regime that looks like an opportunity and is not ═══════════════

test('fiscal / term-premium stress is identified and checked before stagflation', () => {
  // Long real yields rising hard, term premium at an extreme, breakevens
  // NOT moving. That is the market demanding more to fund the long end.
  const m = cheapValuation();
  m.set('us30y', ramp(1200, 5.0, 5.9, 90));
  m.set('us30y_real', ramp(1200, 2.5, 3.5, 90));   // +100bp real
  m.set('term_premium', series(1200, (i, n) => -0.2 + (1.4 * i) / n));
  setBe(m);                                         // breakeven roughly flat
  m.set('core_cpi', coreCpi(2.4, 2.4));
  m.set('wti', series(300, () => 90));

  const r = longDurationSetup(m, macro({ bust: 2.6, credit: 1.6 }));
  assert.equal(r.regime, 'Fiscal / term-premium stress');
  assert.equal(r.veto.state !== 'OFF', true,
    'long real yields +100bp in three months must at least trigger WATCH');
});

test('a term premium at an extreme but rising fast is capped, with its own contradiction', () => {
  const m = cheapValuation();
  // term premium jumps in the last 60 days -> high percentile AND high z
  m.set('term_premium', ramp(1200, 0.2, 1.6, 60));
  setBe(m);
  m.set('core_cpi', coreCpi(2.4));
  const r = longDurationSetup(m, macro());
  const tp = [...r.supporting, ...r.contradicting].find((s) => s.includes('term premium'));
  assert.ok(tp, 'the term premium component must be present');
  assert.match(tp!, /still rising fast/);
  assert.match(tp!, /not an entry level/);
});

// ══ the veto ══════════════════════════════════════════════════════════

test('one condition is WATCH and makes EXCEPTIONAL unreachable', () => {
  const m = disinflation(cheapValuation());
  m.set('wti', ramp(300, 78, 104, 91));   // +33% -> one condition only
  const r = longDurationSetup(m, recessionMacro());
  assert.equal(r.veto.state, 'WATCH');
  assert.equal(r.veto.triggered.length, 1);
  assert.ok(r.score.score <= T.veto.cap_watch,
    `WATCH caps below exceptional; got ${r.score.score}`);
  assert.notEqual(r.band, 'EXCEPTIONAL');
});

test('the components always sum to the score on screen', () => {
  for (const r of [
    longDurationSetup(stagflation(cheapValuation()), recessionMacro()),
    longDurationSetup(disinflation(cheapValuation()), recessionMacro()),
    longDurationSetup(setBe(cheapValuation()), macro()),
  ]) {
    const sum = r.score.components.filter((c) => !c.unknown).reduce((s, c) => s + c.delta, 0);
    assert.ok(Math.abs(sum - r.score.score) < 0.051,
      `components must sum to the score: ${sum} vs ${r.score.score}`);
  }
});

test('when the cap actually binds it appears as a visible negative component', () => {
  // The gate usually suppresses the score below the cap on its own, so the
  // cap only binds where inflation compatibility is intact but a single
  // veto condition is live — an oil shock inside a disinflationary
  // recession. That is the case worth testing.
  // Breakeven compressing while the real yield grinds slightly higher, so
  // the valuation percentiles stay at their extreme AND inflation
  // compatibility is intact — the only configuration in which the pre-cap
  // total clears 4.4. The gate suppresses every other route to it, which
  // is itself worth knowing.
  const m = cheapValuation();
  m.set('us30y', trendThenMove(1200, 2.0, 5.62, 5.60, 90));
  m.set('us30y_real', trendThenMove(1200, 0.3, 3.28, 3.46, 90));
  setBe(m);                                    // breakeven ~-20bp
  m.set('core_cpi', coreCpi(3.2, 1.6));
  m.set('wti', ramp(300, 78, 104, 91));        // +33%, one veto condition
  const r = longDurationSetup(m, recessionMacro());
  assert.equal(r.veto.state, 'WATCH');
  const capComp = r.score.components.find((c) => c.delta < 0 && /STAGFLATION VETO/.test(c.reason));
  assert.ok(capComp, `the cap must be a component, not a silent rewrite (score ${r.score.score})`);
  assert.match(capComp!.reason, /capped at/);
  const sum = r.score.components.filter((c) => !c.unknown).reduce((s, c) => s + c.delta, 0);
  assert.ok(Math.abs(sum - r.score.score) < 0.051, 'and the arithmetic still adds up');
});

test('no veto condition leaves the veto OFF and uncapped', () => {
  const r = longDurationSetup(disinflation(cheapValuation()), recessionMacro());
  assert.equal(r.veto.state, 'OFF');
  assert.equal(r.veto.cap, null);
});

// ══ setup vs confirmation ═════════════════════════════════════════════

test('an attractive setup can be NOT CONFIRMED — that is the point of two states', () => {
  // cheap valuation, disinflation, recession, but 30Y still making highs
  const m = disinflation(cheapValuation());
  m.set('us30y', ramp(1200, 5.2, 5.9, 90));  // still rising
  m.set('us30y_real', ramp(1200, 3.0, 3.1, 90));
  setBe(m);
  m.set('us2y', ramp(300, 4.6, 5.0, 40));    // front end rising too
  const r = longDurationSetup(m, macro({ bust: 4.0, credit: 3.0, phase: 'BUST UNDERWAY' }));

  assert.equal(r.confirmation.state, 'Not confirmed');
  assert.ok(r.score.score >= 2.5,
    `the setup score should still be meaningful, got ${r.score.score}`);
  assert.equal(r.confirmation.tests.length, 5);
});

test('yields rolling over across the curve reads as confirmed', () => {
  const m = disinflation(cheapValuation());
  m.set('us30y', ramp(1200, 6.0, 5.1, 80));
  m.set('us30y_real', ramp(1200, 3.6, 3.0, 80));
  setBe(m);
  m.set('us2y', ramp(300, 5.1, 4.2, 60));
  const r = longDurationSetup(m, macro({
    bust: 4.0, credit: 3.0, phase: 'BUST UNDERWAY',
    rateLeg: 'RATES COLLAPSING — DEFLATIONARY CONFIRMATION', regime: 'EXPANDING',
  }));
  assert.equal(r.confirmation.state, 'Confirmed');
  assert.ok(r.confirmation.passed >= T.confirmation.confirmed_at);
});

test('a confirmation test with no data is null, never a silent pass', () => {
  const m = cheapValuation();
  m.delete('us2y');
  setBe(m);
  m.set('core_cpi', coreCpi(2.4));
  const r = longDurationSetup(m, macro());
  const t = r.confirmation.tests.find((x) => x.label.includes('2Y'))!;
  assert.equal(t.pass, null);
  assert.equal(t.detail, 'no data');
  assert.ok(!r.confirmation.tests.some((x) => x.pass === null && x.detail === ''),
    'a null test must still say why');
});

// ══ the decomposition ═════════════════════════════════════════════════

const decompWorld = (nomBp: number, realBp: number) => {
  const m = new Map<string, Point[]>();
  m.set('us30y', ramp(300, 5.0, 5.0 + nomBp / 100, 20));
  m.set('us30y_real', ramp(300, 3.0, 3.0 + realBp / 100, 20));
  setBe(m);
  return m;
};

test('a real-yield-led sell-off is labelled as such, and only as such', () => {
  const d = decompose(decompWorld(42, 37), 20);
  assert.equal(d.tag, 'Real-yield / term-premium-led sell-off');
  assert.match(d.interpretation, /Consistent with a non-inflation \/ term-premium driven sell-off/);
});

test('an inflation-led sell-off is distinguished from it', () => {
  const d = decompose(decompWorld(50, 15), 20);
  assert.equal(d.tag, 'Inflation-led sell-off');
  assert.match(d.interpretation, /breakeven/);
});

test('a mixed move is not forced into a driver', () => {
  assert.equal(decompose(decompWorld(50, 25), 20).tag, 'Mixed');
});

test('falling yields are read as a rally, and split by cause', () => {
  assert.equal(decompose(decompWorld(-60, -50), 20).tag, 'Growth-scare rally');
  assert.equal(decompose(decompWorld(-60, -8), 20).tag, 'Disinflation rally');
});

test('a move too small to attribute says so instead of guessing', () => {
  const d = decompose(decompWorld(4, 3), 20);
  assert.equal(d.tag, 'Quiet');
  assert.match(d.interpretation, /too small to attribute/);
});

test('NOTHING in the decomposition claims to observe passive or mechanical flow', () => {
  // Green's mechanism is not visible in yield data. Asserting it would be
  // the module's most tempting overreach.
  const cases = [decompWorld(42, 37), decompWorld(50, 15), decompWorld(-60, -50), decompWorld(4, 3)];
  for (const m of cases) {
    for (const w of [20, 60]) {
      const d = decompose(m, w);
      assert.doesNotMatch(d.interpretation, /passive|mechanical|forced selling|index fund/i,
        `claimed an unobservable mechanism: ${d.interpretation}`);
    }
  }
});

test('a missing leg is never inferred from the other two', () => {
  const m = decompWorld(42, 37);
  m.delete('us30y_real');
  const d = decompose(m, 20);
  assert.equal(d.realBp, null);
  assert.match(d.interpretation, /Not inferred/);
});

test('both windows in the brief are produced', () => {
  const r = longDurationSetup(setBe(cheapValuation()), macro());
  assert.deepEqual(r.decomposition.map((d) => d.windowDays), [20, 60]);
});

// ══ UNKNOWN stays UNKNOWN ═════════════════════════════════════════════

test('missing inputs reduce confidence rather than being scored as benign', () => {
  const m = new Map<string, Point[]>();
  m.set('us30y', series(1200, (i, n) => 2 + (3.6 * i) / n));
  // no real yield, no term premium, no breakeven, no core, no oil
  const r = longDurationSetup(m, macro());

  assert.ok(r.lowDataConfidence, 'coverage this thin must be flagged');
  assert.match(r.line, /LOW DATA CONFIDENCE/);
  assert.equal(r.regime, 'Indeterminate');
  assert.ok(r.score.evidenceAvailable < r.score.evidenceTotal);
  for (const c of r.score.components.filter((x) => x.unknown)) {
    assert.equal(c.delta, 0);
    assert.match(c.reason, /not treated as calm/);
  }
});

test('an unknown component is not counted in a smaller denominator', () => {
  const full = longDurationSetup(disinflation(cheapValuation()), recessionMacro());
  const m = disinflation(cheapValuation());
  m.delete('term_premium');
  const partial = longDurationSetup(m, recessionMacro());
  assert.equal(partial.score.evidenceTotal, full.score.evidenceTotal,
    'the denominator must not shrink when an input goes missing');
  assert.ok(partial.score.score < full.score.score,
    'a missing input lowers the score rather than being renormalised away');
});

test('percentile reporting carries its sample size and start date', () => {
  const p = percentileOfLatest(series(1200, (i, n) => i / n))!;
  assert.equal(p.n, 1200);
  assert.equal(p.last, '2026-09-30');
  assert.ok(p.pct > 99, 'the last point of a rising series is its maximum');
  const short = percentileOfLatest(series(30, (i) => i));
  assert.equal(short, null, 'too little history must yield no percentile at all');
});

test('the 30Y real percentile sentence states how many years it covers', () => {
  const r = longDurationSetup(disinflation(cheapValuation()), macro());
  const s = [...r.supporting, ...r.contradicting].find((x) => x.includes('30Y real yield'))!;
  assert.match(s, /percentile of its \d+-year history/,
    'a percentile without its window is a flattering half-truth');
  assert.match(s, /from \d{4}-\d{2}-\d{2}/, 'and it names the first observation');
});

// ══ vocabulary and bands ══════════════════════════════════════════════

test('no position language anywhere in the output', () => {
  const worlds = [
    longDurationSetup(disinflation(cheapValuation()), recessionMacro()),
    longDurationSetup(stagflation(cheapValuation()), recessionMacro()),
    longDurationSetup(setBe(cheapValuation()), macro()),
  ];
  // "sell-off" is a description of a market move, not an instruction, so
  // it is excluded explicitly rather than by loosening the whole pattern.
  const banned = /\b(buy|sell(?![-\s]off)|short|long position|go long|overweight|underweight|accumulate|target price)\b/i;
  for (const r of worlds) {
    const text = [
      r.line, r.regimeWhy, ...r.supporting, ...r.contradicting,
      ...r.decomposition.map((d) => d.interpretation),
      ...r.veto.triggered, ...r.confirmation.tests.map((t) => `${t.label} ${t.detail}`),
    ].join(' || ');
    const hit = text.match(banned);
    assert.equal(hit, null, `position language found: ${hit?.[0]} in "${text.slice(Math.max(0, (hit?.index ?? 0) - 60), (hit?.index ?? 0) + 60)}"`);
  }
});

test('the bands are the ones in the brief', () => {
  assert.equal(bandOf(0.5), 'UNFAVOURABLE');
  assert.equal(bandOf(1.5), 'WEAK');
  assert.equal(bandOf(2.5), 'WATCH');
  assert.equal(bandOf(3.5), 'SETUP BUILDING');
  assert.equal(bandOf(4.2), 'ATTRACTIVE');
  assert.equal(bandOf(4.7), 'EXCEPTIONAL');
});

test('the pillar caps are 40 / 35 / 25 of five', () => {
  assert.equal(T.weights.valuation, 2.0);
  assert.equal(T.weights.macro, 1.75);
  assert.equal(T.weights.inflation, 1.25);
  assert.equal(T.weights.valuation + T.weights.macro + T.weights.inflation, 5);
});

test('every component carries a sentence with a number in it', () => {
  const r = longDurationSetup(disinflation(cheapValuation()), recessionMacro());
  for (const c of r.score.components) {
    assert.ok(c.reason.length > 20, `too terse to explain anything: "${c.reason}"`);
    assert.match(c.reason, /\d/, `no number in "${c.reason}"`);
  }
});
