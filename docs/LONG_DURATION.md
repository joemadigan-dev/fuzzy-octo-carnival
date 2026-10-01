# LONG DURATION / TREASURY CONVEXITY

Decision support for one narrow question: is the macro, inflation and
Treasury-market setup becoming attractive for a concentrated long-duration
US Treasury position, with the 2056 principal STRIP as the reference
security.

Reference security: **UST principal STRIP, CUSIP 912803HS5, maturity
15 February 2056, 0% coupon**, ~29.4 years to run as at 2026-09-30,
modified duration ~28.6.

No trading functionality. No broker integration. No order, position or
buy/sell instruction is produced anywhere in this module.

---

## THE HEADLINE FINDING, BEFORE THE METHODOLOGY

**The score as specified does not predict long-duration Treasury returns.
Over the history available it is mildly INVERSELY related to them.** This
section is first because a reader who stops after one section should stop
after this one.

Spearman rank correlation between the score and the subsequent return of a
~29-year zero:

| variant | horizon | n | correlation |
|---|---|---|---|
| Full (DFII30, 2011+) | 1 year | 179 | **+0.01** |
| Full | 2 years | 171 | **+0.05** |
| Reduced (DLTIIT, 2001+) | 1 year | 301 | **−0.07** |
| Reduced | 2 years | 293 | **−0.07** |

Percentile windows start 2000-01-01, matching what production stores. An
earlier version of this table used 1980+ history and is superseded — see
*A correction to this document* below.

By band, 1-year forward return of the reference instrument:

| band | n | mean | median | % positive |
|---|---|---|---|---|
| 0.0–1.9 unfavourable / weak | 143 | **+3.6%** | +3.8% | 54% |
| 2.0–2.9 watch | 30 | **−5.7%** | −7.7% | 23% |
| 3.0–3.9 setup building | 6 | **−3.0%** | −1.1% | 33% |
| 4.0–4.4 attractive | **0** | — | — | — |
| 4.5–5.0 exceptional | **0** | — | — | — |

Two things follow and both are load-bearing:

1. **The ranking is backwards.** The lowest band produced the best average
   return and the highest observed band the worst. This is not noise at the
   margin; it is the whole ordering.
2. **The two most favourable bands have never been observed.** In 25 years
   of history the score never exceeded 3.6. `ATTRACTIVE` and `EXCEPTIONAL`
   are untested vocabulary, and the UI says so.

### Why — two structural causes

**(a) The valuation pillar contributes almost nothing, so the score is
driven by macro and inflation, which fire after the rally rather than
before it.** The brief's weights are 40/35/25, and 35 + 25 = 60% = 3.0 of
5. So a maximal macro-plus-inflation reading reaches `SETUP BUILDING`
with the valuation pillar at **zero** — that is, when long yields are at
their most expensive. That is exactly what happened:

| date | score | valuation | macro | inflation | forward 1y |
|---|---|---|---|---|---|
| 2020-03-02 | 3.0 | **0.00** | 1.75 | 1.25 | −0.8% |
| 2020-04-01 | 3.0 | **0.00** | 1.75 | 1.25 | **−10.5%** |
| 2001-10-01 | 3.0 | **0.00** | 1.75 | 1.25 | −6.7% |
| 2001-11-01 | 2.8 | **0.00** | 1.75 | 1.05 | **−16.9%** |

And the readings that actually preceded the large rallies were the *low*
ones — 2019-09 to 2020-02 scored 0.3 to 1.9 and returned +14% to +36%;
2002-04 scored 1.2 and returned +30.2%.

This is "recession = buy bonds" re-entering through the back door. The
inflation gate works exactly as designed — it multiplies the macro pillar
and it zeroed it correctly in every stagflationary month — but additivity
across pillars means recession evidence alone still reaches a
favourable-sounding band. **The gate stops stagflation. It does not stop
buying a rally that has already happened.**

**(b) The veto's fourth condition collides with the valuation pillar's
best readings.** A high 30Y real-yield percentile is usually *reached by
rising*, and "30Y real yield ≥ +40bp over three months" is one of the four
stagflation-veto conditions. So maximal valuation and a quiet veto rarely
coexist, which is what actually caps the achievable score — not the
percentile windows (see the correction below).

