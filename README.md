# THE WALL

A public, single-screen wall of live macro KPIs on Cloudflare Workers + D1.
Dense tiles — big number, green/red directional state, inline sparkline —
grouped into labelled clusters, with a transparent, backtested composite
regime signal. Runs permanently on the Cloudflare free tier.

**Phase 1 — "The Four Bodies":** WTI, gold, broad dollar, 10Y nominal, 10Y
real, plus three derived tiles (gold/oil ratio, gold↔real-yield 60d
correlation, WTI↔DXY 60d correlation).

## Architecture in one paragraph

All computation happens in the **cron job**; the request path does **zero
computation** (free Workers get ~10ms CPU/request — enough to read a row,
not to compute correlations). Hourly, one scheduled Worker fetches every
registered series, upserts observations into D1, computes derived series,
z-scores, the composite regime (with hysteresis + full backtest), and writes
finished display-ready rows. `GET /api/wall` is a single indexed read,
edge-cached 60s. The client polls it every 60s and diffs. No sockets — the
underlying data is daily; a socket would be theatre.

```
/src/worker      request handler + API (reads only)
/src/scheduled   cron job: fetch → compute → write
/src/sources     DataSource implementations (fred, stooq, yahoo)
/src/registry    kpis.ts (THE config file) + signal.ts (weights/thresholds)
/src/compute     stats, derived metrics, wall state, composite signal
/public          static frontend (vanilla JS + hand-rolled SVG sparklines + uPlot)
/migrations      D1 schema
/scripts         local-backfill harness for proxied sandboxes
```

One deliberate deviation from the original schema sketch: there is no
`series` table. KPI metadata lives only in `src/registry/kpis.ts`, so adding
a KPI is exactly one config object and zero SQL.

## Setup

### 1. Prerequisites

- Node 18+, `npm install`
- A Cloudflare account (free) and `npx wrangler login`
- A FRED API key — free and instant: https://fred.stlouisfed.org/docs/api/api_key.html
  (optional: without one, the FRED source falls back to the keyless
  `fredgraph.csv` endpoint — same real data — but the keyed API is the
  supported path)

### 2. Create the database

```sh
npx wrangler d1 create the-wall
```

Paste the printed `database_id` into `wrangler.toml`, then migrate:

```sh
npm run migrate:remote        # or migrate:local for dev
```

### 3. Secrets

```sh
npx wrangler secret put FRED_API_KEY   # the FRED key
npx wrangler secret put ADMIN_TOKEN    # any random string; guards /api/admin/refresh
```

For local dev: `cp .dev.vars.example .dev.vars` and fill it in
(`.dev.vars` is gitignored — never commit keys; keys never reach the
browser, all provider calls originate in the Worker).

### 4. Deploy

```sh
npx wrangler deploy
```

### 5. First-run backfill

The first pipeline run against an empty database automatically backfills
5+ years of history per series (from 2015-01-01) — sparklines, z-scores and
the backtest need it. Trigger it immediately rather than waiting for cron:

```sh
curl -X POST "https://<your-worker>.workers.dev/api/admin/refresh?token=<ADMIN_TOKEN>"
```

Backfill is idempotent and re-runnable: every write is an upsert keyed on
`(series_id, date)`, each run re-covers the trailing 45 days, and a series
with suspiciously few rows is re-backfilled in full. Missed cron runs
(free-tier crons do not retry) self-heal on the next run.

## Local dev

```sh
npm run migrate:local
npm run dev                 # wrangler dev --test-scheduled on :8787
curl "http://localhost:8787/__scheduled?cron=7+*+*+*+*"   # trigger the cron
```

In a sandbox whose egress goes through an HTTPS proxy, workerd's fetch may
not reach providers. `npm run backfill:local` fetches the same real data via
curl (proxy-aware), seeds local D1 using the production parsers, then runs
the real compute pipeline through `/api/admin/refresh`. No mock data.

## How to add a KPI

Add **one object** to `KPIS` in `src/registry/kpis.ts`. Nothing else.

```ts
{
  id: 'hy_oas',
  label: 'HY OAS',
  cluster: 'credit_stress',      // add the cluster to CLUSTERS if it's new
  unit: 'bp',
  decimals: 0,
  direction: 'down_is_good',     // spreads widening = red
  refresh: 'daily',
  source: 'fred',
  seriesId: 'BAMLH0A0HYM2',
}
```

Derived KPIs set `derive` instead of `source`/`seriesId`:

```ts
derive: { type: 'rolling_corr', a: 'gold', b: 'us10y_real', window: 60 }
// or   { type: 'ratio', num: 'gold', den: 'wti' }
```

The next cron run backfills it, computes its display state, and the tile
appears. Optional fields: `fallback` (second real source tried when the
primary fails), `showPct: false` (hide %-change — correlations, spreads),
`staleAfterDays`, `unitPrefix`.

Direction semantics are three-mode by design (`up_is_good`,
`down_is_good`, `neutral`) — a spiking VIX rendered green would mislead at
exactly the moment the wall matters most. Direction is also encoded
redundantly (▲/▼ glyph + explicit sign), never colour alone.

## How to add a data source

1. Create `src/sources/<name>.ts` implementing `DataSource`:
   `fetchSeries(seriesId, {from, to}, env) -> Point[]` (`{date, value}`,
   ISO dates, ascending).
2. Register it in `src/sources/index.ts` and add its id to `SourceId` in
   the registry.

That's all — KPIs reference sources by id; fetch logic never changes when
KPIs are added.

## The composite signal

A **regime state, not an order**: `RISK-ON / NEUTRAL / CAUTION / STRESS`.

- Every input is z-scored against its own trailing distribution (2y / 5y
  windows, toggleable in the UI); `score = Σ weight·sign·z`.
- Weights, signs, thresholds and hysteresis live in
  `src/registry/signal.ts` — config, not code. Tune freely.
- A threshold breach must persist 3 consecutive sessions before the state
  flips (hysteresis).
- Clicking the signal reveals every input, its z, weight and contribution;
  the full backtest since 2015 (it flagged March 2020 as STRESS by Mar 17;
  2022 reads NEUTRAL/CAUTION — shown as-is, flattering or not); and an
  append-only regime change log with the causing inputs.

## Operations notes

- **One cron trigger** (`7 * * * *`) handles all series — free tier allows
  5/account; don't spend them one-per-source.
- **Staleness is loud.** A tile whose data exceeds its freshness allowance
  renders dashed/muted with STALE badge and the last-good date. A dead
  provider shows its error on the tile. Numbers are never silently stale.
- **Endpoint protection:** `/api/wall` is edge-cached (s-maxage 60) so any
  number of viewers costs ~1 origin hit/min, plus a best-effort per-IP
  token bucket. For hard guarantees add a Cloudflare rate-limiting rule.
- Verify current free-tier limits at deploy time — they move:
  https://developers.cloudflare.com/workers/platform/limits/
