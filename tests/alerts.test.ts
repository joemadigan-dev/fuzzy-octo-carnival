// Alerts must not depend on the barometer succeeding.
//
// The failure being locked out: runAlerts used to sit inside the
// barometer's try block, so a barometer throw — or an isolate kill, which
// has happened three times in production — silently suppressed every
// percentile, threshold, state-band and Hunter-target alert, none of which
// needs the barometer at all. Alerts were delayed until the next
// successful barometer run.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAlerts } from '../src/scheduled/accountability.ts';
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

test('data-only alerts fire when the barometer is null', async () => {
  const { db, inserted } = fakeDb();
  const m = new Map<string, Point[]>([['hy_oas', spike()]]);
  const log = await runAlerts(env(db), m, new Map(), new Map(), '2026-09-19T12:00:00.000Z', null);

  assert.ok(inserted.length > 0, 'at least one alert must fire without a barometer');
  assert.ok(inserted.some((a) => a.kind === 'input95' && a.key === 'hy_oas:hi'),
    `expected the percentile alert, got ${JSON.stringify(inserted)}`);
  assert.ok(log.some((l) => /no barometer this run/.test(l)), 'the run must say the barometer was absent');
});

test('regime and divergence alerts are skipped, not faked, without a barometer', async () => {
  const { db, inserted } = fakeDb();
  const m = new Map<string, Point[]>([['hy_oas', spike()]]);
  await runAlerts(env(db), m, new Map(), new Map(), '2026-09-19T12:00:00.000Z', null);
  assert.ok(!inserted.some((a) => a.kind === 'regime'), 'must not invent a regime alert');
  assert.ok(!inserted.some((a) => a.kind === 'divergence'), 'must not invent a divergence alert');
});

test('a barometer that THROWS still leaves alerts running', async () => {
  // Simulates the cron: computeBarometer throws, baroResult stays null,
  // runAlerts is called anyway because it lives outside that try block.
  const { db, inserted } = fakeDb();
  let baroResult: unknown = null;
  try {
    throw new Error('deliberate computeBarometer failure');
  } catch {
    baroResult = null;
  }
  const m = new Map<string, Point[]>([['hy_oas', spike()]]);
  await runAlerts(env(db), m, new Map(), new Map(), '2026-09-19T12:00:00.000Z', baroResult as never);
  assert.ok(inserted.some((a) => a.kind === 'input95'),
    'a barometer failure must not suppress data-only alerts');
});

test('latching survives the barometer being absent', async () => {
  const { db, inserted, meta } = fakeDb();
  const m = new Map<string, Point[]>([['hy_oas', spike()]]);
  await runAlerts(env(db), m, new Map(), new Map(), '2026-09-19T12:00:00.000Z', null);
  const firstCount = inserted.length;
  assert.ok(meta.has('alert_on:input95:hy_oas:hi'), 'the condition must latch');

  // second run, same condition, a different day — must stay silent
  await runAlerts(env(db), m, new Map(), new Map(), '2026-09-20T12:00:00.000Z', null);
  assert.equal(inserted.length, firstCount, 'a latched condition must not re-fire the next day');
});

test('a cleared condition re-arms even with no barometer', async () => {
  const { db, meta } = fakeDb();
  const hot = new Map<string, Point[]>([['hy_oas', spike()]]);
  await runAlerts(env(db), hot, new Map(), new Map(), '2026-09-19T12:00:00.000Z', null);
  assert.ok(meta.has('alert_on:input95:hy_oas:hi'));

  // condition no longer true → latch must be released
  const calm = new Map<string, Point[]>([['hy_oas', spike(400, 1, 1)]]);
  await runAlerts(env(db), calm, new Map(), new Map(), '2026-09-21T12:00:00.000Z', null);
  assert.ok(!meta.has('alert_on:input95:hy_oas:hi'), 'a cleared condition must re-arm');
});

test('missing series produce no alerts rather than zero-valued ones', async () => {
  const { db, inserted } = fakeDb();
  await runAlerts(env(db), new Map(), new Map(), new Map(), '2026-09-19T12:00:00.000Z', null);
  assert.equal(inserted.length, 0, 'no data must mean no alert, never a zero reading');
});