Production on 2026-10-01 is the collision in its purest form: the valuation
pillar at **2.00 of 2.00** — 30Y real at the **100th percentile** of its
16-year history, 30Y nominal at the **94th** of 27 years, term premium at
the **85th** — and the veto **ACTIVE**, one of its two triggers being the
30Y real yield's own +56bp over three months. The score is capped at 2.5
`WATCH` by the very move that made the valuation attractive.

That may well be correct behaviour: it is the module declining to call an
asset attractive while it is still getting cheaper, which is the
`NOT CONFIRMED` idea expressed through the veto instead. But it means
`ATTRACTIVE` and `EXCEPTIONAL` require long yields to be at an extreme
**and** to have stopped rising **and** a recession to have begun **and**
inflation to be falling — a conjunction that did not occur once in 25
years. The bands may be unreachable by construction rather than by
accident.

### A correction to this document

An earlier version of this section claimed the valuation pillar was
"nearly unreachable" because percentiles over regime-spanning histories
diluted it, citing 0.89 of 2.00 in 2024. **That was an artefact of the
backtest harness, not a property of the system.** The script fetched DGS30
from 1980 and the term premium from 1990, while production stores from
`BACKFILL_START = 2000-01-01` and computes its percentiles on that. Against
a distribution containing the 10%+ yields of the early eighties a 5.59%
30Y ranks near the 20th percentile; against 2000+ it is at the 94th.

So the harness was testing a weaker instrument than the one that shipped,
and every score it produced was more macro-driven than production's would
have been. The script now matches the production window. **The headline
finding survived the correction** — correlations moved from −0.13…+0.05 to
−0.07…+0.05, the ordering is still inverted, and the top two bands are
still unobserved — but the stated cause was wrong and is replaced above.

### What has NOT been done about it

### What has NOT been done about it

No threshold has been tuned. The brief is explicit — *"Do not alter
thresholds through aggressive curve fitting"* — and a score that can be
made to look good on four episodes by adjusting five numbers would tell us
nothing. `config/thresholds.json` is read by the backtest and never
written by it.

What has been done is disclosure: the module carries its own validation
result in the payload, the UI labels the untested bands, and this document
leads with the finding.

### The minimal structural change, for a decision rather than an assumption

The evidence points at one change, and it is a change to the brief's own
weighting rather than to a threshold, so it is **not** implemented:

> Make the valuation pillar necessary rather than merely contributory —
> multiply the macro pillar by valuation coverage the way it is already
> multiplied by inflation compatibility, or cap the total at (say) 2.5
> whenever the valuation pillar is below a third of its own range.

Either would have suppressed every false positive in the table above,
because all of them had `valuation = 0.00`. Neither is a fitted parameter:
the claim is structural — *the setup cannot be attractive when the asset
is expensive* — and it follows from the brief's own framing. It needs a
decision, because it changes a weighting the brief specified.

---

## Score construction

Three pillars, 40 / 35 / 25, summing to 5.0. Every component is worth at
most its stated cap, carries the sentence that explains it and the number
it was computed from, and is rendered verbatim by the UI. A component with
no data contributes 0 **and** reports `unknown: true`, so "we cannot see
this" stays visibly different from "this is benign".

### A. Long-duration valuation — 2.00 (40%)

| component | cap | rule |
|---|---|---|
| 30Y real yield percentile | 0.80 | ≥90th → full, ≥75th → 0.75×, ≥50th → 0.375×, ≥25th → 0.125×, else 0 |
| 30Y nominal percentile | 0.70 | same bands |
| Term premium percentile | 0.50 | ≥80th → full, ≥60th → 0.6×, else 0 |

**Direction matters and overrides level.** If the 60-day change in the term
premium is ≥1.5σ of its own history, that component is capped at 0.20 and
emits its own contradicting line. A term premium that is high *because the
market is progressively refusing to fund the long end* is a reason for
caution, not an entry level. The brief asked for this explicitly and it is
the one place the module reads a "cheap" input as a warning.

Every percentile is reported with its sample size **and** its first
observation date. A 96th percentile of DFII30 is a 96th percentile of
sixteen years, and the payload never lets that be read as fifty.

