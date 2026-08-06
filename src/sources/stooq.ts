import type { DataSource, FetchOpts, Point } from './types.ts';

// stooq.com — free daily CSV, no key. Used for gold spot (xauusd).
// CSV shape: Date,Open,High,Low,Close,Volume

const BASE = 'https://stooq.com/q/d/l/';

function ymd(iso: string): string {
  return iso.replaceAll('-', '');
}

export function stooqCsvUrl(seriesId: string, opts: FetchOpts): string {
  const url = new URL(BASE);
  url.searchParams.set('s', seriesId);
  url.searchParams.set('i', 'd');
  if (opts.from) url.searchParams.set('d1', ymd(opts.from));
  if (opts.to) url.searchParams.set('d2', ymd(opts.to));
  return url.toString();
}

export function parseStooqCsv(text: string, seriesId: string): Point[] {
  if (text.trimStart().startsWith('<')) throw new Error(`stooq returned HTML for ${seriesId}`);
  const lines = text.trim().split('\n');
    if (lines.length < 2) throw new Error(`stooq empty response for ${seriesId}`);
    const header = lines[0].toLowerCase().split(',');
    const dateIdx = header.indexOf('date');
    const closeIdx = header.indexOf('close');
    if (dateIdx < 0 || closeIdx < 0) throw new Error(`stooq unexpected header for ${seriesId}: ${lines[0]}`);
    const out: Point[] = [];
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(',');
      const date = cols[dateIdx]?.trim();
      const v = Number(cols[closeIdx]);
      if (date && /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(v)) {
        out.push({ date, value: v });
      }
    }
  if (out.length === 0) throw new Error(`stooq no parseable rows for ${seriesId}`);
  return out;
}

export const stooq: DataSource = {
  id: 'stooq',
  async fetchSeries(seriesId: string, opts: FetchOpts): Promise<Point[]> {
    const res = await fetch(stooqCsvUrl(seriesId, opts), {
      headers: { accept: 'text/csv', 'user-agent': 'the-wall/1.0 (macro dashboard)' },
    });
    if (!res.ok) throw new Error(`stooq ${res.status} for ${seriesId}`);
    return parseStooqCsv(await res.text(), seriesId);
  },
};
