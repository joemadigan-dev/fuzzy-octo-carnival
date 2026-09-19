// The Market Setup sentence is deterministic and grammatical by rule.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { marketSetup, type SetupInput } from '../src/scoring/setup.ts';

const base = (o: Partial<SetupInput> = {}): SetupInput => ({
  phase: { phase: 'MELT-UP', candidate: 'MELT-UP', heldDays: 5, persistDays: 3,
           settled: true, confidence: 'HIGH', explanation: '', evidence: [] } as any,
  meltup: { score: 3, max: 5, level: 'ELEVATED', components: [], coverage: 1,
            evidenceAvailable: 5, evidenceTotal: 5 },
  bust: { score: 2, max: 5, level: 'WATCH', components: [], coverage: 1,
          evidenceAvailable: 5, evidenceTotal: 5, vulnerability: 2, onset: 0, posture: '' },
  credit: { score: 0, max: 5, level: 'NORMAL', components: [], coverage: 1,
            evidenceAvailable: 5, evidenceTotal: 5, stage: 'CALM', ladder: [], systemic: false },
  liquidity: { level: 'ELEVATED', regime: 'NEUTRAL', us10y: 4.94, us2y: 4.67, curve: 27,
               walcl13wPct: 0.2, walcl13wBn: 10, walcl4wBn: 2, usdTrend: 'DOWN',
               creditWord: 'CALM', rateLeg: 'RATES RISING — PRESSURE BUILDING',
               qe: { active: false, magnitude: 'NONE', detail: '' }, notes: [] },
  ret6m: 17.6, ret3mPace: 4.0, drawdown: -1.9,
  valuationPct: 256, erp: 4.14, commoditiesLeading: 0,
  ...o,
} as SetupInput);

test('is deterministic — same input, same sentence', () => {
  assert.equal(marketSetup(base()).sentence, marketSetup(base()).sentence);
});

test('uses "but" at most once, at the credit junction', () => {
  const s = marketSetup(base()).sentence;
  assert.equal((s.match(/, but /g) ?? []).length, 1, s);
  assert.match(s, /but broad credit remains calm/);
});

test('every clause names the reading behind it', () => {
  for (const c of marketSetup(base()).clauses) {
    assert.ok(c.text.length > 0);
    assert.ok(c.because.length > 0, `clause "${c.text}" must cite its evidence`);
  }
});

test('deceleration is stated rather than hidden behind a strong number', () => {
  const s = marketSetup(base({ ret6m: 17.6, ret3mPace: 4.0 })).sentence;
  assert.match(s, /decelerating/);
  const t = marketSetup(base({ ret6m: 17.6, ret3mPace: 30 })).sentence;
  assert.match(t, /still accelerating/);
});

test('drops the contrast when credit agrees with the rest', () => {
  const s = marketSetup(base({
    credit: { ...base().credit, score: 4, stage: 'FUNDING SHOCK', systemic: true } as any,
  })).sentence;
  assert.equal((s.match(/, but /g) ?? []).length, 0, s);
  assert.match(s, /investment grade/);
});

test('omits clauses whose evidence is missing rather than inventing them', () => {
  const s = marketSetup(base({ ret6m: null, ret3mPace: null, valuationPct: null, erp: null }));
  assert.ok(!s.clauses.some((c) => c.role === 'valuation'));
  assert.match(s.sentence, /unreadable/);
});

test('names at most one principal pressure', () => {
  const s = marketSetup(base({
    liquidity: { ...base().liquidity, rateLeg: 'RATES RISING — PRESSURE BUILDING',
                 regime: 'CONTRACTING', qe: { active: true, magnitude: 'MAJOR QE', detail: 'x' } } as any,
  }));
  assert.equal(s.clauses.filter((c) => c.role === 'pressure').length, 1);
});

test('always ends in a single full stop', () => {
  const s = marketSetup(base()).sentence;
  assert.match(s, /[^.]\.$/);
  assert.equal((s.match(/\.\./g) ?? []).length, 0);
});
