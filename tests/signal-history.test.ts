// Signal history and transition dates.
//
// The failure being locked out is a fabricated transition date. When the
// oldest row we hold is already in the current state, the real change
// happened before we were looking and we do not know when — presenting
// the first stored date as the change date would be an invented fact, and
// a very plausible looking one. It must say SINCE TRACKING BEGAN instead.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSignalHistory, sinceLabel, type CockpitRow, type AiRow,
} from '../src/scoring/signal-history.ts';

const day = (i: number) => new Date(Date.UTC(2026, 5, 1 + i)).toISOString().slice(0, 10);

const c = (i: number, o: Partial<CockpitRow> = {}): CockpitRow => ({
  date: day(i), phase: 'NORMAL / PRE-MELT-UP', meltup: 2, bust: 2, bust_onset: 0,
  credit: 0, credit_stage: 'CALM', liquidity_regime: 'NEUTRAL', liquidity_level: 'ELEVATED', ...o,
});
const a = (i: number, o: Partial<AiRow> = {}): AiRow => ({
  date: day(i), score: 3, status: 'ELEVATED',
  transmission: JSON.stringify({ status: 'EARLY SIGNS' }), hunter_link: 'EARLY WATCH', ...o,
});

const find = (rows: CockpitRow[], ai: AiRow[], id: string) =>
  buildSignalHistory(rows, ai).find((s) => s.id === id)!;

// ── the honest fallback ───────────────────────────────────────────────

test('an unchanged history reports SINCE TRACKING BEGAN, not the first stored date', () => {
  const rows = [0, 1, 2, 3].map((i) => c(i));
  const s = find(rows, [], 'meltup');
  assert.equal(s.current, 'WATCH');
  assert.equal(s.sinceTrackingBegan, true);
  assert.equal(s.previous, null, 'there is no observed previous state to report');
  assert.equal(sinceLabel(s), 'Since tracking began');
});

test('two days of history still refuses to invent a transition', () => {
  // the real production situation on the day this was built
  const s = find([c(0), c(1)], [a(1)], 'ai_capital');
  assert.equal(s.current, 'ELEVATED');
  assert.equal(s.sinceTrackingBegan, true);
  assert.match(sinceLabel(s), /tracking began/i);
});

test('no history at all is reported as such', () => {
  const s = find([], [], 'meltup');
  assert.equal(s.current, null);
  assert.equal(s.since, null);
  assert.equal(sinceLabel(s), 'No history yet');
});

// ── genuine transitions ───────────────────────────────────────────────

test('an observed change gives a real date and the previous state', () => {
  const rows = [c(0, { meltup: 1 }), c(1, { meltup: 1 }), c(2, { meltup: 3 }), c(3, { meltup: 3 })];
  const s = find(rows, [], 'meltup');
  assert.equal(s.current, 'ELEVATED');
  assert.equal(s.previous, 'NORMAL');
  assert.equal(s.since, day(2));
  assert.equal(s.sinceTrackingBegan, false);
  assert.equal(s.heldDays, 1);
  assert.match(sinceLabel(s), /^Since 3 Jun 2026$/);
});

test('transitions are on the band, not on the number', () => {
  // 2.9 -> 3.1 crosses no band boundary: both are ELEVATED
  const rows = [c(0, { meltup: 2.9 }), c(1, { meltup: 3.1 }), c(2, { meltup: 3.0 })];
  const s = find(rows, [], 'meltup');
  assert.equal(s.current, 'ELEVATED');
  assert.equal(s.sinceTrackingBegan, true,
    'drifting inside a band must not reset the since date');
  assert.equal(s.currentValue, 3.0, 'the underlying number is still carried');
});

test('only the most recent run of the current state counts', () => {
  // WATCH -> ELEVATED -> WATCH: since must be the LAST change, not the first
  const rows = [c(0, { meltup: 2 }), c(1, { meltup: 3 }), c(2, { meltup: 2 }), c(3, { meltup: 2 })];
  const s = find(rows, [], 'meltup');
  assert.equal(s.current, 'WATCH');
  assert.equal(s.since, day(2));
  assert.equal(s.previous, 'ELEVATED');
});

test('a gap in the history does not end a run', () => {
  // a skipped cron is a fact about us, not a change in the world
  const rows = [c(0, { meltup: 3 }), c(1, { meltup: 3 }), c(5, { meltup: 3 })];
  const s = find(rows, [], 'meltup');
  assert.equal(s.sinceTrackingBegan, true);
  assert.equal(s.heldDays, 5, 'held days still span the calendar gap');
});

test('a day with no reading is skipped rather than treated as a change', () => {
  const rows = [c(0, { meltup: 3 }), c(1, { meltup: null }), c(2, { meltup: 3 })];
  const s = find(rows, [], 'meltup');
  assert.equal(s.current, 'ELEVATED');
  assert.equal(s.sinceTrackingBegan, true, 'a null must not read as a different state');
});

// ── the signals themselves ────────────────────────────────────────────

test('all nine executive signals are produced', () => {
  const ids = buildSignalHistory([c(0)], [a(0)]).map((s) => s.id);
  assert.deepEqual(ids, [
    'phase', 'meltup', 'bust', 'bust_onset', 'credit',
    'liquidity', 'ai_capital', 'ai_transmission', 'hunter_ai',
  ]);
});

test('the transmission state is read out of its stored JSON', () => {
  const s = find([c(0)], [a(0)], 'ai_transmission');
  assert.equal(s.current, 'EARLY SIGNS');
});

test('unparseable stored JSON yields null, not a crash or a guess', () => {
  const s = find([c(0)], [a(0, { transmission: 'not json' })], 'ai_transmission');
  assert.equal(s.current, null);
});

test('the Credit Canary reports its stage rather than a generic band', () => {
  const s = find([c(0, { credit: 0, credit_stage: 'CALM' })], [], 'credit');
  assert.equal(s.current, 'CALM');
  assert.equal(s.currentValue, 0);
});

test('cockpit and AI rows on different dates share one axis', () => {
  // AI capital began being stored a day after the cockpit did
  const s = buildSignalHistory([c(0), c(1)], [a(1)]);
  assert.equal(s.find((x) => x.id === 'meltup')!.points.length, 2);
  assert.equal(s.find((x) => x.id === 'ai_capital')!.points.length, 1,
    'the AI series must not be back-filled onto dates it has no row for');
});

test('a transmission progression is visible as a sequence', () => {
  // the progression the system exists to detect, if it ever happens
  const ai = [
    a(0, { transmission: JSON.stringify({ status: 'NOT CONFIRMED' }) }),
    a(1, { transmission: JSON.stringify({ status: 'EARLY SIGNS' }) }),
    a(2, { transmission: JSON.stringify({ status: 'FORMING' }) }),
  ];
  const s = find([], ai, 'ai_transmission');
  assert.deepEqual(s.points.map((p) => p.state), ['NOT CONFIRMED', 'EARLY SIGNS', 'FORMING']);
  assert.equal(s.current, 'FORMING');
  assert.equal(s.previous, 'EARLY SIGNS');
  assert.equal(s.sinceTrackingBegan, false);
});
