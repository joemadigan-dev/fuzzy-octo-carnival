import type { DataSource, FetchOpts, Point } from './types.ts';

// CNN Fear & Greed graphdata — real daily sentiment data, keyless. The
// payload carries the composite plus its components (incl. put/call, which
// is real CBOE-derived data; CBOE's own endpoints hard-block non-browser
// clients). One year of history per fetch; the store accumulates the rest.
// seriesId = a key in the payload: 'fear_and_greed_historical',
// 'put_call_options', …

const URL = 'https://production.dataviz.cnn.io/index/fearandgreed/graphdata';

export function parseCnnGraphdata(text: string, seriesId: string): Point[] {
  let body: any;
  try { body = JSON.parse(text); } catch { throw new Error('cnn non-JSON (likely bot-blocked)'); }
  const data = body?.[seriesId]?.data;
  if (!Array.isArray(data)) throw new Error(`cnn: no series '${seriesId}' in payload`);
  const dedup = new Map<string, number>();
  for (const p of data) {
    const v = Number(p.y);
    if (Number.isFinite(v) && p.x) dedup.set(new Date(p.x).toISOString().slice(0, 10), v);
  }
  const out = [...dedup.entries()].map(([date, value]) => ({ date, value }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  if (!out.length) throw new Error(`cnn: series '${seriesId}' empty`);
  return out;
}

export const cnn: DataSource = {
  id: 'cnn',
  async fetchSeries(seriesId: string, _opts: FetchOpts): Promise<Point[]> {
    const res = await fetch(URL, {
      headers: {
        accept: 'application/json',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        referer: 'https://www.cnn.com/markets/fear-and-greed',
        origin: 'https://www.cnn.com',
      },
    });
    if (!res.ok) throw new Error(`cnn ${res.status}`);
    return parseCnnGraphdata(await res.text(), seriesId);
  },
};