### B. Macro turn / recession compatibility — 1.75 (35%)

Consumes the existing cards' **outputs**. No recession model is rebuilt and
no new growth series is fetched.

| component | cap | source |
|---|---|---|
| Bust Risk | 0.60 | `bustRisk()` score: ≥3.5 full, ≥2.5 0.75×, ≥1.5 0.42× |
| Credit Canary | 0.50 | `creditCanary()` score: ≥2.5 full, ≥1.5 0.7×, >0 0.4× |
| Regime | 0.35 | phase matches BUST/DEFLATION/CONTRACTION → full; Bust Onset ≥1/2 → 0.57× |
| Rates leg / front end | 0.30 | `RATES COLLAPSING` → full; 2Y ≤ −20bp/20d → 0.5× |

**Then the whole pillar is multiplied by inflation compatibility (1, 0.5
or 0)** derived from pillar C's own total. This is the line that stops
`recession → long duration`:

- C ≥ 0.90 → ×1.0
- C ≥ 0.45 → ×0.5
- C < 0.45 → **×0.0**

At ×0 the macro pillar contributes nothing at all, and the amount withheld
is printed in the evidence list rather than silently dropped. Growth
deterioration alongside accelerating inflation is not a smaller signal; it
is not a signal.

### C. Inflation compatibility — 1.25 (25%)

The veto layer. One question: *could the Fed and the long end plausibly
respond to weaker growth with lower rates?*

| component | cap | rule |
|---|---|---|
| 30Y breakeven | 0.50 | 3m ≤ −10bp → full; ≥ +20bp → **0**; else 0.4–0.6× |
| Core CPI trend | 0.45 | 3m-annualised vs 12m: falling → full; rising **and** ≥3% → **0** |
| Energy (WTI) | 0.30 | 3m ≤ 0% → full; ≥ +25% → **0**; else 0.5× |

`core_hot_pct` is an absolute 3% rather than a percentile, and that is a
deliberate exception. Core CPI's own distribution since 1980 is dominated
by the early-eighties disinflation, a regime that will not recur; 3% is the
level at which the long end stops being able to rally on growth weakness,
which is the actual question.

### Stagflation veto

Counts four conditions, all on percentiles or z-scores except the core-CPI
level noted above:

1. 30Y breakeven ≥ +25bp/3m **and** ≥75th percentile
2. Core CPI 3m-annualised > 12m **and** ≥ 3.0%
3. WTI ≥ +25%/3m
4. 30Y real yield ≥ +40bp/3m — long real yields still rising aggressively

0 → `OFF`, 1 → `WATCH`, ≥2 → `ACTIVE`. `WATCH` caps the total at **4.4**,
so a recession signal alone can never read `EXCEPTIONAL`. `ACTIVE` caps it
at **2.5**.

The cap is applied by appending an explicit negative component, not by
rewriting the number, so the arithmetic on screen still adds up. A unit
test asserts this.

### Macro regime

Seven states. **Fiscal / term-premium stress is tested first**, because it
is the configuration that looks most like an opportunity and is not one:
long real yields rising with the term premium at an extreme while inflation
expectations are *not* accelerating — the market demanding more
compensation to hold duration, which raises long yields with no inflation
cause. The remaining states fall out of growth direction × inflation
direction. Coverage below 0.60 forces `Indeterminate`.

### Market confirmation

Deliberately **not** folded into the score. Five tests — 30Y below its
20-day and 60-day averages, 30Y real rolling over, 2Y rolling over,
liquidity/rates turning supportive. 0–1 `Not confirmed`, 2–3 `Partial`,
4–5 `Confirmed`.

`5.0 / NOT CONFIRMED` is a coherent and common reading: historically cheap
and still getting cheaper. Collapsing the two into one number would destroy
the only information that distinguishes a cheap asset from a turning one.
A test with no data reports `null`, never a silent pass.

---

## What is driving the long-end?

Splits the 30Y nominal move into its real and breakeven legs over 20 and 60
sessions. Tags: `Inflation-led sell-off`, `Real-yield / term-premium-led
sell-off`, `Mixed`, `Growth-scare rally`, `Disinflation rally`, `Quiet`.
Dominance threshold 70%; below 10bp the move is `Quiet` and is not
attributed at all.

