// One-shot deep-history heal for the REMOTE (production) D1.
//
// The scheduled job heals truncated histories on its own — see the
// `deep:<id>` marker in src/scheduled/index.ts — but it can only do so
// when the upstream is up, and it paces itself at a few series per run.
// This script does the same work immediately, from a machine that can
// reach the sources, using the SAME production parsers and the same
// BACKFILL_START. No mock data: real observations, real parsers.
//
// It only touches series whose stored history starts later than the
// source offers, writes with the same idempotent upsert the cron uses,
// and sets the same `deep:` markers so the cron does not redo the work.
//
// Usage:  CLOUDFLARE_API_TOKEN=... node --experimental-strip-types scripts/remote-heal.mts [seriesId ...]

import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { KPIS, BACKFILL_START } from '../src/registry/kpis.ts';
import { fredCsvUrl, parseFredCsv } from '../src/sources/fred.ts';
import { stooqCsvUrl, parseStooqCsv } from '../src/sources/stooq.ts';
import { yahooChartUrl, parseYahooChart } from '../src/sources/yahoo.ts';
import type { Point } from '../src/sources/types.ts';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const today = new Date().toISOString().slice(0, 10);
const only = new Set(process.argv.slice(2));

function curl(url: string): string {
  return execFileSync('curl', ['-sS', '-m', '90', '-H', `user-agent: ${UA}`, url],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function d1(sql: string): any[] {
  const out = execFileSync('npx',
    ['wrangler', 'd1', 'execute', 'the-wall', '--remote', '--json', '--command', sql],
    { encoding: 'utf8', maxBuffer: 1 << 28 });
  return JSON.parse(out)[0].results;
}

function d1File(path: string): void {
  execFileSync('npx', ['wrangler', 'd1', 'execute', 'the-wall', '--remote', '--file', path, '-y'],
    { stdio: 'inherit' });
}

/** FRED's official API, same observations as the CSV endpoint. Preferred
 *  here because the two fail independently and the CSV host has been the
 *  flakier of the pair. */
function fredApi(seriesId: string, key: string): Point[] {
  const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${encodeURIComponent(seriesId)}`
    + `&api_key=${encodeURIComponent(key)}&file_type=json`
    + `&observation_start=${BACKFILL_START}&observation_end=${today}`;
  const body = JSON.parse(curl(url)) as { observations?: { date: string; value: string }[] };
  if (!body.observations) throw new Error(`FRED API: no observations for ${seriesId}`);
  const out: Point[] = [];
  for (const o of body.observations) {
    const v = Number(o.value);
    if (o.value !== '.' && Number.isFinite(v)) out.push({ date: o.date, value: v });
  }
  return out;
}

function fetchPoints(source: string, seriesId: string): Point[] {
  switch (source) {
    case 'fred': {
      const key = process.env.FRED_API_KEY;
      if (key) {
        try { return fredApi(seriesId, key); } catch { /* fall through to keyless CSV */ }
      }
      return parseFredCsv(curl(fredCsvUrl(seriesId, { from: BACKFILL_START, to: today })), seriesId);
    }
    case 'stooq': return parseStooqCsv(curl(stooqCsvUrl(seriesId, { from: BACKFILL_START, to: today })), seriesId);
    case 'yahoo': return parseYahooChart(curl(yahooChartUrl(seriesId, { from: BACKFILL_START, to: today })), seriesId);
    default: throw new Error(`unsupported source ${source}`);
  }
}

// what production currently holds
const stored = new Map<string, { n: number; mn: string }>();
for (const r of d1('SELECT series_id, COUNT(*) n, MIN(date) mn FROM observations GROUP BY series_id')) {
  stored.set(r.series_id, { n: r.n, mn: r.mn });
}

const healed: string[] = [];
const skipped: string[] = [];
const failed: string[] = [];

for (const kpi of KPIS) {
  if (!kpi.source || !kpi.seriesId) continue;
  if (only.size && !only.has(kpi.id)) continue;
  if (kpi.heavyParse) { skipped.push(`${kpi.id} (heavy parse — left to the cron)`); continue; }
  if (!['fred', 'stooq', 'yahoo'].includes(kpi.source)) { skipped.push(`${kpi.id} (${kpi.source} not supported here)`); continue; }

  const have = stored.get(kpi.id);
  try {
    let pts: Point[];
    try {
      pts = fetchPoints(kpi.source, kpi.seriesId);
    } catch (primaryErr) {
      if (!kpi.fallback) throw primaryErr;
      pts = fetchPoints(kpi.fallback.source, kpi.fallback.seriesId);
    }
    if (kpi.fetchScale) pts = pts.map((p) => ({ date: p.date, value: p.value * kpi.fetchScale! }));
    if (!pts.length) throw new Error('source returned nothing');

    // only write when the source genuinely reaches further back
    if (have && pts[0].date >= have.mn) {
      skipped.push(`${kpi.id} (already from ${have.mn}; source starts ${pts[0].date})`);
      continue;
    }

    const chunks: string[] = [];
    for (let i = 0; i < pts.length; i += 200) {
      chunks.push(
        'INSERT INTO observations (series_id, date, value) VALUES ' +
        pts.slice(i, i + 200).map((p) => `('${kpi.id}','${p.date}',${p.value})`).join(',') +
        ' ON CONFLICT(series_id, date) DO UPDATE SET value=excluded.value;',
      );
    }
    chunks.push(
      `INSERT INTO meta (key, value) VALUES ('deep:${kpi.id}','${BACKFILL_START}') ` +
      'ON CONFLICT(key) DO UPDATE SET value=excluded.value;',
    );
    const file = join(mkdtempSync(join(tmpdir(), 'heal-')), `${kpi.id}.sql`);
    writeFileSync(file, chunks.join('\n'));
    d1File(file);
    healed.push(`${kpi.id}: ${have?.mn ?? 'none'} → ${pts[0].date} (${pts.length} obs)`);
  } catch (e) {
    failed.push(`${kpi.id}: ${e instanceof Error ? e.message.slice(0, 160) : e}`);
  }
}

console.log('\nHEALED:\n  ' + (healed.join('\n  ') || 'none'));
console.log('\nSKIPPED:\n  ' + (skipped.join('\n  ') || 'none'));
if (failed.length) console.log('\nFAILED:\n  ' + failed.join('\n  '));
console.log('\nNow trigger a refresh so derived series and the barometer recompute.');
