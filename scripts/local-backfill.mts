// Local-dev backfill for restricted-network sandboxes.
//
// `wrangler dev` runs the Worker in workerd, whose outbound fetch does NOT
// use the sandbox's HTTPS proxy — so in a proxied dev environment the cron
// job can't reach FRED/stooq (in production on Cloudflare it can, directly).
//
// This script fetches the SAME real data via curl (which honours the proxy),
// parses it with the SAME production parsers, seeds the local D1 database,
// then triggers the real pipeline via POST /api/admin/refresh so every
// derived metric, wall_state row, and the composite are computed by the
// actual product code. No mock data — real observations, real pipeline.
//
// Usage:  npm run migrate:local
//         npm run dev            (in another terminal)
//         npm run backfill:local

import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { KPIS, BACKFILL_START } from '../src/registry/kpis.ts';
import { fredCsvUrl, parseFredCsv } from '../src/sources/fred.ts';
import { stooqCsvUrl, parseStooqCsv } from '../src/sources/stooq.ts';
import { yahooChartUrl, parseYahooChart } from '../src/sources/yahoo.ts';
import type { Point } from '../src/sources/types.ts';

const DEV_URL = process.env.DEV_URL ?? 'http://localhost:8787';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? 'change-me';

function curl(url: string): string {
  return execFileSync('curl', ['-sS', '-m', '60', '-H', 'user-agent: Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36', url],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function fetchPoints(source: string, seriesId: string, from: string, to: string): Point[] {
  switch (source) {
    case 'fred': return parseFredCsv(curl(fredCsvUrl(seriesId, { from, to })), seriesId);
    case 'stooq': return parseStooqCsv(curl(stooqCsvUrl(seriesId, { from, to })), seriesId);
    case 'yahoo': return parseYahooChart(curl(yahooChartUrl(seriesId, { from, to })), seriesId);
    default: throw new Error(`unknown source ${source}`);
  }
}

const today = new Date().toISOString().slice(0, 10);
const seeded: string[] = [];
const failed: string[] = [];
const sqlChunks: string[] = [];

for (const kpi of KPIS) {
  if (!kpi.source || !kpi.seriesId) continue;
  try {
    let pts: Point[];
    try {
      pts = fetchPoints(kpi.source, kpi.seriesId, BACKFILL_START, today);
    } catch (primaryErr) {
      if (!kpi.fallback) throw primaryErr;
      console.log(`${kpi.id}: primary ${kpi.source} failed (${primaryErr instanceof Error ? primaryErr.message : primaryErr}), trying ${kpi.fallback.source}`);
      pts = fetchPoints(kpi.fallback.source, kpi.fallback.seriesId, BACKFILL_START, today);
    }
    for (let i = 0; i < pts.length; i += 200) {
      const chunk = pts.slice(i, i + 200);
      sqlChunks.push(
        'INSERT INTO observations (series_id, date, value) VALUES ' +
        chunk.map((p) => `('${kpi.id}','${p.date}',${p.value})`).join(',') +
        ' ON CONFLICT(series_id, date) DO UPDATE SET value=excluded.value;',
      );
    }
    seeded.push(`${kpi.id} (${pts.length} obs)`);
  } catch (e) {
    failed.push(`${kpi.id}: ${e instanceof Error ? e.message : e}`);
  }
}

console.log('seeded:', seeded.join(', ') || 'none');
if (failed.length) console.log('unreachable from this sandbox (will work on Cloudflare):\n  ' + failed.join('\n  '));

if (sqlChunks.length) {
  const dir = mkdtempSync(join(tmpdir(), 'wall-seed-'));
  const file = join(dir, 'seed.sql');
  writeFileSync(file, sqlChunks.join('\n'));
  execFileSync('npx', ['wrangler', 'd1', 'execute', 'the-wall', '--local', '--file', file], { stdio: 'inherit' });
}

// run the real pipeline (compute path) against the seeded observations
const res = await fetch(`${DEV_URL}/api/admin/refresh?token=${encodeURIComponent(ADMIN_TOKEN)}`, { method: 'POST' });
const body = await res.json() as { ok?: boolean; log?: string[] };
console.log(`refresh: HTTP ${res.status}`);
for (const line of body.log ?? []) console.log('  ' + line);
