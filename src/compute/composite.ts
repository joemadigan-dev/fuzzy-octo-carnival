// Composite regime signal. Fully transparent, z-score based, backtested.
// Runs in the cron job only; the request path reads finished rows.

import type { Point } from '../sources/types.ts';
import {
  SIGNAL_INPUTS, Z_WINDOWS, THRESHOLDS, HYSTERESIS_DAYS,
  type Regime, type ZWindow,
} from '../registry/signal.ts';
import { rollingZScore } from './stats.ts';

export interface InputDetail {
  id: string;
  weight: number;
  sign: 1 | -1;
  rationale: string;
  value: number | null;        // latest raw value of the input series
  z: number | null;            // latest z-score
  contribution: number | null; // weight · sign · z
  asOf: string | null;
}

export interface WindowDetail {
  score: number | null;
  regime: Regime | null;
  rawRegime: Regime | null;    // pre-hysteresis classification of latest score
  inputs: InputDetail[];
}

export interface HistoryRow {
  date: string;
  score_2y: number | null;
  score_5y: number | null;
  regime_2y: Regime | null;
  regime_5y: Regime | null;
}

export interface ChangeRow {
  date: string;
  window: ZWindow;
  from_regime: Regime;
  to_regime: Regime;
  score: number;
  drivers: { id: string; z: number; contribution: number }[];
}

export interface CompositeResult {
  detail: Record<ZWindow, WindowDetail>;
  history: HistoryRow[];
  changes: ChangeRow[];
}

function classify(score: number): Regime {
  if (score >= THRESHOLDS.stressAt) return 'STRESS';
  if (score >= THRESHOLDS.cautionAt) return 'CAUTION';
  if (score < THRESHOLDS.riskOnBelow) return 'RISK-ON';
  return 'NEUTRAL';
}

/** Apply hysteresis: a new classification must persist HYSTERESIS_DAYS
 *  consecutive observations before the reported state changes. */
function applyHysteresis(dates: string[], raw: (Regime | null)[]): (Regime | null)[] {
  const out: (Regime | null)[] = new Array(raw.length).fill(null);
  let state: Regime | null = null;
  let pending: Regime | null = null;
  let pendingCount = 0;
  for (let i = 0; i < raw.length; i++) {
    const r = raw[i];
    if (r === null) { out[i] = state; continue; }
    if (state === null) {
      state = r; pending = null; pendingCount = 0;
    } else if (r === state) {
      pending = null; pendingCount = 0;
    } else if (r === pending) {
      pendingCount++;
      if (pendingCount >= HYSTERESIS_DAYS) { state = r; pending = null; pendingCount = 0; }
    } else {
      pending = r; pendingCount = 1;
    }
    out[i] = state;
  }
  return out;
}

