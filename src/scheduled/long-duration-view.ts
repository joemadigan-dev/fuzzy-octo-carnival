// Assemble the LONG DURATION / TREASURY CONVEXITY view.
//
// Rides the cockpit payload, so the page costs no extra request and this
// module adds no D1 read on the request path. It consumes the same
// seriesMap the cockpit already loaded and the five cards' already-computed
// outputs — nothing is fetched, re-derived or re-scored here.
//
// FRESHNESS IS SHOWN PER SERIES, not once for the block. The four inputs
// have three different publication frequencies (30Y nominal and real are
// daily, the term premium lags a day or two, core CPI is monthly), and a
// single "as of" line across them would either mark the monthly series
// falsely stale or imply the daily ones were fresher than they are. Each
// row carries its own date, age and limit, taken from the same registry
// the rest of the Wall uses.

import type { Point } from '../sources/types.ts';
import { longDurationSetup, type LongDurationResult, type MacroInputs } from '../scoring/long-duration.ts';
import { stripPayoff, STRIP, type Payoff } from '../compute/duration.ts';
import { scenarioMap, type Scenario } from '../scoring/duration-scenarios.ts';
import { kpiById, defaultStaleDays } from '../registry/kpis.ts';
import { latest } from '../scoring/common.ts';
import type { Env } from './index.ts';

/** One input's provenance, rendered under the mini-panels. */
export interface SourceRow {
  id: string;
  label: string;
  source: string;
  freq: string;
  value: number | null;
  asOf: string | null;
  ageDays: number | null;
  staleAfterDays: number;
  status: 'ok' | 'stale' | 'missing';
}

export interface LongDurationView extends LongDurationResult {
  computedAt: string;
  /** Null when there is no proxy yield — never a fabricated table. */
  payoff: Payoff | null;
  scenarios: Scenario[];
  sources: SourceRow[];
  security: {
    cusip: string; maturity: string; coupon: number; label: string;
    /** Stated on screen every time, next to the numbers it qualifies. */
    pricingNote: string;
  };
}

/** The series whose provenance is shown. Ordered as the panels are. */
const SHOWN = ['us30y', 'us30y_real', 'term_premium', 'be30', 'core_cpi', 'wti'];

function sourceRows(m: Map<string, Point[]>, today: string): SourceRow[] {
  const out: SourceRow[] = [];
  for (const id of SHOWN) {
    const def = kpiById.get(id);
    if (!def) continue;
    const pts = m.get(id);
    const l = latest(pts);
    const limit = defaultStaleDays(def);
    const ageDays = l
      ? Math.floor((Date.parse(today + 'T00:00:00Z') - Date.parse(l.date + 'T00:00:00Z')) / 86400000)
      : null;
    out.push({
      id, label: def.label,
      source: def.source ?? 'derived',
      freq: def.freq ?? 'daily',
      value: l?.value ?? null,
      asOf: l?.date ?? null,
      ageDays,
      staleAfterDays: limit,
      // UNKNOWN stays UNKNOWN: a series with no observations is 'missing',
      // which is a different state from 'stale' and must not be shown as
      // an old-but-present reading.
      status: !l ? 'missing' : ageDays !== null && ageDays > limit ? 'stale' : 'ok',
    });
  }
  return out;
}

export function buildLongDuration(
  m: Map<string, Point[]>, nowIso: string, macro: MacroInputs,
): LongDurationView {
  const today = nowIso.slice(0, 10);
  const result = longDurationSetup(m, macro);

  // The proxy. There is no free reliable quote for an individual STRIP
  // CUSIP, so the 30Y constant-maturity yield stands in and every number
  // derived from it is labelled as modelled. If even the proxy is missing,
  // the block shows no table at all rather than a plausible-looking one.
  const proxy = latest(m.get('us30y'));
  const payoff = stripPayoff(proxy?.value ?? null, proxy?.date ?? null);

  return {
    ...result,
    computedAt: nowIso,
    payoff,
    scenarios: scenarioMap(payoff),
    sources: sourceRows(m, today),
    security: {
      cusip: STRIP.cusip,
      maturity: STRIP.maturity,
      coupon: STRIP.coupon,
      label: STRIP.label,
      pricingNote: 'Modelled using the 30Y Treasury yield as proxy — no live price for this CUSIP is used.',
    },
  };
}

/** Persist the day's reading. One upsert, same shape as cockpit_history. */
export async function saveLongDuration(
  env: Env, v: LongDurationView, today: string,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO long_duration_history
       (date, computed_at, score, band, macro_regime, confirmation, veto,
        inflation_compat, pillar_valuation, pillar_macro, pillar_inflation,
        us30y, us30y_real, be30, term_premium, low_confidence, coverage, detail)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(date) DO UPDATE SET
       computed_at=excluded.computed_at, score=excluded.score, band=excluded.band,
       macro_regime=excluded.macro_regime, confirmation=excluded.confirmation,
       veto=excluded.veto, inflation_compat=excluded.inflation_compat,
       pillar_valuation=excluded.pillar_valuation, pillar_macro=excluded.pillar_macro,
       pillar_inflation=excluded.pillar_inflation, us30y=excluded.us30y,
       us30y_real=excluded.us30y_real, be30=excluded.be30,
       term_premium=excluded.term_premium, low_confidence=excluded.low_confidence,
       coverage=excluded.coverage, detail=excluded.detail`,
  ).bind(
    today, v.computedAt,
    // A withheld score is stored as NULL, not as its numeric value. A
    // LOW DATA CONFIDENCE day must not become a data point in the
    // backtest simply because the arithmetic happened to produce a number.
    v.lowDataConfidence ? null : v.score.score,
    v.lowDataConfidence ? null : v.band,
    v.regime, v.confirmation.state, v.veto.state,
    v.inflationCompatibility,
    v.pillars.valuation, v.pillars.macro, v.pillars.inflation,
    v.valuation.nominal?.value ?? null,
    v.valuation.real?.value ?? null,
    v.inflation.breakeven,
    v.valuation.termPremium?.value ?? null,
    v.lowDataConfidence ? 1 : 0,
    v.score.coverage,
    JSON.stringify(v),
  ).run();
}
