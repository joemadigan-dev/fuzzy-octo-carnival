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
  LAYERS, Z_WINDOWS, HYSTERESIS_DAYS, MIN_COVERAGE, CORR_FLAG, DIVERGENCE, GAUGE_REF_DATES,
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

/** Everything the gauge face needs: distribution, percentile, reference
 *  marks, recent range — "is this high?" answered without memory. */
export interface GaugeData {
  percentile: number | null;      // current score vs full history
  firstDate: string | null;       // "since 2002-…"
  hist: { bins: number[]; min: number; max: number };
  refMarks: { label: string; date: string; score: number }[];
  tfRange: Record<'d' | 'w' | 'm' | 'y', { lo: number; hi: number } | null>;
  trend30d: number | null;        // score change vs ~30 days ago
}

export interface LayerWindowDetail {
  score: number | null;
  regime: Regime | null;
  rawRegime: Regime | null;
  subs: SubDetail[];
  gauge: GaugeData;
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

/** A historical date whose z-score vector most resembles today's. Pattern
 *  similarity across a handful of non-independent episodes — NOT a
 *  probability, and the UI copy says so. */
export interface Analogue {
  date: string;
  similarity: number;                 // cosine, shared dimensions
  dims: number;                       // how many inputs were comparable
  forward: { m1: number | null; m3: number | null; m6: number | null; m12: number | null }; // SPX %
}

export interface DivergenceNow {
  active: boolean;
  since: string | null;  // first day of the current episode
  days: number;          // calendar days it has held
}

export interface BarometerResult {
  detail: Record<LayerId, Record<ZWindow, LayerWindowDetail>>;
  divergenceNow: Record<ZWindow, DivergenceNow>;
  analogues: Analogue[];
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
        gauge: buildGauge(layer.id, dates, b.scores, li),
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

  // current divergence state per window
  const divergenceNow = {} as Record<ZWindow, DivergenceNow>;
  for (const w of ['2y', '5y'] as ZWindow[]) {
    let since: string | null = null;
    for (let i = history.length - 1; i >= 0; i--) {
      if ((w === '2y' ? history[i].div_2y : history[i].div_5y) !== 1) break;
      since = history[i].date;
    }
    const active = since !== null;
    const days = active
      ? Math.round((Date.parse(history[history.length - 1].date) - Date.parse(since!)) / 86400000) + 1
      : 0;
    divergenceNow[w] = { active, since, days };
  }

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

  const analogues = findAnalogues(dates, zsets, seriesMap.get('spx') ?? []);

