# V1 BASELINE — Melt-Up & Doomsday Tracker

Frozen reference for Version 1. Anything below is what V1 *is*; anything
not below is not in V1.

**Live:** https://the-wall.joemadigan.workers.dev/tracker
**Companion:** https://the-wall.joemadigan.workers.dev/ (Financial
Conditions Barometer — shares the same data layer and cron)

> For informational and research purposes only. Not financial advice. The
> regime and every score are classifications generated from the
> indicators shown, not objective facts about the world.

---

## 1. Architecture

One Cloudflare Worker, one D1 database, one hourly cron trigger. No
second stack, no server, nothing that depends on a laptop being on.

```
cron (7 * * * *)                         request path
  ├ 1. fetch sources → observations        /tracker      static page
  ├ 1b. heavy-path gate                    /api/cockpit  one finished row
  ├ 2. load histories                      /api/wall     wall_state rows
  ├ 3. derive series (trailing window)     /api/barometer
  ├ 4. wall_state + charts                 /api/series/:id
  ├ 5. COCKPIT  ← runs before the barometer
  ├ 6. barometer + disconfirmation
  └ 7. alerts + journal
```

**The request path computes nothing.** Every endpoint is an indexed read
of rows the cron already finished. Free-tier Workers allow ~10ms CPU per
request; this uses a fraction of it.

**The cockpit runs before the barometer.** An isolate killed inside
`computeBarometer` takes everything after it down; the first screen must
not depend on the most expensive stage. This ordering is deliberate and
should not be "tidied".

**Heavy-path gate.** The cron fires hourly but sources publish daily, so
the expensive path (load + derive + cockpit + barometer, ~143k D1 row
reads) runs only when a series actually gained an observation, with a
2-hour minimum gap and an 8-hour floor. `last_heavy` is stamped on
*attempt*, not success, so a failing heavy run cannot retry itself into a
quota wall.

| file | role |
|---|---|
| `config/hunter_targets.json` | every Hunter figure |
| `config/thresholds.json` | every threshold the scores test against |
| `src/registry/kpis.ts` | the KPI registry — adding a series is one object |
| `src/registry/signal.ts` | barometer layers, zones, deadband, persistence |
| `src/scoring/*` | the four cockpit engines, phase model, setup, health, units |
| `src/compute/*` | barometer, derivations, wall state |
| `src/scheduled/*` | the cron pipeline, cockpit persistence, alerts |
| `src/worker/index.ts` | request path only |
| `public/tracker.*` | the cockpit page |
| `tests/*.test.ts` | `npm test` |

---

## 2. Data sources

| source | series | notes |
|---|---|---|
| FRED (API, key) | SP500-family via proxies, DGS10, DGS2, DFF, WALCL, WTREGEN, RRPONTSYD, WRESBAL, SOFR, IORB, BAMLH0A0HYM2, BAMLH0A3HYC, BAMLH0A1HYBB, BAMLC0A0CM, DTWEXBGS, DCOILWTICO, VIXCLS, VXVCLS, DFII10, GDP, NCBEILQ027S, BOGZ1FL663067003Q, delinquency series | keyless CSV fallback; a 5xx does **not** retry keylessly |
| Damodaran (NYU Stern) | implied ERP and its decomposition | `.xls`, parsed with SheetJS, 1904 epoch corrected, cron-only |
| stooq | gold | Yahoo fallback |
| Yahoo Finance | indices, ETFs, silver, GDX, SMH | **market-data proxy, delayed** — labelled as such |
| CNN | Fear & Greed, equity put/call | |
| NAAIM | manager exposure | |

Every indicator carries source, last observation date, frequency and a
FRESH/STALE/ERROR status. A failed fetch shows the last successful value
marked STALE. **No value is ever invented.**

---

## 3. Scores

All 0–5, all built by adding named components, each worth at most 1.
Every card has SHOW WORKING listing all components including zeros and
unavailable ones.

- **Melt-Up** — six-month momentum; acceleration (three-month pace vs
  six-month actual); Hunter-target proximity; credit calm while equities
  run; complacency. Low VIX is not bearish on its own.
- **Credit Canary** — the ladder CCC → BB → broad HY → IG, level and
  rate-of-change weighted equally. Stage is held below CONTAGION while IG
  is calm; the card states ISOLATED or SYSTEMIC.
- **Bust Risk** — split into **vulnerability** (valuation, leverage,
  liquidity) and **onset** (internals, credit), shown as separate bars.
  Vulnerability can sit at maximum for years; onset is what says it has
  started.
- **Liquidity / Rates** — names which leg of
  rates→credit→equities→deflation→collapse→QE the data resembles. QE
  detector fires only past configured magnitudes.
- **Phase model** — seven phases, 3-session persistence, candidate stored
  alongside adopted phase.
- **Market Setup** — one deterministic sentence assembled by clause role.
  Rules-based, reproducible, no model.

### UNKNOWN is not ZERO

A component with no data contributes **0** and reports `unknown`. Scores
are **not renormalised** onto the available components: an incomplete
reading stays on the 0–5 scale, so it is low *and* visibly incomplete
rather than scaled up to look confident. Cards show `EVIDENCE n/m`.

### Unit semantics

`src/scoring/units.ts` declares the storage unit of every series a score
reads; `asPercent` / `asBp` / `asBn` convert by declaration. Scoring an
undeclared series throws. This exists because `eq_gdp` is stored as a
ratio (2.56 = 256%) and was compared against a percent threshold (160),
silently scoring the most stretched market-cap-to-GDP on record as
"within normal range".

---

## 4. Threshold configuration

Everything lives in `config/thresholds.json` and
`config/hunter_targets.json`. **No scoring function hard-codes a number
that belongs in those files.** To change a Hunter target when he
publishes new figures, edit `hunter_targets.json` — nothing else.