**On the passive-flow mechanism.** Michael Green's argument is that passive
bond-fund mechanics amplify long-end moves. Yield data cannot see flow, so
no output here says "passive" or "mechanical". The strongest honest phrase
the module will print is:

> *Consistent with a non-inflation / term-premium driven sell-off.*

That is a statement about the decomposition. It leaves the mechanism an
open question instead of asserting one the data cannot support. A unit test
asserts that the words "passive", "mechanical", "forced selling" and
"index fund" never appear in any decomposition output.

---

## The STRIP block

Semi-annual compounding, Treasury convention:

```
P0 = 100 / (1 + y/2)^(2T)
P1 = 100 / (1 + (y + Δy)/2)^(2(T−1))
return = P1/P0 − 1
```

Priced one year forward on a maturity shortened by one year, so the 0bp row
is **not** 0% — it is approximately the yield, earned as roll-down. That is
the real holding-period return of a zero when nothing happens, and hiding
it would understate the base case. At 5.56% and 29.4 years: 0bp → +5.6%,
−100bp → +39.4%, +150bp → −28%.

**No price for CUSIP 912803HS5 is fetched, stored or displayed.** There is
no free reliable public quote for an individual STRIP CUSIP. Every figure
is modelled from DGS30 as a proxy and labelled *"Modelled using the 30Y
Treasury yield as proxy"* beside the numbers, not in a footnote. With no
proxy yield the table is **absent**, not approximated — a fabricated price
for a named CUSIP would be the worst single thing this dashboard could do,
because it would look exactly like a real one.

The ±150bp rows are shown at equal weight. At +150bp the reference
instrument loses about 28% and the dollar column says so.

### 2027 recession map

Four paths, priced live off the current proxy yield. The adverse case is
first, because a reader who has already decided a recession is coming will
skip it.

| scenario | assumed 30Y | implication |
|---|---|---|
| Stagflation / fiscal stress | +75bp | Negative |
| Mild slowdown | −50bp | Moderately positive |
| Disinflationary recession | −125bp | Strongly positive |
| Deep recession / flight to quality | −200bp | Highly convex upside |

The yield moves are **stated assumptions**, not forecasts. **No scenario
carries a probability** — we have no basis for one, and an invented number
would be the most quoted thing on the page. A unit test asserts no
likelihood language and no `probability` field.

Three of the four involve a recession and they do not share a sign. That is
the panel's only argument.

---

## Data

| id | series | source | history | notes |
|---|---|---|---|---|
| `us30y` | DGS30 | FRED | 1980– (stored from 2000) | continuous through the 2002–06 auction suspension |
| `us30y_real` | DFII30 | FRED | **2010-02-22–** | 30Y TIPS were not issued 2001–2010 |
| `us30y_real_long` | DLTIIT | FRED | 2000– | hidden; **backtest only**; TIPS 10y+ *average* maturity, not 30Y |
| `term_premium` | THREEFYTP10 | FRED | 1990– | substitution note below; **10**-day staleness limit |
| `core_cpi` | CPILFESL | FRED | monthly | **75**-day staleness limit — see below |
| `be30` | derived | — | — | `us30y − us30y_real`, forward-fill capped at 5 days |
| `real30_impulse` | derived | — | — | 30Y real vs its own 18-month trough |
| `wti` | DCOILWTICO | FRED | existing | reused, not re-fetched |

### Two substitutions, named rather than buried

**The ACM term premium is not available.** The brief asked to reuse an
existing ACM implementation. There was none in this codebase, and ACM is
published by the New York Fed and is *not* on FRED — `ACMTP10` 404s. What
is used is `THREEFYTP10`, the Federal Reserve Board's own estimate, from a
different model **and at a 10-year rather than 30-year maturity**. The UI
label reads `10Y TERM PREMIUM (FRB)` for exactly that reason. Nothing was
duplicated because nothing existed.

**There is no daily 30Y breakeven on FRED.** `T30YIEM` is monthly, so the
breakeven is derived from the two daily legs. Cross-checked on 2026-09-30:
derived **2.28%** against `T30YIEM`'s official **2.25%** for the latest
common month.

### Freshness

