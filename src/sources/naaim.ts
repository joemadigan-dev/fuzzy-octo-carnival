import type { DataSource, FetchOpts, Point } from './types.ts';

// NAAIM Exposure Index — weekly active-manager equity exposure, scraped
// from the chart JSON that naaim.org embeds in its own page (there is no
// public API; the survey file endpoints are members-only). Fragile by
// nature; failure degrades to a stale tile, never a blank one.

const URL = 'https://index.naaim.org/embeddable/chart';
const ATTR = 'data-symfony--ux-chartjs--chart-view-value="';

function decodeEntities(s: string): string {
  return s
    .replaceAll('&quot;', '"').replaceAll('&#039;', "'").replaceAll('&#39;', "'")
    .replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
}

export function parseNaaimChart(html: string): Point[] {
  const at = html.indexOf(ATTR);
  if (at < 0) throw new Error('naaim: chart data attribute not found (page changed?)');
  const start = at + ATTR.length;
  const end = html.indexOf('"', start);
  const cfg = JSON.parse(decodeEntities(html.slice(start, end)));
  const labels: string[] = cfg?.data?.labels ?? [];
  const values: number[] = cfg?.data?.datasets?.[0]?.data ?? [];
  const out: Point[] = [];
  for (let i = 0; i < Math.min(labels.length, values.length); i++) {
    const v = Number(values[i]);
    if (/^\d{4}-\d{2}-\d{2}$/.test(labels[i]) && Number.isFinite(v)) {
      out.push({ date: labels[i], value: v });
    }
  }
  if (!out.length) throw new Error('naaim: no parseable points');
  return out.sort((a, b) => (a.date < b.date ? -1 : 1));
}

export const naaim: DataSource = {
  id: 'naaim',
  async fetchSeries(_seriesId: string, _opts: FetchOpts): Promise<Point[]> {
    const res = await fetch(URL, {
      headers: {
        accept: 'text/html',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      },
    });
    if (!res.ok) throw new Error(`naaim ${res.status}`);
    return parseNaaimChart(await res.text());
  },
};