Current targets (kept from the barometer, deliberately not the older set
in the original brief): S&P 10,000 · Dow 70,000 · NASDAQ 36,000 ·
Russell 4,000 · Gold 7,000 · Silver 200 · GDX 180 · SMH 800.

### Regime hysteresis

`ZONE_DEADBAND_PCT = 5` percentile points, in `src/registry/signal.ts`.

- **Escalating** to a more severe regime uses the plain zone boundary.
- **De-escalating** requires the reading to fall a further 5 points below
  it, *and* to persist `HYSTERESIS_DAYS` (3) sessions.

Sized against the zone widths (20/30/25/15/10): at most a third of any
zone except the 10-point top zone where it is half, and never enough to
let a de-escalation skip a zone. On 19 years of stored history it cuts
adopted ALTITUDE (5y) changes from 182 to 131. **A deadband of 10 would
equal the whole width of the top zone and is unsafe.**

### Alert dedup

Two mechanisms:
1. `alerts` primary key `(date, kind, key)` — one per condition per day.
2. **Latching** for LEVEL conditions: `alert_on:<kind>:<key>` in `meta`.
   Fires on the false→true edge, silent while it holds, re-armed when it
   clears.
3. Regime alerts compare the adopted regime against `alert_regime:<layer>:<window>`,
   not against a change at the end of a recomputed history.

---

## 5. Health checks

The page carries a GREEN/AMBER/RED chip beside the timestamp; click it
for last successful run, last cockpit computation, last barometer
computation, KPI fresh/stale/failed counts and the latest failed stage.

- **GREEN** — last run completed, all sources fresh.
- **AMBER** — non-critical source stale, partial evidence, isolated stage
  failure, or the last run did not finish.
- **RED** — cockpit never/stale computed, critical data stale
  (`spx, hy_oas, us10y, vix, walcl`), or no completed run for 26h.

Manual checks:

```bash
curl -s https://the-wall.joemadigan.workers.dev/api/cockpit | jq '.health'
curl -s https://the-wall.joemadigan.workers.dev/api/wall    | jq '{lastRun, runLog}'
npx wrangler d1 info the-wall            # rows_read_24h vs the 5M free cap
npx wrangler tail --format json          # barometer.<stage> lines
npm test
```

---

## 6. Known limitations

**Read these before trusting a panel.**

- **Tier credit spreads start 2023-09.** FRED licenses the ICE BofA
  CCC/BB/IG indices on a rolling ~3-year window. The Credit Canary ladder
  **cannot be read through 2008 or 2020**. Broad HY reaches further back.
- **Shiller CAPE is not on FRED.** Valuation uses equity market cap / GDP
  and Damodaran's implied ERP instead. CAPE would need a Shiller
  spreadsheet adapter.
- **Margin debt is a proxy.** `BOGZ1FL663067003Q` is the Z.1
  brokers-and-dealers receivables line, quarterly and in arrears. FINRA's
  own series is not on FRED.
- **`us2y` and `margin_debt` were added 2026-09-19** and have short
  stored histories. Components using them report `EVIDENCE n/m` until
  they fill.
- **"What Changed?" is cold.** `cockpit_history` began 2026-09-19, so
  score- and stage-change detection has little to compare against. It
  improves as history accumulates. Not broken — cold.
- **Yahoo Finance is a delayed proxy**, labelled as such, and is the
  source for index levels and several ETFs.
- **`computeBarometer` has died intermittently** (2026-09-03, 2026-09-19)
  with no diagnosis. Not a CPU ceiling — a successful run uses ~1.9s
  against a 30s limit. Now instrumented per sub-stage via the Workers log
  stream. **Unresolved.** The cockpit is isolated from it.
- **D1 free tier**: 5M row reads and 100k row writes per day. The system
  has hit both. Steady state is now ~3–6 heavy runs/day. Workers Paid
  ($5/mo) removes the ceiling.
- **Percentiles are not probabilities.** The record contains a handful of
  non-independent stress episodes.

---

## 7. Rollback

Deployments are Cloudflare Worker versions; the database is separate and
is **not** rolled back by a redeploy.

```bash
# list versions, newest last
npx wrangler deployments list

# roll back the code
npx wrangler rollback --message "reverting <reason>"

# or redeploy a known-good git tag
git checkout v1.0.0 && npx wrangler deploy
```

**Schema:** migrations are additive (`migrations/0001..0005`). Rolling
code back does not drop tables, so an older Worker simply ignores newer
columns. If a migration must be undone, write a new forward migration
rather than editing an applied one.

**Stuck state worth knowing:**

```bash
# force the next cron onto the heavy path
npx wrangler d1 execute the-wall --remote \
  --command "UPDATE meta SET value='2000-01-01T00:00:00.000Z' WHERE key='last_heavy'"

# re-arm every latched alert
npx wrangler d1 execute the-wall --remote \
  --command "DELETE FROM meta WHERE key LIKE 'alert_on:%'"

# force a derived series to rewrite its full history
npx wrangler d1 execute the-wall --remote \
  --command "DELETE FROM meta WHERE key = 'derived:<id>'"

# re-heal a truncated source history
npx wrangler d1 execute the-wall --remote \
  --command "DELETE FROM meta WHERE key = 'deep:<id>'"
```

---

## 8. Not in V1

The **AI Capital Bubble Monitor** (SEC EDGAR, hyperscaler capex,
CAPEX/OCF, incremental ROIC, construction in progress, AI/data-centre
financing stress) is **V2 and not started**. The panel does not exist
rather than existing empty.

Its purpose will be to *test* the Noble/Chanos proposition, not assume
it: is incremental AI cash generation sufficient to justify incremental
AI capital investment?
