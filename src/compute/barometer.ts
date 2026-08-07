// THE BAROMETER — two-layer regime engine with concentration diagnostics.
// Runs in the cron job only; the request path reads finished rows.
//
// input z-scores (per native frequency) → sub-indices (weighted, signed,
// then themselves z-normalised) → layer scores → regimes with hysteresis.
// Sub-index normalisation is the anti-concentration mechanism: a series
// appearing in three inputs cannot triple-count its way into the layer.

import type { Point } from '../sources/types.ts';
import { KPIS, kpiById, type KpiDef, type Freq } from '../registry/kpis.ts';
import {
  LAYERS, Z_WINDOWS, HYSTERESIS_DAYS, MIN_COVERAGE, CORR_FLAG, DIVERGENCE,
  PRESSURE_REGIMES, PRESSURE_THRESHOLDS, ALTITUDE_REGIMES, ALTITUDE_THRESHOLDS,
  type LayerId, type ZWindow, type PressureRegime, type AltitudeRegime,
} from '../registry/signal.ts';
import { rollingZScore, isoDaysAgo } from './stats.ts';

export type Regime = PressureRegime | AltitudeRegime;

export interface BaroInputDetail {
  id: string;
  value: number | null;
  z: number | null;
  sign: 1 | -1;
  weight: number;          // normalised within the sub-index
  contribution: number | null;
  asOf: string | null;
}

export interface SubDetail {
  id: string;
  label: string;
  weight: number;          // layer weight
  z: number | null;        // normalised sub-index value entering the layer
  contribution: number | null;
  inputs: BaroInputDetail[];
}

export interface LayerWindowDetail {
  score: number | null;
  regime: Regime | null;
  rawRegime: Regime | null;
  subs: SubDetail[];
}

export interface HistoryRow {
  date: string;
  p_2y: number | null; p_5y: number | null;
  a_2y: number | null; a_5y: number | null;
  pr_2y: Regime | null; pr_5y: Regime | null;
  ar_2y: Regime | null; ar_5y: Regime | null;
  div_2y: 0 | 1; div_5y: 0 | 1;
}

export interface ChangeRow {
  date: string;
  layer: LayerId;
  window: ZWindow;
  from_regime: Regime;
  to_regime: Regime;
  score: number;
  drivers: { id: string; z: number; contribution: number }[]; // sub-indices
}

export interface Diagnostics {
  /** Pairwise correlation of all z-scored inputs over the backtest window. */
  corr: { ids: string[]; matrix: (number | null)[][]; flagged: { a: string; b: string; r: number }[] };
  /** Leave-one-out: how much the layer's regime history changes without
   *  each input. Small numbers mean the input is decorative. */
  loo: { id: string; layer: LayerId; pctDaysChanged: number; scoreDelta: number | null }[];
  divergenceEpisodes: { window: ZWindow; start: string; end: string }[];
}

export interface BarometerResult {
  detail: Record<LayerId, Record<ZWindow, LayerWindowDetail>>;
  history: HistoryRow[];
  changes: ChangeRow[];
  diagnostics: Diagnostics;
}

const FFILL_CAP: Record<Freq, number> = { daily: 7, weekly: 21, monthly: 45, quarterly: 150 };

interface ZSet {
  def: KpiDef;
  /** date → z, forward-filled onto the master axis (cap by frequency). */
  byWindow: Record<ZWindow, Map<string, number>>;
}

