import { read, utils } from 'xlsx';
import type { DataSource, FetchOpts, Point } from './types.ts';

// Aswath Damodaran's implied equity risk premium datasets.
// pages.stern.nyu.edu/~adamodar — a personal academic site run by one
// professor, not a commercial API. We fetch at MOST monthly (see
// fetchIntervalDays on the KPIs), cache the parsed workbook for the
// duration of the run, and never poll. He is credited by name on the
// cluster header.
//
// TWO TRAPS, both silent if you get them wrong:
//
//  1. These workbooks were authored in Macintosh Excel and carry
//     date1904: true. SheetJS does NOT apply the 1904 offset even with
//     cellDates, so every serial reads four years early — the August 2026
//     row parses as 2022. We read raw serials and apply the offset
//     ourselves, which is deterministic and auditable.
//  2. The current-month file has a rotating name (ERPAug26.xlsx). We never
//     construct it. ERPbymonth.xlsx is the stable file and carries the
//     whole monthly series including the current month.

const BASE = 'https://pages.stern.nyu.edu/~adamodar';
export const MONTHLY_URL = `${BASE}/pc/implprem/ERPbymonth.xlsx`;
export const ANNUAL_URL = `${BASE}/pc/datasets/histimpl.xls`;
export const HISTRET_URL = `${BASE}/pc/datasets/histretSP.xls`;

const EPOCH_1904_OFFSET = 1462; // days between the 1900 and 1904 epochs

/** Excel serial → ISO date, honouring the workbook's epoch. */
export function serialToIso(serial: number, is1904: boolean): string {
  const ms = Date.UTC(1899, 11, 30) + (serial + (is1904 ? EPOCH_1904_OFFSET : 0)) * 86400000;
  return new Date(ms).toISOString().slice(0, 10);
}

export interface Sheet { rows: unknown[][]; is1904: boolean }

export function parseWorkbook(buf: ArrayBuffer, sheetName: string): Sheet {
  const wb = read(new Uint8Array(buf), { type: 'array' });
  const ws = wb.Sheets[sheetName] ?? wb.Sheets[wb.SheetNames[0]];
  if (!ws) throw new Error(`damodaran: sheet '${sheetName}' not found`);
  return {
    rows: utils.sheet_to_json(ws, { header: 1, raw: true }) as unknown[][],
    is1904: Boolean(wb.Workbook?.WBProps?.date1904),
  };
}

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

/** Monthly sheet: 'Start of month' serial in col 0, measures thereafter. */
export function parseMonthly(sheet: Sheet, col: number, scale = 100): Point[] {
  const out: Point[] = [];
  for (let i = 1; i < sheet.rows.length; i++) {
    const r = sheet.rows[i];
    const serial = num(r?.[0]);
    const v = num(r?.[col]);
    if (serial === null || v === null) continue;
    out.push({ date: serialToIso(serial, sheet.is1904), value: v * scale });
  }
  return dedupeSorted(out);
}

/** Annual sheet: calendar year in col 0. Dated to 31 Dec of that year —
 *  these are year-END values and must not be dated to 1 January. */
export function parseAnnual(sheet: Sheet, col: number, scale = 100): Point[] {
  const out: Point[] = [];
  for (const r of sheet.rows) {
    const y = num(r?.[0]);
    const v = num(r?.[col]);
    if (y === null || v === null || y < 1900 || y > 2100) continue;
    out.push({ date: `${y}-12-31`, value: v * scale });
  }
  return dedupeSorted(out);
}

function dedupeSorted(pts: Point[]): Point[] {
  const m = new Map<string, number>();
  for (const p of pts) m.set(p.date, p.value);
  return [...m.entries()].map(([date, value]) => ({ date, value }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}

/** seriesId → where the number lives. Columns verified against the live
 *  workbooks; a layout change surfaces as a fetch error, not bad data. */
const SERIES: Record<string, { url: string; sheet: string; col: number; annual?: boolean; scale?: number }> = {
  // monthly, ERPbymonth.xlsx → 'Historical ERP'
  erp:       { url: MONTHLY_URL, sheet: 'Historical ERP', col: 8 },  // T12m w/ sustainable payout — his primary
  erp_norm:  { url: MONTHLY_URL, sheet: 'Historical ERP', col: 12 }, // normalized earnings & payout
  erp_rf:    { url: MONTHLY_URL, sheet: 'Historical ERP', col: 2 },  // T.Bond rate used that month
  erp_spx:   { url: MONTHLY_URL, sheet: 'Historical ERP', col: 1, scale: 1 },
  erp_cf:    { url: MONTHLY_URL, sheet: 'Historical ERP', col: 5, scale: 1 }, // trailing 12m cash flow
  // annual, histimpl.xls → deep history back to 1961 for reference marks.
  // NOTE this is Implied ERP (FCFE) — a DIFFERENT measure from the monthly
  // sustainable-payout series. Kept as its own series; never spliced.
  erp_annual: { url: ANNUAL_URL, sheet: 'Historical Impl Premiums', col: 15, annual: true },
};

/** Parsed workbooks are cached for the life of the isolate so one cron run
 *  downloads each file once regardless of how many series read from it. */
const cache = new Map<string, Promise<Sheet>>();

function loadSheet(url: string, sheet: string): Promise<Sheet> {
  const key = `${url}#${sheet}`;
  let p = cache.get(key);
  if (!p) {
    p = (async () => {
      const res = await fetch(url, {
        headers: {
          accept: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel',
          'user-agent': 'jm-barometer/1.0 (macro dashboard; monthly fetch)',
        },
      });
      if (!res.ok) throw new Error(`damodaran ${res.status} for ${url}`);
      return parseWorkbook(await res.arrayBuffer(), sheet);
    })();
    cache.set(key, p);
  }
  return p;
}

export const damodaran: DataSource = {
  id: 'damodaran',
  async fetchSeries(seriesId: string, _opts: FetchOpts): Promise<Point[]> {
    const spec = SERIES[seriesId];
    if (!spec) throw new Error(`damodaran: unknown series '${seriesId}'`);
    const sheet = await loadSheet(spec.url, spec.sheet);
    const pts = spec.annual
      ? parseAnnual(sheet, spec.col, spec.scale ?? 100)
      : parseMonthly(sheet, spec.col, spec.scale ?? 100);
    if (!pts.length) throw new Error(`damodaran: no rows parsed for '${seriesId}' (layout changed?)`);
    return pts;
  },
};
