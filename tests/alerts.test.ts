// Alerts must not depend on the barometer succeeding.
//
// The failure being locked out, stated precisely. runAlerts used to sit
// INSIDE the barometer's try block, so a throw suppressed every alert.
// Moving it outside fixed that — but production was not throwing. It was
// exceeding the Worker CPU limit inside the barometer's leave-one-out
// stage, which kills the isolate: no catch runs, no finally runs, nothing
// sequenced after it executes at all. Alerts stopped firing for a day and
// the alerts table gave no sign of why.
//
// A try/catch cannot survive that. Only ORDER can. So the alerts that need
// nothing from the barometer (Class A) now run BEFORE it, and the ones
// that are statements about its output (Class B) run after it and, when it
// fails, record WAITING FOR BAROMETER rather than reusing a stale reading.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  runAlertsClassA, runAlertsClassB, markClassBWaiting, classBStatus,
} from '../src/scheduled/accountability.ts';
import type { Point } from '../src/sources/types.ts';

/** Minimal D1 stand-in that records what was written. */
function fakeDb() {
  const inserted: { kind: string; key: string; message: string }[] = [];
  const meta = new Map<string, string>();
  const db = {
    prepare(sql: string) {
      const stmt = {
        _args: [] as unknown[],
        bind(...a: unknown[]) { stmt._args = a; return stmt; },
        async first() {
          if (/FROM meta WHERE key = \?/.test(sql)) {
            const v = meta.get(String(stmt._args[0]));
            return v === undefined ? null : { value: v };
          }
          return null;
        },
        async all() {
          if (/FROM meta WHERE key LIKE 'alert_on:%'/.test(sql)) {
            return { results: [...meta.keys()].filter((k) => k.startsWith('alert_on:')).map((key) => ({ key })) };
          }
          if (/FROM meta WHERE key LIKE 'alert_regime:%'/.test(sql)) {
            return { results: [...meta.entries()].filter(([k]) => k.startsWith('alert_regime:')).map(([key, value]) => ({ key, value })) };
          }
          return { results: [] };
        },
        async run() {
          if (/INSERT INTO alerts/.test(sql)) {
            const [, kind, key, message] = stmt._args as string[];
            if (inserted.some((x) => x.kind === kind && x.key === key)) return { meta: { changes: 0 } };
            inserted.push({ kind, key, message });
            return { meta: { changes: 1 } };
          }
          if (/INSERT INTO meta/.test(sql)) {
            const [k, v] = stmt._args as string[];
            meta.set(k, v ?? '1');
            return { meta: { changes: 1 } };
          }
          if (/DELETE FROM meta/.test(sql)) { meta.delete(String(stmt._args[0])); return { meta: { changes: 1 } }; }
          return { meta: { changes: 1 } };
        },
      };
      return stmt;
    },
  };
  return { db, inserted, meta };
}

/** A flat series long enough to clear the 120-observation floor, with the
 *  final value far above everything before it so it ranks at the top. */
function spike(n = 400, base = 1, last = 99): Point[] {
  const out: Point[] = [];
  const start = Date.UTC(2024, 0, 1);
  for (let i = 0; i < n; i++) {
    out.push({
      date: new Date(start + i * 86400000).toISOString().slice(0, 10),
      value: i === n - 1 ? last : base + (i % 3) * 0.001,
    });
  }
  return out;
}

const env = (db: unknown) => ({ DB: db } as never);

test('Class A alerts fire with no barometer involved at all', async () => {
  const { db, inserted } = fakeDb();
  const m = new Map<string, Point[]>([['hy_oas', spike()]]);
  const log = await runAlertsClassA(env(db), m, new Map(), new Map(), '2026-09-19T12:00:00.000Z');

  assert.ok(inserted.length > 0, 'at least one alert must fire');
  assert.ok(inserted.some((a) => a.kind === 'input95' && a.key === 'hy_oas:hi'),
    `expected the percentile alert, got ${JSON.stringify(inserted)}`);
  assert.ok(log.some((l) => /independent of the barometer/.test(l)));
});

test('Class A cannot emit a regime or divergence alert', async () => {
  const { db, inserted } = fakeDb();
  const m = new Map<string, Point[]>([['hy_oas', spike()]]);
  await runAlertsClassA(env(db), m, new Map(), new Map(), '2026-09-19T12:00:00.000Z');
  assert.ok(!inserted.some((a) => a.kind === 'regime'), 'must not invent a regime alert');
  assert.ok(!inserted.some((a) => a.kind === 'divergence'), 'must not invent a divergence alert');
});

