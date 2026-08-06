import type { DataSource, FetchOpts, Point, SourceEnv } from './types.ts';

// FRED. Two real endpoints for the same data:
//  1. official API (JSON) when FRED_API_KEY is set — preferred
//  2. keyless fredgraph.csv fallback — same observations, no credentials
// Both return actual FRED data; the fallback keeps the wall alive with zero
// secrets configured and covers local dev before a key exists.

const API = 'https://api.stlouisfed.org/fred/series/observations';
const CSV = 'https://fred.stlouisfed.org/graph/fredgraph.csv';

async function fetchViaApi(seriesId: string, opts: FetchOpts, key: string): Promise<Point[]> {
  const url = new URL(API);
  url.searchParams.set('series_id', seriesId);
  url.searchParams.set('api_key', key);
  url.searchParams.set('file_type', 'json');
  if (opts.from) url.searchParams.set('observation_start', opts.from);
  if (opts.to) url.searchParams.set('observation_end', opts.to);
  const res = await fetch(url.toString(), { headers: { accept: 'application/json' } });
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
  const res = await fetch(fredCsvUrl(seriesId, opts), { headers: { accept: 'text/csv' } });
  if (!res.ok) throw new Error(`FRED csv ${res.status} for ${seriesId}`);
  return parseFredCsv(await res.text(), seriesId);
}

export const fred: DataSource = {
  id: 'fred',
  async fetchSeries(seriesId: string, opts: FetchOpts, env: SourceEnv): Promise<Point[]> {
    if (env.FRED_API_KEY) {
      try {
        return await fetchViaApi(seriesId, opts, env.FRED_API_KEY);
      } catch {
        // fall through to keyless endpoint — same data
      }
    }
    return fetchViaCsv(seriesId, opts);
  },
};
