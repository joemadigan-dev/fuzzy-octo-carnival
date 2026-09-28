// FRED endpoint failover.
//
// The failure this locks out cost five days of frozen credit data. The
// previous guard refused to try the keyless endpoint after an API 5xx, on
// the stated grounds that "both are the same origin and would fail
// identically". They are not the same origin, and from 2026-09-25
// api.stlouisfed.org returned 520 to the Worker while
// fred.stlouisfed.org served fresh observations throughout. The dashboard
// showed CCC at 1093bp while FRED had 1128bp.
//
// The original concern was still real — a blind second attempt for each of
// ~46 series exhausts the Worker subrequest cap — so the fix is not "retry
// everything". It is: the FIRST 5xx marks the API host down for the rest
// of the run, and every later series goes straight to the CSV host. One
// extra subrequest for the whole run, not one per series.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fred, resetFredHostState } from '../src/sources/fred.ts';

const CSV_BODY = 'observation_date,BAMLH0A3HYC\n2026-09-24,11.15\n2026-09-25,11.28\n';
const API_BODY = JSON.stringify({ observations: [{ date: '2026-09-25', value: '11.28' }] });

/** Records every URL fetched so the subrequest count can be asserted. */
function stubFetch(handler: (host: string, url: string) => Response) {
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    return handler(new URL(url).host, url);
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const ok = (body: string, type: string) =>
  new Response(body, { status: 200, headers: { 'content-type': type } });
const boom = (status: number) => new Response('upstream error', { status });

const env = { FRED_API_KEY: 'test-key' } as never;
const opts = { from: '2026-09-20' } as never;

test('an API 5xx falls back to the CSV host, which is a different host', async () => {
  resetFredHostState();
  const f = stubFetch((host) => host.startsWith('api.') ? boom(520) : ok(CSV_BODY, 'text/csv'));
  try {
    const pts = await fred.fetchSeries('BAMLH0A3HYC', opts, env);
    assert.equal(pts.length, 2, 'the CSV host had the data all along');
    assert.equal(pts[1].value, 11.28);
    assert.equal(f.calls.length, 2, 'exactly one extra subrequest');
    assert.ok(f.calls[0].includes('api.stlouisfed.org'));
    assert.ok(f.calls[1].includes('fredgraph.csv'));
  } finally { f.restore(); }
});

test('after the first 5xx, later series skip the API entirely', async () => {
  // This is the whole point: the fallback must not cost one extra
  // subrequest PER SERIES, or a FRED outage exhausts the subrequest cap
  // and takes down tiles that have nothing to do with FRED.
  resetFredHostState();
  const f = stubFetch((host) => host.startsWith('api.') ? boom(520) : ok(CSV_BODY, 'text/csv'));
  try {
    for (const id of ['A', 'B', 'C', 'D', 'E']) await fred.fetchSeries(id, opts, env);
    const apiCalls = f.calls.filter((u) => u.includes('api.stlouisfed.org'));
    assert.equal(apiCalls.length, 1, `the API host must be tried once, not per series (got ${apiCalls.length})`);
    assert.equal(f.calls.length, 6, '1 failed API probe + 5 CSV fetches');
  } finally { f.restore(); }
});

test('both hosts failing is reported as a genuine FRED outage', async () => {
  resetFredHostState();
  const f = stubFetch(() => boom(503));
  try {
    await assert.rejects(
      () => fred.fetchSeries('BAMLH0A3HYC', opts, env),
      (e: Error) => {
        assert.match(e.message, /both endpoints/);
        assert.match(e.message, /API:/);
        assert.match(e.message, /CSV:/);
        return true;
      },
    );
    assert.equal(f.calls.length, 2, 'two attempts, then stop — no further retries');
  } finally { f.restore(); }
});

test('a healthy API host is used and the CSV host is never touched', async () => {
  resetFredHostState();
  const f = stubFetch((host) => host.startsWith('api.') ? ok(API_BODY, 'application/json') : boom(500));
  try {
    const pts = await fred.fetchSeries('BAMLH0A3HYC', opts, env);
    assert.equal(pts[0].value, 11.28);
    assert.equal(f.calls.length, 1, 'no fallback when the API works');
  } finally { f.restore(); }
});

test('the down-flag is per run, not sticky across runs', async () => {
  // Module state survives in a warm isolate. If the flag were never
  // cleared, the API host would stay abandoned long after it recovered.
  resetFredHostState();
  let apiHealthy = false;
  const f = stubFetch((host) => {
    if (!host.startsWith('api.')) return ok(CSV_BODY, 'text/csv');
    return apiHealthy ? ok(API_BODY, 'application/json') : boom(520);
  });
  try {
    await fred.fetchSeries('X', opts, env);          // trips the flag
    apiHealthy = true;
    resetFredHostState();                            // next scheduled run
    f.calls.length = 0;
    await fred.fetchSeries('Y', opts, env);
    assert.ok(f.calls[0].includes('api.stlouisfed.org'),
      'a new run must try the API host again, or recovery is never noticed');
    assert.equal(f.calls.length, 1);
  } finally { f.restore(); }
});

test('a non-5xx API failure still falls back, as it always did', async () => {
  resetFredHostState();
  const f = stubFetch((host) => host.startsWith('api.') ? boom(403) : ok(CSV_BODY, 'text/csv'));
  try {
    const pts = await fred.fetchSeries('BAMLH0A3HYC', opts, env);
    assert.equal(pts.length, 2);
  } finally { f.restore(); }
});
