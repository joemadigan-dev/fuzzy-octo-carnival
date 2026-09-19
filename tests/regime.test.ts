// Regime hysteresis — the oscillation this exists to prevent.
//
// Reproduces the ALTITUDE (5y) behaviour that motivated the deadband: a
// score wandering either side of the 50th percentile produced genuine
// multi-session runs on both sides, satisfied the 3-session persistence
// rule repeatedly, and flipped HIGH ↔ CLIMBING eight times in a fortnight.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { candidateZone, regimePath, zoneIndex } from '../src/compute/barometer.ts';
import { ZONE_PCTS, ZONE_DEADBAND_PCT, HYSTERESIS_DAYS, ALTITUDE_REGIMES } from '../src/registry/signal.ts';

/** Count adopted regime changes in a path. */
const changes = (path: (string | null)[]) => {
  let n = 0;
  for (let i = 1; i < path.length; i++) if (path[i] && path[i - 1] && path[i] !== path[i - 1]) n++;
  return n;
};
const hold = (pct: number, days: number) => new Array(days).fill(pct);

test('zone boundaries map percentiles to the documented regimes', () => {
  assert.equal(zoneIndex(0), 0);
  assert.equal(zoneIndex(19.9), 0);
  assert.equal(zoneIndex(20), 1);
  assert.equal(zoneIndex(49.9), 1);
  assert.equal(zoneIndex(50), 2);
  assert.equal(zoneIndex(74.9), 2);
  assert.equal(zoneIndex(75), 3);
  assert.equal(zoneIndex(90), 4);
  assert.equal(zoneIndex(100), 4);
});

test('escalation uses the plain threshold, with no deadband', () => {
  // sitting in CLIMBING (1), a reading of exactly 50 justifies HIGH (2)
  assert.equal(candidateZone(1, 50), 2);
  assert.equal(candidateZone(2, 75), 3);
  assert.equal(candidateZone(0, 90), 4);
});

test('de-escalation requires the reading to clear the deadband', () => {
  const B = ZONE_PCTS[1];               // 50, the CLIMBING/HIGH boundary
  // in HIGH, a reading just under 50 is NOT enough to justify CLIMBING
  assert.equal(candidateZone(2, B - 0.1), 2, 'infinitesimally below must hold');
  assert.equal(candidateZone(2, B - ZONE_DEADBAND_PCT + 0.1), 2, 'inside the deadband must hold');
  // but clearing the deadband is
  assert.equal(candidateZone(2, B - ZONE_DEADBAND_PCT - 0.1), 1, 'past the deadband may step down');
});

test('the deadband can never make a de-escalation skip a zone', () => {
  // for every zone, the reading that just clears its deadband still lands
  // in the zone immediately below — never two below
  for (let state = 1; state <= ZONE_PCTS.length; state++) {
    const justCleared = ZONE_PCTS[state - 1] - ZONE_DEADBAND_PCT - 0.001;
    assert.equal(candidateZone(state, justCleared), state - 1,
      `state ${state} must step down exactly one zone`);
  }
});

test('the 0.02 / 0.05 / 0.19 boundary oscillation no longer flips the regime', () => {
  // Percentiles wandering either side of 50 in runs long enough to satisfy
  // persistence — the exact shape of the production incident.
  const pct = [
    ...hold(52, 10),   // settle in HIGH
    ...hold(49, 4),    // dips just below the boundary, 4 sessions
    ...hold(51, 4),    // back above
    ...hold(48, 5),    // below again, longer
    ...hold(52, 4),
    ...hold(49.5, 6),
    ...hold(51, 5),
  ];
  const path = regimePath('altitude', pct);
  assert.equal(changes(path), 0, 'no adopted change while the score stays inside the deadband');
  assert.equal(path[path.length - 1], 'HIGH');
});

test('a genuine move beyond the deadband still de-escalates, after persistence', () => {
  const pct = [
    ...hold(52, 10),                      // HIGH
    ...hold(40, HYSTERESIS_DAYS),         // clearly past 50 - 5, held long enough
  ];
  const path = regimePath('altitude', pct);
  assert.equal(path[path.length - 1], 'CLIMBING');
  assert.equal(changes(path), 1);
});

test('a move beyond the deadband that does NOT persist is rejected', () => {
  const pct = [...hold(52, 10), ...hold(40, HYSTERESIS_DAYS - 1), ...hold(52, 5)];
  const path = regimePath('altitude', pct);
  assert.equal(changes(path), 0, 'persistence still required after the deadband is cleared');
  assert.equal(path[path.length - 1], 'HIGH');
});

test('escalation is not slowed by the deadband, only by persistence', () => {
  const pct = [...hold(52, 6), ...hold(76, HYSTERESIS_DAYS)];
  const path = regimePath('altitude', pct);
  assert.equal(path[path.length - 1], 'EXTENDED');
  assert.equal(changes(path), 1);
});

test('nulls hold the adopted regime rather than clearing it', () => {
  const pct = [...hold(52, 6), null, null, ...hold(52, 2)];
  const path = regimePath('altitude', pct as (number | null)[]);
  assert.equal(path[6], 'HIGH');
  assert.equal(path[7], 'HIGH');
  assert.equal(changes(path), 0);
});

test('regime names come from the layer, not a shared list', () => {
  const p = regimePath('pressure', hold(95, 5));
  assert.equal(p[0], 'SET FAIR');
  const a = regimePath('altitude', hold(95, 5));
  assert.equal(a[0], ALTITUDE_REGIMES[4]);
});
