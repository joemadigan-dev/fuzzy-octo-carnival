// WHAT CHANGED? — section 3.
//
// The brief is explicit that this must NOT be a list of the largest
// percentage moves. Rank by importance TO THE MODEL: a score or stage
// changing outranks any price move, a threshold being crossed outranks
// drifting within a band, and a move in an indicator the scores actually
// consume outranks one in an indicator they do not.
//
// Each entry therefore carries an explicit weight and the reason it
// scored, so the ordering can be argued with rather than trusted.

import type { Point } from '../sources/types.ts';
import thresholds from '../../config/thresholds.json' with { type: 'json' };
import { isoDaysAgo, valueOnOrBefore } from '../compute/stats.ts';
import { latest } from './common.ts';

export type Horizon = 'day' | 'week' | 'month';
const DAYS: Record<Horizon, number> = { day: 1, week: 7, month: 30 };

/** Ordered by model importance. The ranking is by CATEGORY first and
 *  magnitude only within a category, which is the whole point: a stage
 *  change outranks any price move however large. */
export type ChangeKind =
  | 'regime'        // adopted regime or phase changed
  | 'stage'         // Credit Canary stage, liquidity regime
  | 'threshold'     // a named critical level was crossed
  | 'score'         // a 0-5 score moved materially
  | 'acceleration'  // rate of change itself changed
  | 'move';         // ordinary market move

export const KIND_WEIGHT: Record<ChangeKind, number> = {
  regime: 100, stage: 90, threshold: 78, score: 62, acceleration: 48, move: 20,
};

export interface Change {
  horizon: Horizon;
  weight: number;       // model importance, higher first
  headline: string;
  detail: string;
  kind: ChangeKind;
}

/** Snapshot of the scores as stored in cockpit_history. */
export interface Snapshot {
  date: string;
  phase: string | null;
  meltup: number | null;
  bust: number | null;
  credit: number | null;
  credit_stage: string | null;
  liquidity_regime: string | null;
}

/** Indicators the scores actually consume, with the weight of a move in them. */
const TRACKED: { id: string; label: string; unit: string; dp: number; weight: number; bp?: boolean }[] = [
  { id: 'hy_oas', label: 'HY OAS', unit: '%', dp: 2, weight: 60, bp: true },
  { id: 'ccc_oas', label: 'CCC & lower OAS', unit: '%', dp: 2, weight: 55, bp: true },
  { id: 'us10y', label: '10Y Treasury', unit: '%', dp: 2, weight: 55, bp: true },
  { id: 'ig_oas', label: 'IG OAS', unit: '%', dp: 2, weight: 50, bp: true },
  { id: 'vix', label: 'VIX', unit: '', dp: 1, weight: 40 },
  { id: 'spx', label: 'S&P 500', unit: '', dp: 0, weight: 35 },
  { id: 'net_liq', label: 'Net liquidity', unit: '$tn', dp: 2, weight: 35 },
  { id: 'walcl', label: 'Fed balance sheet', unit: '$tn', dp: 2, weight: 30 },
  { id: 'gold', label: 'Gold', unit: '$', dp: 0, weight: 25 },
  { id: 'dxy', label: 'USD index', unit: '', dp: 2, weight: 20 },
];

/** Per-horizon move sizes that make an indicator worth mentioning at all. */
const MATERIAL: Record<Horizon, { bp: number; pct: number }> = {
  day: { bp: 10, pct: 1.0 },
  week: { bp: 25, pct: 2.5 },
  month: { bp: 50, pct: 5.0 },
};