export function computeBarometer(seriesMap: Map<string, Point[]>): BarometerResult {
  const members = KPIS.filter((k) => k.subIndex);

  // ── input z-scores on each series' own frequency ─────────────────────
  const raw: { def: KpiDef; z: Record<ZWindow, Point[]> }[] = members.map((def) => {
    const pts = seriesMap.get(def.id) ?? [];
    const freq = def.freq ?? 'daily';
    return {
      def,
      z: {
        '2y': rollingZScore(pts, Z_WINDOWS['2y'][freq]),
        '5y': rollingZScore(pts, Z_WINDOWS['5y'][freq]),
      },
    };
  });

  // master daily axis = union of all z dates
  const dateSet = new Set<string>();
  for (const r of raw) for (const w of ['2y', '5y'] as ZWindow[]) for (const p of r.z[w]) dateSet.add(p.date);
  const dates = [...dateSet].sort();

  // forward-fill each input's z onto the axis
  const zsets: ZSet[] = raw.map((r) => {
    const byWindow = { '2y': new Map<string, number>(), '5y': new Map<string, number>() };
    for (const w of ['2y', '5y'] as ZWindow[]) {
      const cap = FFILL_CAP[r.def.freq ?? 'daily'];
      let i = 0;
      let last: Point | null = null;
      for (const date of dates) {
        while (i < r.z[w].length && r.z[w][i].date <= date) { last = r.z[w][i]; i++; }
        if (last && last.date >= isoDaysAgo(date, cap)) byWindow[w].set(date, last.value);
      }
    }
    return { def: r.def, byWindow };
  });
  const zByInput = new Map(zsets.map((z) => [z.def.id, z]));

  // ── full pipeline for one (layer, window), optionally excluding an input
  function layerSeries(layerId: LayerId, w: ZWindow, exclude?: string): {
    scores: (number | null)[]; raws: (Regime | null)[]; regimes: (Regime | null)[];
    subZAt: Map<string, Map<string, number>>; // subId → date → z
  } {
    const layer = LAYERS.find((l) => l.id === layerId)!;
    const subZAt = new Map<string, Map<string, number>>();

    for (const sub of layer.subs) {
      const ms = members.filter((m) => m.subIndex === sub.id && m.id !== exclude);
      const total = ms.reduce((s, m) => s + (m.subWeight ?? 1), 0);
      if (!ms.length || total <= 0) continue;
      const rawSub: Point[] = [];
      for (const date of dates) {
        let sum = 0, covered = 0;
        for (const m of ms) {
          const z = zByInput.get(m.id)!.byWindow[w].get(date);
          if (z !== undefined) {
            const wgt = (m.subWeight ?? 1) / total;
            sum += wgt * (m.subSign ?? 1) * z;
            covered += wgt;
          }
        }
        if (covered >= MIN_COVERAGE) rawSub.push({ date, value: sum / covered });
      }
      // normalise the sub-index against its own trailing distribution
      const norm = rollingZScore(rawSub, Z_WINDOWS[w].daily);
      subZAt.set(sub.id, new Map(norm.map((p) => [p.date, p.value])));
    }

    const scores: (number | null)[] = [];
    for (const date of dates) {
      let sum = 0, covered = 0;
      for (const sub of layer.subs) {
        const z = subZAt.get(sub.id)?.get(date);
        if (z !== undefined) { sum += sub.weight * z; covered += sub.weight; }
      }
      scores.push(covered >= MIN_COVERAGE ? (layer.polarity * sum) / covered : null);
    }
    const raws = scores.map((s) => (s === null ? null : classify(layerId, s)));
    return { scores, raws, regimes: applyHysteresis(raws), subZAt };
  }

  const base: Record<LayerId, Record<ZWindow, ReturnType<typeof layerSeries>>> = {
    pressure: { '2y': layerSeries('pressure', '2y'), '5y': layerSeries('pressure', '5y') },
    altitude: { '2y': layerSeries('altitude', '2y'), '5y': layerSeries('altitude', '5y') },
  };

  // ── history + divergence ─────────────────────────────────────────────
  const divergence = (w: ZWindow, i: number): 0 | 1 => {
    const a = base.altitude[w].regimes[i];
    const p = base.pressure[w].regimes[i];
    if (a === null || p === null) return 0;
    const aHigh = ALTITUDE_REGIMES.indexOf(a as AltitudeRegime) >= ALTITUDE_REGIMES.indexOf(DIVERGENCE.altitudeAtLeast);
    const pLow = PRESSURE_REGIMES.indexOf(p as PressureRegime) >= PRESSURE_REGIMES.indexOf(DIVERGENCE.pressureAtMost);
    return aHigh && pLow ? 1 : 0;
  };

  const history: HistoryRow[] = dates.map((date, i) => ({
    date,
    p_2y: r4(base.pressure['2y'].scores[i]), p_5y: r4(base.pressure['5y'].scores[i]),
    a_2y: r4(base.altitude['2y'].scores[i]), a_5y: r4(base.altitude['5y'].scores[i]),
    pr_2y: base.pressure['2y'].regimes[i], pr_5y: base.pressure['5y'].regimes[i],
    ar_2y: base.altitude['2y'].regimes[i], ar_5y: base.altitude['5y'].regimes[i],
    div_2y: divergence('2y', i), div_5y: divergence('5y', i),
  }));

  // ── change log with sub-index drivers ────────────────────────────────
  const changes: ChangeRow[] = [];
  for (const layer of LAYERS) {
    for (const w of ['2y', '5y'] as ZWindow[]) {
      const b = base[layer.id][w];
      let prev: Regime | null = null;
      for (let i = 0; i < dates.length; i++) {
        const r = b.regimes[i];
        if (r !== null && prev !== null && r !== prev) {
          const drivers = layer.subs
            .map((sub) => {
              const z = b.subZAt.get(sub.id)?.get(dates[i]);
              return z === undefined ? null : { id: sub.id, z: r4(z)!, contribution: r4(layer.polarity * sub.weight * z)! };
            })
            .filter((d): d is NonNullable<typeof d> => d !== null)
            .sort((x, y) => Math.abs(y.contribution) - Math.abs(x.contribution));
          changes.push({ date: dates[i], layer: layer.id, window: w, from_regime: prev, to_regime: r, score: r4(b.scores[i]) ?? 0, drivers });
        }
        if (r !== null) prev = r;
      }
    }
  }

  // ── current detail ───────────────────────────────────────────────────
  const detail = {} as BarometerResult['detail'];
  for (const layer of LAYERS) {
    detail[layer.id] = {} as Record<ZWindow, LayerWindowDetail>;
    for (const w of ['2y', '5y'] as ZWindow[]) {
      const b = base[layer.id][w];
      const li = lastNonNull(b.scores);
      const subs: SubDetail[] = layer.subs.map((sub) => {
        const zMap = b.subZAt.get(sub.id);
        const z = li >= 0 ? (zMap?.get(dates[li]) ?? lastMapValue(zMap)) : undefined;
        const ms = members.filter((m) => m.subIndex === sub.id);
        const total = ms.reduce((s, m) => s + (m.subWeight ?? 1), 0) || 1;
        const inputs: BaroInputDetail[] = ms.map((m) => {
          const pts = seriesMap.get(m.id) ?? [];
          const latest = pts.length ? pts[pts.length - 1] : null;
          const zi = li >= 0 ? zByInput.get(m.id)!.byWindow[w].get(dates[li]) : undefined;
          const wgt = (m.subWeight ?? 1) / total;
          return {
            id: m.id,
            value: latest ? r4(latest.value) : null,
            z: zi === undefined ? null : r4(zi),
            sign: m.subSign ?? 1,
            weight: r4(wgt)!,
            contribution: zi === undefined ? null : r4(wgt * (m.subSign ?? 1) * zi),
            asOf: latest?.date ?? null,
          };
        });
        return {
          id: sub.id, label: sub.label, weight: sub.weight,
          z: z === undefined ? null : r4(z),
          contribution: z === undefined ? null : r4(layer.polarity * sub.weight * z),
          inputs,
        };
      });
      detail[layer.id][w] = {
        score: li < 0 ? null : r4(b.scores[li]),
        regime: li < 0 ? null : b.regimes[li],
        rawRegime: li < 0 ? null : b.raws[li],
        subs,
      };
    }
  }

  // ── diagnostics ──────────────────────────────────────────────────────
  // correlation matrix of all inputs' 5y-window z-series
  const ids = members.map((m) => m.id);
  const matrix: (number | null)[][] = ids.map(() => ids.map(() => null));
  const flagged: Diagnostics['corr']['flagged'] = [];
  for (let a = 0; a < ids.length; a++) {
    for (let b2 = a; b2 < ids.length; b2++) {
      const r = a === b2 ? 1 : pearsonOverDates(zByInput.get(ids[a])!.byWindow['5y'], zByInput.get(ids[b2])!.byWindow['5y'], dates);
      matrix[a][b2] = r === null ? null : r4(r);
      matrix[b2][a] = matrix[a][b2];
      if (a !== b2 && r !== null && Math.abs(r) >= CORR_FLAG) {
        flagged.push({ a: ids[a], b: ids[b2], r: r4(r)! });
      }
    }
  }
  flagged.sort((x, y) => Math.abs(y.r) - Math.abs(x.r));

  // leave-one-out on the 2y window (the tuning window)
  const loo: Diagnostics['loo'] = [];
  for (const m of members) {
    const layerId = LAYERS.find((l) => l.subs.some((s) => s.id === m.subIndex))?.id;
    if (!layerId) continue;
    const b = base[layerId]['2y'];
    const v = layerSeries(layerId, '2y', m.id);
    let both = 0, diff = 0;
    for (let i = 0; i < dates.length; i++) {
      if (b.regimes[i] !== null && v.regimes[i] !== null) {
        both++;
        if (b.regimes[i] !== v.regimes[i]) diff++;
      }
    }
    const li = lastNonNull(b.scores);
    const lv = lastNonNull(v.scores);
    loo.push({
      id: m.id,
      layer: layerId,
      pctDaysChanged: both ? r4((diff / both) * 100)! : 0,
      scoreDelta: li >= 0 && lv >= 0 ? r4((v.scores[lv] ?? 0) - (b.scores[li] ?? 0)) : null,
    });
  }
  loo.sort((x, y) => y.pctDaysChanged - x.pctDaysChanged);

  // divergence episodes
  const divergenceEpisodes: Diagnostics['divergenceEpisodes'] = [];
  for (const w of ['2y', '5y'] as ZWindow[]) {
    let start: string | null = null;
    for (let i = 0; i < history.length; i++) {
      const on = (w === '2y' ? history[i].div_2y : history[i].div_5y) === 1;
      if (on && !start) start = history[i].date;
      if (!on && start) { divergenceEpisodes.push({ window: w, start, end: history[i - 1].date }); start = null; }
    }
    if (start) divergenceEpisodes.push({ window: w, start, end: history[history.length - 1].date });
  }

  return { detail, history, changes, diagnostics: { corr: { ids, matrix, flagged }, loo, divergenceEpisodes } };
}

