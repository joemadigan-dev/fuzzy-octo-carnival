import type { DataSource, FetchOpts, Point, SourceEnv } from './types.ts';

// FRED. Two real endpoints for the same data:
//  1. official API (JSON) when FRED_API_KEY is set — preferred
//  2. keyless fredgraph.csv fallback — same observations, no credentials
// Both return actual FRED data; the fallback keeps the barometer alive with zero
// secrets configured and covers local dev before a key exists.

const API = 'https://api.stlouisfed.org/fred/series/observations';
const CSV = 'https://fred.stlouisfed.org/graph/fredgraph.csv';

/** FRED sits behind Akamai Bot Manager (it sets _abck / bm_sz on
 *  .stlouisfed.org). A request carrying NO User-Agent — which is exactly
 *  what the Workers runtime sends, because `fetch` adds none by default —
 *  has its HTTP/2 stream reset by the edge, and Cloudflare reports that
 *  reset to the Worker as a 520. Nothing was down. Both hosts served fresh
 *  data throughout to any client that identified itself.
 *
 *  That cost seven days of credit data, and the cost was not cosmetic: on
 *  2026-09-30 the dashboard read CCC & lower +62bp over 20 sessions,
 *  3bp under its 65bp trigger, while FRED had +108bp. The Credit Canary
 *  was being held at CALM by the outage.
 *
 *  Measured against fred.stlouisfed.org on 2026-09-30, same container,
 *  same minute:
 *    no User-Agent header          000 (stream reset)  4/4
 *    'Mozilla/5.0 ... Chrome/140'  000 (stream reset)  3/3
 *    'curl/8.5.0'                  200                 3/3
 *    'python-requests/2.32'        200                 1/1
 *    this string                   200                 3/3
 *
 *  Note which way round that is. Claiming to be a browser is what gets
 *  refused, because a browser UA with no browser fingerprint behind it is
 *  itself the bot signal. Saying plainly what we are, with a URL to
 *  complain to, is what works — so this must stay an honest identifier.
 *  Do not dress it up as a browser, and do not vary it per request. */
const UA = 'the-wall/1.0 (+https://the-wall.joemadigan.workers.dev)';

/** Thrown when the API host returned 5xx.
 *
 *  This used to mean "do not try the keyless endpoint, it is the same
 *  origin and would fail identically". THAT WAS WRONG, and it cost five
 *  days of frozen credit data to find out: the two endpoints are
 *  different hosts, and from 2026-09-25 api.stlouisfed.org returned 520
 *  to this Worker while fred.stlouisfed.org served fresh observations the
 *  whole time. The dashboard showed CCC at 1093bp while FRED had 1128bp —
 *  stale data understating the one spread that was moving.
 *
 *  The original concern was real, though: Worker invocations have a hard
 *  subrequest cap, and a blind second attempt for every one of ~46 series
 *  is what exhausts it and takes down tiles that have nothing to do with
 *  FRED. So the retry is not per-series. The FIRST 5xx marks the API host
 *  as unavailable for the rest of the run and every remaining series goes
 *  straight to the CSV host — one extra subrequest in total, not one per
 *  series, and the barometer keeps its data. */
class UpstreamDown extends Error {}

/** Set when the API host 5xxs, cleared at the start of each scheduled run.
 *
 *  Module state survives between invocations in a warm isolate, which is
 *  exactly why it is reset explicitly rather than left to expire: a stale
 *  flag would silently keep using the fallback long after the API host
 *  recovered, and the run log would stop saying why. */
let apiHostDown = false;

/** Called once at the top of each scheduled run. */
export function resetFredHostState(): void {
  apiHostDown = false;
}