export function whatChanged(
  m: Map<string, Point[]>,
  now: Snapshot,
  history: Snapshot[],            // ascending by date, excluding today
): Record<Horizon, Change[]> {
  const out = {} as Record<Horizon, Change[]>;

  for (const horizon of ['day', 'week', 'month'] as Horizon[]) {
    const changes: Change[] = [];
    const cutoff = isoDaysAgo(now.date, DAYS[horizon]);
    // nearest stored snapshot at or before the cutoff
    let prev: Snapshot | null = null;
    for (const s of history) { if (s.date <= cutoff) prev = s; else break; }

    // ── score and stage changes outrank everything ──────────────────
    if (prev) {
      if (prev.phase && now.phase && prev.phase !== now.phase) {
        changes.push({ horizon, weight: KIND_WEIGHT.regime, kind: 'regime',
          headline: `Phase changed: ${prev.phase} → ${now.phase}`,
          detail: 'The master phase model adopted a new phase after its persistence requirement was met.' });
      }
      if (prev.credit_stage && now.credit_stage && prev.credit_stage !== now.credit_stage) {
        changes.push({ horizon, weight: KIND_WEIGHT.stage, kind: 'stage',
          headline: `Credit Canary: ${prev.credit_stage} → ${now.credit_stage}`,
          detail: `Score ${fmtN(prev.credit)} → ${fmtN(now.credit)} of 5.` });
      }
      for (const [key, label, w] of [
        ['credit', 'Credit Canary', KIND_WEIGHT.score + 3],
        ['bust', 'Bust Risk', KIND_WEIGHT.score + 2],
        ['meltup', 'Melt-Up Score', KIND_WEIGHT.score + 1]] as const) {
        const a = prev[key as keyof Snapshot] as number | null;
        const b = now[key as keyof Snapshot] as number | null;
        if (a === null || b === null || Math.abs(b - a) < 0.5) continue;
        changes.push({ horizon, weight: w, kind: 'score',
          headline: `${label} ${a.toFixed(1)} → ${b.toFixed(1)} of 5`,
          detail: b > a ? 'Score rose — more of the configuration is present.' : 'Score fell — part of the configuration has gone.' });
      }
      if (prev.liquidity_regime && now.liquidity_regime && prev.liquidity_regime !== now.liquidity_regime) {
        changes.push({ horizon, weight: KIND_WEIGHT.stage - 5, kind: 'stage',
          headline: `Liquidity regime: ${prev.liquidity_regime} → ${now.liquidity_regime}`,
          detail: 'Fed balance-sheet trend crossed a configured band.' });
      }
    }

    // ── threshold crossings in tracked indicators ───────────────────
    for (const t of TRACKED) {
      const pts = m.get(t.id);
      const end = latest(pts);
      if (!end || !pts) continue;
      const then = valueOnOrBefore(pts, cutoff);
      if (!then || then.date >= end.date) continue;
      const abs = end.value - then.value;
      const pct = Math.abs(then.value) > 1e-12 ? (abs / Math.abs(then.value)) * 100 : 0;
      const moveBp = abs * 100;

      const crossed = crossing(t.id, then.value, end.value);
      if (crossed) {
        changes.push({ horizon, weight: KIND_WEIGHT.threshold + t.weight / 10, kind: 'threshold',
          headline: crossed,
          detail: `${t.label} ${then.value.toFixed(t.dp)}${t.unit} → ${end.value.toFixed(t.dp)}${t.unit} since ${then.date}.` });
        continue;
      }
      const material = t.bp
        ? Math.abs(moveBp) >= MATERIAL[horizon].bp
        : Math.abs(pct) >= MATERIAL[horizon].pct;
      if (!material) continue;
      changes.push({ horizon, weight: KIND_WEIGHT.move + t.weight / 10, kind: 'move',
        headline: t.bp
          ? `${t.label} ${moveBp > 0 ? 'widened' : 'narrowed'} ${Math.abs(moveBp).toFixed(0)}bp`
          : `${t.label} ${pct > 0 ? '+' : ''}${pct.toFixed(1)}%`,
        detail: `${then.value.toFixed(t.dp)}${t.unit} → ${end.value.toFixed(t.dp)}${t.unit} since ${then.date}.` });
    }

    // acceleration: the rate of change itself changing, which is a
    // different event from a large move and ranks between score and move
    for (const [id, label] of [['spx', 'S&P 500'], ['hy_oas', 'HY OAS']] as const) {
      const pts = m.get(id);
      if (!pts?.length) continue;
      const end = pts[pts.length - 1];
      const half = Math.max(1, Math.round(DAYS[horizon] / 2));
      const mid = valueOnOrBefore(pts, isoDaysAgo(end.date, half));
      const start = valueOnOrBefore(pts, cutoff);
      if (!mid || !start || start.date >= mid.date || mid.date >= end.date) continue;
      const r1 = mid.value - start.value;     // first half
      const r2 = end.value - mid.value;       // second half
      if (Math.abs(r1) < 1e-9) continue;
      const faster = Math.abs(r2) > Math.abs(r1) * 1.75 && Math.sign(r2) === Math.sign(r1);
      if (!faster) continue;
      changes.push({ horizon, weight: KIND_WEIGHT.acceleration, kind: 'acceleration',
        headline: `${label} is accelerating ${r2 > 0 ? 'higher' : 'lower'}`,
        detail: `the second half of this ${horizon} moved ${Math.abs(r2 / r1).toFixed(1)}x the first half.` });
    }

    changes.sort((a, b) => b.weight - a.weight);
    out[horizon] = changes.slice(0, 3);
  }
  return out;
}

const fmtN = (v: number | null) => (v === null ? '—' : v.toFixed(1));

/** Named threshold crossings, which outrank a plain move of any size. */
function crossing(id: string, from: number, to: number): string | null {
  const c = thresholds.credit, r = thresholds.rates;
  const pass = (lvl: number) => from < lvl && to >= lvl;
  const fall = (lvl: number) => from >= lvl && to < lvl;
  if (id === 'hy_oas') {
    if (pass(c.hy_stress)) return `HY OAS crossed above ${c.hy_stress}% — the crisis threshold`;
    if (pass(c.hy_caution)) return `HY OAS crossed above ${c.hy_caution}% — the stress threshold`;
    if (pass(c.hy_calm)) return `HY OAS crossed above ${c.hy_calm}% — no longer calm`;
    if (fall(c.hy_calm)) return `HY OAS fell back below ${c.hy_calm}% — calm again`;
  }
  if (id === 'us10y') {
    if (pass(r.us10y_critical)) return `10Y Treasury crossed above ${r.us10y_critical}%`;
    if (pass(r.us10y_warning)) return `10Y Treasury crossed above ${r.us10y_warning}%`;
    if (pass(r.us10y_watch)) return `10Y Treasury crossed above ${r.us10y_watch}%`;
    if (fall(r.us10y_watch)) return `10Y Treasury fell back below ${r.us10y_watch}%`;
  }
  if (id === 'vix') {
    if (pass(thresholds.bust.internals.vix_crisis)) return `VIX crossed above ${thresholds.bust.internals.vix_crisis}`;
    if (pass(thresholds.bust.internals.vix_stress)) return `VIX crossed above ${thresholds.bust.internals.vix_stress}`;
  }
  if (id === 'ig_oas' && pass(c.ig_stress_pct)) return `IG OAS crossed above ${c.ig_stress_pct}% — stress reaching investment grade`;
  return null;
}