  return { detail, divergenceNow, analogues, history, changes, diagnostics: { corr: { ids, matrix, flagged }, loo, divergenceEpisodes } };
}

/** Distribution, percentile, reference marks and recent range for a layer's
 *  score history. `li` = index of the current (last non-null) score. */
function buildGauge(layerId: LayerId, dates: string[], scores: (number | null)[], li: number): GaugeData {
  const empty: GaugeData = {
    percentile: null, firstDate: null,
    hist: { bins: [], min: -2.5, max: 2.5 },
    refMarks: [], tfRange: { d: null, w: null, m: null, y: null }, trend30d: null,
  };
  if (li < 0) return empty;
  const cur = scores[li]!;

  const vals: number[] = [];
  let firstDate: string | null = null;
  for (let i = 0; i <= li; i++) {
    if (scores[i] !== null) {
      vals.push(scores[i]!);
      if (!firstDate) firstDate = dates[i];
    }
  }

  let below = 0;
  for (const v of vals) if (v <= cur) below++;
  const percentile = (below / vals.length) * 100;

  const min = Math.min(-2.5, ...vals);
  const max = Math.max(2.5, ...vals);
  const NBINS = 40;
  const bins = new Array(NBINS).fill(0);
  for (const v of vals) {
    bins[Math.min(NBINS - 1, Math.max(0, Math.floor(((v - min) / (max - min)) * NBINS)))]++;
  }
  const peak = Math.max(...bins, 1);

  const refMarks: GaugeData['refMarks'] = [];
  for (const ref of GAUGE_REF_DATES) {
    const idx = idxOnOrBefore(dates, ref.date);
    if (idx >= 0 && scores[idx] !== null && dates[idx] >= isoDaysAgo(ref.date, 21)) {
      refMarks.push({ label: ref.label, date: dates[idx], score: r4(scores[idx])! });
    }
  }
  // most recent local peak: the past year's extremum in the storm direction
  // (pressure: lowest; altitude: highest)
  const yearAgo = isoDaysAgo(dates[li], 365);
  let peakIdx = -1;
  for (let i = 0; i <= li; i++) {
    if (dates[i] < yearAgo || scores[i] === null) continue;
    if (peakIdx < 0
      || (layerId === 'pressure' ? scores[i]! < scores[peakIdx]! : scores[i]! > scores[peakIdx]!)) {
      peakIdx = i;
    }
  }
  if (peakIdx >= 0 && peakIdx !== li) {
    refMarks.push({ label: '1Y PEAK', date: dates[peakIdx], score: r4(scores[peakIdx])! });
  }

  const tfRange = { d: null, w: null, m: null, y: null } as GaugeData['tfRange'];
  const HORIZON: Record<'d' | 'w' | 'm' | 'y', number> = { d: 1, w: 7, m: 30, y: 365 };
  for (const tf of ['d', 'w', 'm', 'y'] as const) {
    const from = isoDaysAgo(dates[li], HORIZON[tf]);
    let lo = Infinity, hi = -Infinity;
    for (let i = li; i >= 0 && dates[i] >= from; i--) {
      if (scores[i] === null) continue;
      if (scores[i]! < lo) lo = scores[i]!;
      if (scores[i]! > hi) hi = scores[i]!;
    }
    if (lo <= hi) tfRange[tf] = { lo: r4(lo)!, hi: r4(hi)! };
  }

  const t30 = idxOnOrBefore(dates, isoDaysAgo(dates[li], 30));
  const trend30d = t30 >= 0 && scores[t30] !== null ? r4(cur - scores[t30]!) : null;

  return {
    percentile: r4(percentile),
    firstDate,
    hist: { bins: bins.map((b: number) => r4(b / peak)!), min: r4(min)!, max: r4(max)! },
    refMarks,
    tfRange,
    trend30d,
  };
}

/** Nearest-neighbour search on the current 5y-window z-vector across all
 *  history: cosine similarity over shared dimensions, ≥70% of today's
 *  dimensions required, candidates ≥180d old and ≥60d apart. */
function findAnalogues(dates: string[], zsets: ZSet[], spx: Point[]): Analogue[] {
  if (!dates.length) return [];
  const today = dates[dates.length - 1];
  const current = new Map<string, number>();
  for (const z of zsets) {
    const v = z.byWindow['5y'].get(today);
    if (v !== undefined) current.set(z.def.id, v);
  }
  if (current.size < 6) return [];
  const minDims = Math.ceil(current.size * 0.7);
  const cutoff = isoDaysAgo(today, 180);

  const scored: { date: string; sim: number; dims: number }[] = [];
  for (const date of dates) {
    if (date >= cutoff) continue;
    let dot = 0, na = 0, nb = 0, dims = 0;
    for (const [id, a] of current) {
      const b = zById(zsets, id).get(date);
      if (b === undefined) continue;
      dims++; dot += a * b; na += a * a; nb += b * b;
    }
    if (dims < minDims || na < 1e-12 || nb < 1e-12) continue;
    scored.push({ date, sim: dot / Math.sqrt(na * nb), dims });
  }
  scored.sort((a, b) => b.sim - a.sim);

  const picked: typeof scored = [];
  for (const s of scored) {
    if (picked.length >= 5) break;
    if (picked.every((p) => Math.abs(Date.parse(p.date) - Date.parse(s.date)) > 60 * 86400000)) {
      picked.push(s);
    }
  }

  return picked.map((p) => ({
    date: p.date,
    similarity: r4(p.sim)!,
    dims: p.dims,
    forward: {
      m1: fwdReturn(spx, p.date, 30),
      m3: fwdReturn(spx, p.date, 91),
      m6: fwdReturn(spx, p.date, 182),
      m12: fwdReturn(spx, p.date, 365),
    },
  }));
}

function zById(zsets: ZSet[], id: string): Map<string, number> {
  for (const z of zsets) if (z.def.id === id) return z.byWindow['5y'];
  return new Map();
}

function fwdReturn(spx: Point[], from: string, days: number): number | null {
  if (!spx.length) return null;
  const start = valAt(spx, from);
  const end = valAt(spx, isoDaysAgo(from, -days));
  // only report a horizon that has fully elapsed
  if (!start || !end || end.date <= start.date || spx[spx.length - 1].date < isoDaysAgo(from, -days)) return null;
  return Math.abs(start.value) > 1e-12 ? r4(((end.value - start.value) / start.value) * 100) : null;
}

function valAt(pts: Point[], date: string): Point | null {
  let lo = 0, hi = pts.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (pts[mid].date <= date) { ans = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return ans >= 0 ? pts[ans] : null;
}

function idxOnOrBefore(dates: string[], date: string): number {
  let lo = 0, hi = dates.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (dates[mid] <= date) { ans = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return ans;
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
  if (s >= t.stratosphericAt) return 'STRATOSPHERIC';
  if (s >= t.extendedAt) return 'EXTENDED';
  if (s >= t.highAt) return 'HIGH';
  if (s < t.groundedBelow) return 'GROUNDED';
  return 'CLIMBING';
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