Every series inherits the Wall's existing framework — `defaultStaleDays()`
and `systemHealth()` iterate the registry, so no wiring was needed. The
SOURCES table shows each input's latest value, observation date, age,
staleness limit and status per series, not once for the block: the inputs
have three different publication frequencies and one shared "as of" line
would either mark the monthly series falsely stale or imply the daily ones
were fresher than they are.

**Two staleness limits were wrong on first contact with production and are
fixed.** `core_cpi` read stale at 61 days on 2026-10-01 while behaving
perfectly: CPILFESL is dated at the START of the month it describes and
published around the 10th–15th of the following month, so two lags compound
and the newest observation is legitimately up to ~75 days old. The 45-day
monthly default is the same trap the quarterly default documents, one step
down, and the brief is explicit that a monthly series must not read stale
merely for being monthly. `term_premium` publishes daily values with a ~4
business-day lag — newest 2026-09-25 on 2026-10-01 — so the 6-day daily
default would have marked it stale permanently. Now 75 and 10 days
respectively; a genuinely missed release still trips both.

`missing` and `stale` are different statuses. A series with no observations
reads `UNKNOWN`, never an old-but-present number. Coverage below 0.60
produces **LOW DATA CONFIDENCE**, and in that state the score itself is
suppressed — both on screen and in the database, where the day is stored
with `score = NULL` rather than with whatever number the arithmetic
happened to produce. A low-confidence day must not become a data point in a
future backtest.

---

## Architecture

- **No existing behaviour changed.** The five cockpit cards keep their
  scoring and their positions. No sixth card. `scoring/index.ts`
  composites, all five card scorers, `health.ts` and `compute/barometer.ts`
  are untouched.
- **No new KPI carries a `subIndex`**, which keeps all of this out of the
  barometer. That is both the brief's requirement and a CPU necessity:
  `leave_one_out` costs one full re-derivation per input, and it is the
  stage that has exceeded the Worker CPU limit before.
- The view rides the cockpit payload, so the page costs no extra request
  and the module adds no D1 read on the request path.
- Built inside its own `try`, like the AI capital block, so a fault in the
  newest module cannot take down the five cards that worked before it.
- Persistence mirrors `cockpit_history`: one upsert per day into
  `long_duration_history`, states as their own columns so the history is
  queryable without parsing every blob.

## Limitations

1. **The score does not predict returns.** See the first section. It should
   be read as a description of the current configuration, not as a forecast,
   and the two most favourable bands have never been observed.
2. **The macro pillar cannot be backtested.** It consumes Bust Risk, the
   Credit Canary, the phase model and the liquidity card, none of which can
   be reconstructed for 2001 or 2008 from the history the Wall holds. The
   backtest substitutes a FRED-only proxy (curve inversion, 2Y rolling
   over, unemployment off its 12-month low), labelled as such in every
   table. It is **not** the production pillar.
3. **2001 and 2008 cannot be tested against the real score at all**, because
   there is no 30Y real yield before 2010. The reduced variant uses DLTIIT,
   a different instrument at a different maturity, and its results are
   reported separately and never averaged with the full score's.
4. Live percentiles are computed on **stored** history from 2000, not the
   full FRED window. Each percentile carries its own `n` and first date.
5. The term premium is 10-year and from a different model than the one the
   brief named.
6. STRIP maturity is measured on a 365.25-day year, not an exact Treasury
   day count. Worth about a day of maturity — less than the width of the
   rendered number.
7. Monthly backtest sampling. Daily sampling would multiply the apparent
   sample size ~21× without adding independent evidence.

## Files

```
src/compute/duration.ts              zero-coupon maths, STRIP payoff
src/scoring/long-duration.ts         pillars, veto, regime, confirmation, decomposition
src/scoring/duration-scenarios.ts    2027 recession map
src/scheduled/long-duration-view.ts  assembly, source rows, persistence
migrations/0007_long_duration.sql    long_duration_history
config/thresholds.json               long_duration section
tests/duration.test.ts               25 tests
tests/long-duration.test.ts          29 tests
scripts/backtest-long-duration.ts    historical validation (read-only on thresholds)
docs/LONG_DURATION_BACKTEST.txt      full backtest output
```
