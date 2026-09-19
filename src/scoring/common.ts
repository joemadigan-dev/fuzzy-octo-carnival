// Shared primitives for the cockpit's 0-5 scores.
//
// Section 26 of the brief is the binding constraint here: never create a
// black-box score. Every score is built by ADDING named components, each
// worth at most 1, and every component carries the sentence that explains
// it and the value it was computed from. The UI renders that list verbatim,
// so a score can always be taken apart on screen.
//
// Section 31 is the other one: a missing API response must never produce a
// false market signal. A component with no data contributes 0 AND reports
// `unknown: true`, so "we cannot see this" is visibly different from "this
// is benign" — which is the distinction a dashboard like this exists to
// preserve.

import type { Point } from '../sources/types.ts';
import { isoDaysAgo, valueOnOrBefore } from '../compute/stats.ts';

/** Severity vocabulary. Section 19 forbids BUY/SELL/LONG/SHORT anywhere. */
export type Level = 'NORMAL' | 'WATCH' | 'ELEVATED' | 'STRESS' | 'CRITICAL';

export interface Component {
  /** Points added to the score — 0 or 1, occasionally 0.5 for a half-signal. */
  delta: number;
  /** Plain sentence naming the evidence and the number behind it. */
  reason: string;
  /** True when the input was missing. Contributes 0, never counted as calm. */
  unknown?: boolean;
}

export interface Score {
  score: number;          // 0-5, rounded to 1dp
  max: number;
  level: Level;
  components: Component[];
  /** How much of the score's evidence was actually available, 0-1. */
  coverage: number;
  /** Components with data, and total. Rendered as "EVIDENCE 4/5".
   *  Deliberately NOT renormalised: a missing component contributes 0 and
   *  the score stays on the same 0-5 scale, so an incomplete reading is
   *  low AND visibly incomplete rather than being scaled up to look
   *  confident. UNKNOWN is not ZERO, and it is not a smaller denominator
   *  either. */
  evidenceAvailable: number;
  evidenceTotal: number;
}

const LEVELS: Level[] = ['NORMAL', 'WATCH', 'ELEVATED', 'STRESS', 'CRITICAL'];

/** Map a 0-5 score onto the severity vocabulary. */
export function levelOf(score: number): Level {
  if (score >= 4.5) return 'CRITICAL';
  if (score >= 3.5) return 'STRESS';
  if (score >= 2.5) return 'ELEVATED';
  if (score >= 1.5) return 'WATCH';
  return 'NORMAL';
}

export { LEVELS };

/** Assemble components into a score, capped at `max`. */
export function build(components: Component[], max = 5): Score {
  const known = components.filter((c) => !c.unknown);
  const raw = known.reduce((s, c) => s + c.delta, 0);
  const score = Math.max(0, Math.min(max, Math.round(raw * 10) / 10));
  return {
    score,
    max,
    level: levelOf(score),
    components,
    coverage: components.length ? known.length / components.length : 0,
    evidenceAvailable: known.length,
    evidenceTotal: components.length,
  };
}

/** A component whose input was missing. Scores 0 and says why. */
export function noData(what: string): Component {
  return { delta: 0, reason: `${what} — no data, scored 0 (not treated as calm)`, unknown: true };
}

// ── series helpers ────────────────────────────────────────────────────

export const latest = (pts: Point[] | undefined): Point | null =>
  pts?.length ? pts[pts.length - 1] : null;

export const valueAt = (pts: Point[] | undefined, date: string): number | null =>
  pts?.length ? (valueOnOrBefore(pts, date)?.value ?? null) : null;

/** Absolute change over `days` ending at the series' last observation. */
export function change(pts: Point[] | undefined, days: number): number | null {
  const end = latest(pts);
  if (!end || !pts) return null;
  const then = valueOnOrBefore(pts, isoDaysAgo(end.date, days));
  if (!then || then.date >= end.date) return null;
  return end.value - then.value;
}

/** Percentage change over `days`, or null when the base is ~0 or absent. */
export function pctChange(pts: Point[] | undefined, days: number): number | null {
  const end = latest(pts);
  if (!end || !pts) return null;
  const then = valueOnOrBefore(pts, isoDaysAgo(end.date, days));
  if (!then || then.date >= end.date || Math.abs(then.value) < 1e-12) return null;
  return ((end.value - then.value) / Math.abs(then.value)) * 100;
}

/** Drawdown from the highest close in the trailing `days`, as a negative %. */
export function drawdown(pts: Point[] | undefined, days = 365): number | null {
  const end = latest(pts);
  if (!end || !pts?.length) return null;
  const from = isoDaysAgo(end.date, days);
  let peak = -Infinity;
  for (const p of pts) {
    if (p.date < from) continue;
    if (p.date > end.date) break;
    if (p.value > peak) peak = p.value;
  }
  if (!Number.isFinite(peak) || peak <= 0) return null;
  return ((end.value - peak) / peak) * 100;
}

export const fmt = (v: number | null, dp = 1, suffix = ''): string =>
  v === null ? '—' : `${v > 0 && suffix === '%' ? '+' : ''}${v.toFixed(dp)}${suffix}`;

export const bp = (v: number | null): string =>
  v === null ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(0)}bp`;