async function fetchViaApi(seriesId: string, opts: FetchOpts, key: string): Promise<Point[]> {
  const url = new URL(API);
  url.searchParams.set('series_id', seriesId);
  url.searchParams.set('api_key', key);
  url.searchParams.set('file_type', 'json');
  if (opts.from) url.searchParams.set('observation_start', opts.from);
  if (opts.to) url.searchParams.set('observation_end', opts.to);
  const res = await fetch(url.toString(), {
    headers: { accept: 'application/json', 'user-agent': UA },
  });
  if (res.status >= 500) throw new UpstreamDown(`FRED API ${res.status} for ${seriesId}`);
  if (!res.ok) throw new Error(`FRED API ${res.status} for ${seriesId}`);
  const body = (await res.json()) as { observations?: { date: string; value: string }[] };
  if (!body.observations) throw new Error(`FRED API: no observations for ${seriesId}`);
  const out: Point[] = [];
  for (const o of body.observations) {
    const v = Number(o.value);
    if (o.value !== '.' && Number.isFinite(v)) out.push({ date: o.date, value: v });
  }
  return out;
}

export function fredCsvUrl(seriesId: string, opts: FetchOpts): string {
  const url = new URL(CSV);
  url.searchParams.set('id', seriesId);
  if (opts.from) url.searchParams.set('cosd', opts.from);
  if (opts.to) url.searchParams.set('coed', opts.to);
  return url.toString();
}

export function parseFredCsv(text: string, seriesId: string): Point[] {
  if (text.trimStart().startsWith('<')) throw new Error(`FRED csv returned HTML for ${seriesId}`);
  const lines = text.trim().split('\n');
  const out: Point[] = [];
  for (let i = 1; i < lines.length; i++) {
    const comma = lines[i].indexOf(',');
    if (comma < 0) continue;
    const date = lines[i].slice(0, comma).trim();
    const raw = lines[i].slice(comma + 1).trim();
    const v = Number(raw);
    if (raw !== '' && raw !== '.' && Number.isFinite(v) && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
      out.push({ date, value: v });
    }
  }
  if (out.length === 0 && lines.length <= 1) throw new Error(`FRED csv empty for ${seriesId}`);
  return out;
}

async function fetchViaCsv(seriesId: string, opts: FetchOpts): Promise<Point[]> {
  const res = await fetch(fredCsvUrl(seriesId, opts), {
    headers: { accept: 'text/csv', 'user-agent': UA },
  });
  if (!res.ok) throw new Error(`FRED csv ${res.status} for ${seriesId}`);
  return parseFredCsv(await res.text(), seriesId);
}

export const fred: DataSource = {
  id: 'fred',
  async fetchSeries(seriesId: string, opts: FetchOpts, env: SourceEnv): Promise<Point[]> {
    // Once the API host has 5xxed this run, do not keep asking it. Every
    // later series goes straight to the CSV host, so the fallback costs
    // one subrequest for the whole run rather than one per series.
    if (env.FRED_API_KEY && !apiHostDown) {
      try {
        return await fetchViaApi(seriesId, opts, env.FRED_API_KEY);
      } catch (e) {
        if (e instanceof UpstreamDown) {
          // The API host is unwell. The CSV host is a DIFFERENT host and
          // may well be fine — that is the case this exists to handle.
          apiHostDown = true;
          try {
            return await fetchViaCsv(seriesId, opts);
          } catch (csvErr) {
            // Both hosts failing IS a FRED-wide outage. Report the real
            // cause; no further retries for this series.
            throw new Error(`FRED unavailable on both endpoints for ${seriesId} — API: ${e.message}; CSV: ${csvErr instanceof Error ? csvErr.message : csvErr}`);
          }
        }
        // Anything else (bad key, rate limit, parse) is worth retrying
        // keylessly — it is genuinely a different path to the same data.
        try {
          return await fetchViaCsv(seriesId, opts);
        } catch (csvErr) {
          throw new Error(`${csvErr instanceof Error ? csvErr.message : csvErr} (API first failed: ${e instanceof Error ? e.message : e})`);
        }
      }
    }
    return fetchViaCsv(seriesId, opts);
  },
};
