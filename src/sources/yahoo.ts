import type { DataSource, FetchOpts, Point } from './types.ts';

// Yahoo Finance chart API — keyless daily closes. Used as a declared
// fallback (e.g. gold: stooq primary, GC=F futures close here) so a dead
// primary degrades to another REAL source before degrading to a stale tile.

export function yahooChartUrl(symbol: string, opts: FetchOpts): string {
  const url = new URL(`https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`);
  url.searchParams.set('interval', '1d');
  const to = opts.to ? Date.parse(opts.to + 'T23:59:59Z') : Date.now();
  const from = opts.from ? Date.parse(opts.from + 'T00:00:00Z') : to - 400 * 86400000;
  url.searchParams.set('period1', String(Math.floor(from / 1000)));
  url.searchParams.set('period2', String(Math.floor(to / 1000)));
  return url.toString();
}

export function parseYahooChart(text: string, symbol: string): Point[] {
  let body: any;
  try { body = JSON.parse(text); } catch { throw new Error(`yahoo non-JSON for ${symbol}`); }
  const result = body?.chart?.result?.[0];
  if (!result) throw new Error(`yahoo: ${body?.chart?.error?.description ?? 'no result'} for ${symbol}`);
  const ts: number[] = result.timestamp ?? [];
  const closes: (number | null)[] = result.indicators?.quote?.[0]?.close ?? [];
  const out: Point[] = [];
  for (let i = 0; i < ts.length; i++) {
    const v = closes[i];
    if (v !== null && v !== undefined && Number.isFinite(v)) {
      out.push({ date: new Date(ts[i] * 1000).toISOString().slice(0, 10), value: v });
    }
  }
  if (!out.length) throw new Error(`yahoo: no closes for ${symbol}`);
  // yahoo can emit duplicate dates around session boundaries — keep the last
  const dedup = new Map<string, number>();
  for (const p of out) dedup.set(p.date, p.value);
  return [...dedup.entries()].map(([date, value]) => ({ date, value })).sort((a, b) => a.date < b.date ? -1 : 1);
}

export const yahoo: DataSource = {
  id: 'yahoo',
  async fetchSeries(symbol: string, opts: FetchOpts): Promise<Point[]> {
    const res = await fetch(yahooChartUrl(symbol, opts), {
      headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36' },
    });
    if (!res.ok) throw new Error(`yahoo ${res.status} for ${symbol}`);
    return parseYahooChart(await res.text(), symbol);
  },
};