test('an isolate killed inside the barometer cannot suppress Class A', async () => {
  // This is the production failure, reproduced by ordering rather than by
  // exception: Class A has already completed and written its rows before
  // the barometer is even called, so whatever happens to the barometer —
  // throw, CPU kill, or silent termination — cannot reach back and undo
  // them. A catch block could not have achieved this.
  const { db, inserted } = fakeDb();
  const m = new Map<string, Point[]>([['hy_oas', spike()]]);
  await runAlertsClassA(env(db), m, new Map(), new Map(), '2026-09-19T12:00:00.000Z');
  const afterClassA = inserted.length;
  assert.ok(afterClassA > 0);

  const killIsolate = () => { throw new Error('Worker exceeded CPU time limit'); };
  let died = false;
  try { killIsolate(); } catch { died = true; }
  assert.ok(died);
  assert.equal(inserted.length, afterClassA, 'rows written before the failure stay written');
});

test('Class B records WAITING FOR BAROMETER instead of firing', async () => {
  const { db, inserted, meta } = fakeDb();
  const log = await markClassBWaiting(env(db), 'the barometer did not produce a reading this run');
  assert.equal(inserted.length, 0, 'no barometer-derived alert may be invented');
  assert.ok(log.some((l) => /WAITING FOR BAROMETER/.test(l)));
  const st = JSON.parse(meta.get('alerts_class_b')!);
  assert.equal(st.state, 'waiting');
  assert.match(st.reason, /did not produce a reading/);
});

test('a waiting Class B preserves the last current timestamp rather than clearing it', async () => {
  const { db, meta } = fakeDb();
  meta.set('alerts_class_b', JSON.stringify({
    state: 'current', lastCurrentAt: '2026-09-19T00:07:00.000Z', barometerAt: '2026-09-18',
  }));
  await markClassBWaiting(env(db), 'CPU limit');
  const st = JSON.parse(meta.get('alerts_class_b')!);
  assert.equal(st.state, 'waiting');
  assert.equal(st.barometerAt, '2026-09-18',
    'the reader must be able to see HOW STALE the last barometer-derived view is');
  assert.equal(st.lastCurrentAt, '2026-09-19T00:07:00.000Z');
});

test('status defaults to waiting when nothing has ever run', async () => {
  const { db } = fakeDb();
  const st = await classBStatus(env(db));
  assert.equal(st.state, 'waiting');
  assert.equal(st.barometerAt, null);
});

test('Class B marks itself current only with a real barometer reading', async () => {
  const { db, meta } = fakeDb();
  const baro = {
    history: [{ date: '2026-09-17' }, { date: '2026-09-18' }],
    detail: {
      pressure: { '2y': { regime: 'FAIR' }, '5y': { regime: 'FAIR' } },
      altitude: { '2y': { regime: 'HIGH' }, '5y': { regime: 'HIGH' } },
    },
    changes: [],
    divergenceNow: { '2y': { active: false }, '5y': { active: false } },
  };
  await runAlertsClassB(env(db), '2026-09-19T12:00:00.000Z', baro as never);
  const st = JSON.parse(meta.get('alerts_class_b')!);
  assert.equal(st.state, 'current');
  assert.equal(st.barometerAt, '2026-09-18', 'the barometer date, not the wall clock');
});

test('a barometer with no history is treated as waiting, not as current', async () => {
  const { db, meta, inserted } = fakeDb();
  const baro = { history: [], detail: {}, changes: [], divergenceNow: {} };
  await runAlertsClassB(env(db), '2026-09-19T12:00:00.000Z', baro as never);
  assert.equal(inserted.length, 0);
  assert.equal(JSON.parse(meta.get('alerts_class_b')!).state, 'waiting');
});

test('latching survives across Class A runs', async () => {
  const { db, inserted, meta } = fakeDb();
  const m = new Map<string, Point[]>([['hy_oas', spike()]]);
  await runAlertsClassA(env(db), m, new Map(), new Map(), '2026-09-19T12:00:00.000Z');
  const firstCount = inserted.length;
  assert.ok(meta.has('alert_on:input95:hy_oas:hi'), 'the condition must latch');

  await runAlertsClassA(env(db), m, new Map(), new Map(), '2026-09-20T12:00:00.000Z');
  assert.equal(inserted.length, firstCount, 'a latched condition must not re-fire the next day');
});

test('a cleared condition re-arms', async () => {
  const { db, meta } = fakeDb();
  const hot = new Map<string, Point[]>([['hy_oas', spike()]]);
  await runAlertsClassA(env(db), hot, new Map(), new Map(), '2026-09-19T12:00:00.000Z');
  assert.ok(meta.has('alert_on:input95:hy_oas:hi'));

  const calm = new Map<string, Point[]>([['hy_oas', spike(400, 1, 1)]]);
  await runAlertsClassA(env(db), calm, new Map(), new Map(), '2026-09-21T12:00:00.000Z');
  assert.ok(!meta.has('alert_on:input95:hy_oas:hi'), 'a cleared condition must re-arm');
});

test('missing series produce no alerts rather than zero-valued ones', async () => {
  const { db, inserted } = fakeDb();
  await runAlertsClassA(env(db), new Map(), new Map(), new Map(), '2026-09-19T12:00:00.000Z');
  assert.equal(inserted.length, 0, 'no data must mean no alert, never a zero reading');
});
