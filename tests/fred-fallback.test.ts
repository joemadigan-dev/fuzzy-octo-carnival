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

/** Records every URL fetched so the subrequest count can be asserted, and
 *  every request's headers so the User-Agent can be. */
function stubFetch(handler: (host: string, url: string) => Response) {
  const calls: string[] = [];
  const headers: Record<string, string>[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    headers.push({ ...((init?.headers ?? {}) as Record<string, string>) });
    return handler(new URL(url).host, url);
  }) as typeof fetch;
  return { calls, headers, restore: () => { globalThis.fetch = original; } };
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

// ── the User-Agent ────────────────────────────────────────────────────
//
// The seven-day blackout above had a second cause, and this was the real
// one. The narrowed guard worked exactly as designed in production — the
// run log shows one API attempt then twenty straight-to-CSV fetches — and
// it changed nothing, because the CSV host was refusing us too. FRED sits
// behind Akamai, and Workers `fetch` sends no User-Agent, and Akamai
// resets the stream on a request that will not say what it is. Cloudflare
// reports that reset as a 520, which reads exactly like an outage.
//
// Verified against the live host on 2026-09-30: no UA reset 4/4, a
// browser-like UA reset 3/3, an honest tool UA returned 200 3/3.

test('every FRED request identifies itself, on both hosts', async () => {
  resetFredHostState();
  const f = stubFetch((host) => host.startsWith('api.') ? boom(520) : ok(CSV_BODY, 'text/csv'));
  try {
    await fred.fetchSeries('BAMLH0A3HYC', opts, env);
    assert.equal(f.calls.length, 2, 'API then CSV — both must carry the header');
    for (const [i, h] of f.headers.entries()) {
      const ua = h['user-agent'];
      assert.ok(ua, `request ${i} (${f.calls[i]}) sent no User-Agent — that is the 520`);
      assert.match(ua, /^the-wall\/\d/, 'must identify this Worker, not a browser');
    }
  } finally { f.restore(); }
});

test('the User-Agent does not impersonate a browser', async () => {
  // A browser UA is not merely dishonest here, it is what Akamai refuses:
  // a browser string with no browser behind it is itself the bot signal.
  resetFredHostState();
  const f = stubFetch(() => ok(API_BODY, 'application/json'));
  try {
    await fred.fetchSeries('DGS10', opts, env);
    const ua = f.headers[0]['user-agent'];
    assert.doesNotMatch(ua, /Mozilla|AppleWebKit|Chrome|Safari|Gecko/i);
    assert.match(ua, /\+https?:\/\//, 'carry a URL so FRED can complain to us');
  } finally { f.restore(); }
});

test('the keyless path identifies itself too', async () => {
  // With no key configured every series takes this branch, and it is the
  // branch that was returning 520 for twenty of the twenty-one failures.
  resetFredHostState();
  const f = stubFetch(() => ok(CSV_BODY, 'text/csv'));
  try {
    await fred.fetchSeries('DGS10', opts, {} as never);
    assert.equal(f.calls.length, 1);
    assert.match(f.headers[0]['user-agent'], /^the-wall\//);
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