export function computeComposite(seriesMap: Map<string, Point[]>): CompositeResult {
  const totalWeight = SIGNAL_INPUTS.reduce((s, i) => s + i.weight, 0) || 1;

  // z-score history per input per window, indexed by date
  const zByWindow: Record<ZWindow, Map<string, Map<string, number>>> = { '2y': new Map(), '5y': new Map() };
  const allDates = new Set<string>();

  for (const input of SIGNAL_INPUTS) {
    const pts = seriesMap.get(input.id) ?? [];
    for (const w of Object.keys(Z_WINDOWS) as ZWindow[]) {
      const z = rollingZScore(pts, Z_WINDOWS[w]);
      const m = new Map<string, number>();
      for (const p of z) { m.set(p.date, p.value); allDates.add(p.date); }
      zByWindow[w].set(input.id, m);
    }
  }

  const dates = [...allDates].sort();

  // Composite score per date per window. An input missing on a date carries
  // forward its last known z (macro series have offset publication lags).
  const scores: Record<ZWindow, (number | null)[]> = { '2y': [], '5y': [] };
  const lastZ: Record<ZWindow, Map<string, number>> = { '2y': new Map(), '5y': new Map() };

  for (const w of Object.keys(Z_WINDOWS) as ZWindow[]) {
    for (const date of dates) {
      let score = 0;
      let covered = 0;
      for (const input of SIGNAL_INPUTS) {
        const z = zByWindow[w].get(input.id)?.get(date) ?? lastZ[w].get(input.id);
        if (zByWindow[w].get(input.id)?.has(date)) lastZ[w].set(input.id, z!);
        if (z !== undefined) {
          score += (input.weight / totalWeight) * input.sign * z;
          covered += input.weight;
        }
      }
      // require ≥70% of weight present before publishing a score
      scores[w].push(covered / totalWeight >= 0.7 ? score : null);
    }
  }

  const rawRegimes: Record<ZWindow, (Regime | null)[]> = {
    '2y': scores['2y'].map((s) => (s === null ? null : classify(s))),
    '5y': scores['5y'].map((s) => (s === null ? null : classify(s))),
  };
  const regimes: Record<ZWindow, (Regime | null)[]> = {
    '2y': applyHysteresis(dates, rawRegimes['2y']),
    '5y': applyHysteresis(dates, rawRegimes['5y']),
  };

  const history: HistoryRow[] = dates.map((date, i) => ({
    date,
    score_2y: scores['2y'][i] === null ? null : round4(scores['2y'][i]!),
    score_5y: scores['5y'][i] === null ? null : round4(scores['5y'][i]!),
    regime_2y: regimes['2y'][i],
    regime_5y: regimes['5y'][i],
  }));

  // state-change log with causing inputs
  const changes: ChangeRow[] = [];
  for (const w of Object.keys(Z_WINDOWS) as ZWindow[]) {
    let prev: Regime | null = null;
    for (let i = 0; i < dates.length; i++) {
      const r = regimes[w][i];
      if (r !== null && prev !== null && r !== prev) {
        changes.push({
          date: dates[i],
          window: w,
          from_regime: prev,
          to_regime: r,
          score: round4(scores[w][i] ?? 0),
          drivers: driversAt(w, dates[i], zByWindow, totalWeight),
        });
      }
      if (r !== null) prev = r;
    }
  }

  // current transparency detail
  const detail = {} as Record<ZWindow, WindowDetail>;
  for (const w of Object.keys(Z_WINDOWS) as ZWindow[]) {
    const lastIdx = lastNonNull(scores[w]);
    const inputs: InputDetail[] = SIGNAL_INPUTS.map((input) => {
      const pts = seriesMap.get(input.id) ?? [];
      const latest = pts.length ? pts[pts.length - 1] : null;
      const zMap = zByWindow[w].get(input.id);
      const z = latest ? (zMap?.get(latest.date) ?? lastMapValue(zMap)) : undefined;
      return {
        id: input.id,
        weight: input.weight / totalWeight,
        sign: input.sign,
        rationale: input.rationale,
        value: latest?.value ?? null,
        z: z === undefined ? null : round4(z),
        contribution: z === undefined ? null : round4((input.weight / totalWeight) * input.sign * z),
        asOf: latest?.date ?? null,
      };
    });
    detail[w] = {
      score: lastIdx < 0 ? null : round4(scores[w][lastIdx]!),
      regime: lastIdx < 0 ? null : regimes[w][lastIdx],
      rawRegime: lastIdx < 0 ? null : rawRegimes[w][lastIdx],
      inputs,
    };
  }

  return { detail, history, changes };
}

function driversAt(
  w: ZWindow, date: string,
  zByWindow: Record<ZWindow, Map<string, Map<string, number>>>,
  totalWeight: number,
): ChangeRow['drivers'] {
  const drivers: ChangeRow['drivers'] = [];
  for (const input of SIGNAL_INPUTS) {
    const zMap = zByWindow[w].get(input.id);
    if (!zMap) continue;
    // last z on or before the transition date
    let z: number | undefined;
    for (const [d, v] of zMap) { if (d <= date) z = v; else break; }
    if (z !== undefined) {
      drivers.push({ id: input.id, z: round4(z), contribution: round4((input.weight / totalWeight) * input.sign * z) });
    }
  }
  drivers.sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));
  return drivers;
}

function lastNonNull(arr: (number | null)[]): number {
  for (let i = arr.length - 1; i >= 0; i--) if (arr[i] !== null) return i;
  return -1;
}

function lastMapValue(m?: Map<string, number>): number | undefined {
  if (!m || m.size === 0) return undefined;
  let v: number | undefined;
  for (const x of m.values()) v = x;
  return v;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
