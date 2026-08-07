# THE WALL

A public, single-screen wall of live macro KPIs on Cloudflare Workers + D1.
Dense tiles — big number, green/red directional state, inline sparkline —
grouped into labelled clusters, with THE BAROMETER: a transparent,
backtested, two-layer regime signal. Runs permanently on the Cloudflare
free tier.

**Clusters (53 tiles):** The Four Bodies (oil/gold/dollar/rates) · Credit
stress · Funding & liquidity · Sentiment & positioning · Trend, breadth &
rotation · Thesis trackers (dated Hunter forecasts, visually attributed as
forecasts, never confusable with market data).

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
                                       # AND unlocks the decision journal
# optional alert delivery:
npx wrangler secret put ALERT_WEBHOOK_URL   # Slack/Discord/any JSON POST endpoint
npx wrangler secret put RESEND_API_KEY      # or email, via Resend's free tier
npx wrangler secret put ALERT_EMAIL_TO
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

## THE BAROMETER

Two readings, displayed together, **never summed**:

- **PRESSURE** — is stress arriving now? Credit, funding, volatility
  structure, the Four Bodies. Falling pressure = deteriorating conditions.
  Regimes off a real barometer face: `SET FAIR / FAIR / CHANGE /
  UNSETTLED / STORM`.
- **ALTITUDE** — how far is there to fall? Sentiment, trend extension,
  leverage/valuation, breadth. High altitude is a state, not an order —
  melt-ups end *at* maximum altitude. Regimes: `LOW / MODERATE / HIGH /
  EXTREME`.

Weights apply to **sub-indices**, not raw inputs (`src/registry/signal.ts`);
each sub-index is built from its members' z-scores (membership, sign, and
within-sub weight live on the KPI via `subIndex`/`subSign`/`subWeight`),
then itself z-normalised before entering the layer — so no series can
dominate through duplication. The Phase 1 composite had 65% of its weight
touching gold or oil; the Four Bodies now carry 15% of one layer.

- z windows: 2y / 5y (toggleable), scaled to each series' native frequency.
- 3-session hysteresis on every regime flip.
- **Divergence** — high altitude with falling pressure, the configuration
  that precedes busts — is flagged in the bezel, shaded on the backtest,
  and logged as episodes.
- The full backtest of BOTH layers renders on-page, including where each
  was wrong.

**Gauge faces** answer "is this high?" without requiring memory: the
current percentile against full history, the historical distribution drawn
behind the needle, fixed reference marks (Sep 2008 / Mar 2020 / Sep 2022 /
the last 1-year peak), named zone arcs, and the high/low range over the
selected timeframe. Pressure zones are solid, Altitude zones hatched — the
two faces must never be mistaken for each other. A single readout line
beneath both names the current configuration and how long any divergence
has held.

**Diagnostics (on-page, load-bearing):** the pairwise correlation matrix
of every z-scored input (pairs |ρ| ≥ 0.7 flagged in red) and a
leave-one-out table — the full regime history recomputed without each
input, showing the % of days the history changes. Near-zero means the
input is decorative and the weights are lying about what drives the
signal.

## Colour semantics

**Tile colour is the tile's contribution to THE BAROMETER.** Every KPI
declares `stressSign: +1 | -1` — whether a rising value pushes the system
toward storm — and the tile colours from it. Green means the move is
pushing toward benign, red toward storm. A tile can never be green while
making the composite worse.

**The frame is systemic conditions, not portfolio P&L.** Green means the
financial system is in better shape; it deliberately does not account for
how anyone is positioned. Someone positioned for a bust would find a red
wall encouraging, and the wall does not do that inversion for them — the
moment it colours by desired outcome it stops reporting on the world. A
header line states this on the page.

Every sign carries a one-line `signRationale` in the registry, surfaced on
tile hover, written when the decision was made. Correlation tiles are
signed on *deviation from normal*, not level. Moves smaller than 0.1σ of
the series' own daily move render neutral grey rather than a weak tint.

## Accountability

- **Alerts** (`/api/alerts`, logged on-page): regime changes on either
  gauge, divergence opening/closing, any signal input crossing its 95th or
  5th percentile, the Response Gap breaching 2.0z, and thesis levels being
  hit (IGV's H&S state, any target crossing). Rate limiting is structural
  — the alerts table's primary key is `(date, kind, key)`, so at most one
  alert per state per day can exist. Each alert says what changed, what
  drove it, and what it was before. Delivery is webhook and/or email if
  configured (`wrangler secret put ALERT_WEBHOOK_URL` / `RESEND_API_KEY` +
  `ALERT_EMAIL_TO`); with neither set, alerts still land in the table and
  render on the page — never silently dropped.
- **Historical analogues**: nearest-neighbour search on today's z-score
  vector across all history (cosine similarity, ≥70% dimension overlap,
  candidates ≥6 months old and ≥60 days apart). The five closest dates are
  shown with what the S&P did over the following 1/3/6/12 months —
  **every outcome individually plus the spread, never the average**. Five
  non-independent episodes have no meaningful mean, and the honest finding
  is usually that similar conditions preceded wildly different outcomes.
- **The decision journal** (`/journal.html`, token-gated, `noindex`):
  dated entries with free text, stance, action, and conviction 1–5. Every
  entry snapshots the full wall state at write time — both gauges, every
  input reading, the active regimes. The cron fills in what actually
  happened at +1/+3/+6 months for the S&P and any instrument named in the
  entry, then scores **calibration**: stated conviction against realised
  3-month accuracy. That table is the highest-value output here — it says
  whether your reading of this instrument is any good, which no amount of
  additional KPIs can answer.

## Source caveats (verified, honest maximums)

- **ICE BofA spreads on FRED** (HY/CCC/BB/IG OAS) are licensed as a rolling
  ~3-year window — deeper history is not freely available anywhere, so the
  credit backtest starts 2023 and accumulates from here. Pre-2023 Pressure
  history rests on the other 65% of layer weight (coverage renormalises).
- **AAII and CBOE endpoints hard-block non-browser clients** — per the
  no-stub rule, CNN Fear & Greed stands in for the survey read and its
  `put_call_options` series carries the real CBOE-derived put/call data
  (~1y of history per fetch; the wall accumulates the rest).
- **NAAIM** is scraped from the chart JSON embedded in naaim.org's own
  page, which lags the live survey by weeks — the tile shows STALE with
  its as-of date rather than pretending. Bear-capitulation inherits that
  honesty.
- **stooq blocks Cloudflare egress IPs** — gold arrives via the declared
  yahoo fallback (GC=F). yahoo's `^VIX3M` history has holes, so VIX3M is
  FRED `VXVCLS` primary with yahoo as fallback.

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
