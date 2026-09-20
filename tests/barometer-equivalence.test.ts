// The optimised barometer must produce EXACTLY what the pre-optimisation
// implementation produced.
//
// The optimisation existed because `leave_one_out` was exceeding the
// Worker CPU limit and killing the whole cron run — alerts, SEC ingestion
// and everything else downstream with it. A faster barometer that quietly
// moves a regime boundary or a concentration diagnostic would be a much
// worse outcome than a slow one, so the old implementation is kept in
// tests/fixtures/barometer.legacy.ts as a frozen reference and both are
// run over the same 26 years of real stored history.
//
// The three changes under test are all algebraic identities, not
// approximations, so the bar here is bit-for-bit equality rather than a
// tolerance:
//
//   1. the forward-fill compares precomputed calendar day numbers instead
//      of rebuilding a date string per (input x window x date);
//   2. z-scores live in dense axis-aligned Float64Arrays instead of
//      Map<string, number>, so the same values are read by index;
//   3. leave-one-out rebuilds only the sub-index the excluded input
//      belongs to and reuses the rest from the base run, because removing
//      an input cannot affect a sub-index it is not a member of.
//
// If a future change makes exact equality genuinely impractical, replace
// the equality assertion with a justified tolerance — do not delete the
// comparison.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { computeBarometer } from '../src/compute/barometer.ts';
import { computeBarometer as computeBarometerLegacy } from './fixtures/barometer.legacy.ts';
import type { Point } from '../src/sources/types.ts';

const here = dirname(fileURLToPath(import.meta.url));

/** 26 barometer inputs, 71,259 observations, 2000-01-01 to 2026-09-18,
 *  read once from production D1 and frozen here. */
function realInputs(): Map<string, Point[]> {
  const raw = JSON.parse(gunzipSync(readFileSync(join(here, 'fixtures/baro-inputs.json.gz'))).toString('utf8')) as
    Record<string, [string, number][]>;
  const m = new Map<string, Point[]>();
  for (const [id, pts] of Object.entries(raw)) m.set(id, pts.map(([date, value]) => ({ date, value })));
  return m;
}

/** Everything except `stages`, which carries progress labels rather than
 *  results and is deliberately allowed to differ. */
const results = (r: ReturnType<typeof computeBarometer>) => {
  const { stages, ...rest } = r;
  return rest;
};

const inputs = realInputs();
const legacy = computeBarometerLegacy(inputs);
const optimised = computeBarometer(inputs);

test('the fixture really is the full production history', () => {
  assert.equal(inputs.size, 26);
  const total = [...inputs.values()].reduce((s, p) => s + p.length, 0);
  assert.equal(total, 71259);
  assert.equal(legacy.history.length, 6818, 'the axis must span every date the inputs cover');
});

test('every regime in 26 years of history is unchanged', () => {
  assert.equal(legacy.history.length, optimised.history.length);
  assert.deepEqual(optimised.history, legacy.history);
});

test('the leave-one-out concentration table is unchanged', () => {
  // This is the diagnostic the optimisation actually rewrote, so it is the
  // one most likely to have moved.
  assert.equal(optimised.diagnostics.loo.length, 26);
  assert.deepEqual(optimised.diagnostics.loo, legacy.diagnostics.loo);
});

test('the correlation matrix is unchanged', () => {
  assert.deepEqual(optimised.diagnostics.corr, legacy.diagnostics.corr);
});

test('regime-change history and its drivers are unchanged', () => {
  assert.deepEqual(optimised.changes, legacy.changes);
});

test('the current gauge detail is unchanged', () => {
  assert.deepEqual(optimised.detail, legacy.detail);
});

test('historical analogues are unchanged', () => {
  assert.deepEqual(optimised.analogues, legacy.analogues);
});

test('divergence state is unchanged', () => {
  assert.deepEqual(optimised.divergenceNow, legacy.divergenceNow);
  assert.deepEqual(optimised.diagnostics.divergenceEpisodes, legacy.diagnostics.divergenceEpisodes);
});

test('the complete result is bit-for-bit identical, not merely close', () => {
  assert.equal(
    JSON.stringify(results(optimised)),
    JSON.stringify(results(legacy)),
    'the optimisation is a set of algebraic identities; any difference at all is a bug',
  );
});

test('it still reaches the final stage rather than dying part-way', () => {
  assert.deepEqual(optimised.stages.map((s) => s.name), [
    'input_zscores', 'ffill_axis', 'layer_series', 'history_divergence',
    'corr_matrix', 'leave_one_out', 'analogues',
  ]);
});

test('it stays far enough under the CPU ceiling to be safe', () => {
  // Not a benchmark — a guard against a regression that would put the
  // stage back where it was. The pre-optimisation implementation took
  // ~1060ms on this fixture and was being killed in production; the
  // optimised one takes ~110ms. The threshold is deliberately loose
  // (5x the observed figure) so that a slow or contended CI machine does
  // not fail the build, while a return to the old order of magnitude
  // still does.
  const t0 = process.hrtime.bigint();
  computeBarometer(inputs);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(ms < 550, `barometer took ${ms.toFixed(0)}ms on the full history; the optimised path should be ~110ms`);
});