// ── helpers ────────────────────────────────────────────────────────────

function classify(layer: LayerId, s: number): Regime {
  if (layer === 'pressure') {
    const t = PRESSURE_THRESHOLDS;
    if (s >= t.setFairAt) return 'SET FAIR';
    if (s >= t.fairAt) return 'FAIR';
    if (s < t.stormBelow) return 'STORM';
    if (s < t.unsettledBelow) return 'UNSETTLED';
    return 'CHANGE';
  }
  const t = ALTITUDE_THRESHOLDS;
  if (s >= t.extremeAt) return 'EXTREME';
  if (s >= t.highAt) return 'HIGH';
  if (s < t.lowBelow) return 'LOW';
  return 'MODERATE';
}

function applyHysteresis(rawR: (Regime | null)[]): (Regime | null)[] {
  const out: (Regime | null)[] = new Array(rawR.length).fill(null);
  let state: Regime | null = null;
  let pending: Regime | null = null;
  let pendingCount = 0;
  for (let i = 0; i < rawR.length; i++) {
    const r = rawR[i];
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

function pearsonOverDates(a: Map<string, number>, b: Map<string, number>, dates: string[]): number | null {
  let n = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
  for (const d of dates) {
    const x = a.get(d), y = b.get(d);
    if (x === undefined || y === undefined) continue;
    n++; sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y;
  }
  if (n < 60) return null;
  const cov = sxy - (sx * sy) / n;
  const vx = sxx - (sx * sx) / n;
  const vy = syy - (sy * sy) / n;
  const den = Math.sqrt(vx * vy);
  return den > 1e-12 ? Math.max(-1, Math.min(1, cov / den)) : null;
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

function r4(n: number | null | undefined): number | null {
  return n === null || n === undefined ? null : Math.round(n * 10000) / 10000;
}
