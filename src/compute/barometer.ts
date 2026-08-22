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
  ZONE_PCTS, PIT_MIN_OBS, VELOCITY_OBS,
  PRESSURE_REGIMES, ALTITUDE_REGIMES,
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
 *  marks, recent range, velocity — "is this high?" answered without memory.
 *
 *  TWO PERCENTILES, DELIBERATELY DISTINCT — do not interchange them:
 *   · percentileLive — today's score against ALL available history. The
 *     honest headline for today, because today does have all of history.
 *     NEVER plot this across a historical chart.
 *   · percentilePIT — point-in-time, expanding window: each date ranked
 *     against observations strictly BEFORE it. The only figure the
 *     backtest, the zone classification and the analogue engine may use.
 *     Ranking March 2009 against a distribution containing 2020 would
 *     give the gauge a calibration it could not have had, and would make
 *     the backtest look better than it was.
 */
export interface RefMark {
  label: string;
  date: string;
  score: number;
  pct: number | null;   // point-in-time percentile at that date
  partial: boolean;     // some sub-indices had no data then — flagged, not dropped
}

export interface GaugeData {
  percentileLive: number | null;
  percentilePIT: number | null;   // today's PIT value; ≈ live, kept for audit
  firstDate: string | null;       // effective start of the distribution
  pitFirstDate: string | null;    // first date a PIT percentile was publishable
  obs: number;                    // size of the distribution behind the number
  hist: { bins: number[]; min: number; max: number };
  /** Score values at the ZONE_PCTS percentiles — the zone arcs are drawn
   *  here, so percentile-defined bands sit correctly over a score-space
   *  density curve. */
  zoneBounds: number[];
  refMarks: RefMark[];
  tfRange: Record<'d' | 'w' | 'm' | 'y' | 'y5', { lo: number; hi: number } | null>;
  velocity: number | null;        // 20-obs change in score
  velocityZ: number | null;       // signed, vs its own history of changes
  velocityPct: number | null;     // |change| vs history of |changes|
  daysInDirection: number;        // consecutive obs with the same velocity sign
  daysInZone: number;             // consecutive obs in the current zone
  partialNow: boolean;            // today's reading is missing sub-indices
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
  /** point-in-time percentiles — the only ones safe to plot historically */
  pp_2y: number | null; pp_5y: number | null;
  ap_2y: number | null; ap_5y: number | null;
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
  corr: {
    ids: string[]; matrix: (number | null)[][]; flagged: { a: string; b: string; r: number }[];
    /** ids present for comparison only — carried, not weighted. */
    observed: string[];
  };
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
    pit: (number | null)[]; coverage: number[]; vel: (number | null)[];
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
    const coverage: number[] = [];
    for (const date of dates) {
      let sum = 0, covered = 0;
      for (const sub of layer.subs) {
        const z = subZAt.get(sub.id)?.get(date);
        if (z !== undefined) { sum += sub.weight * z; covered += sub.weight; }
      }
      coverage.push(covered);
      scores.push(covered >= MIN_COVERAGE ? (layer.polarity * sum) / covered : null);
    }

    // Zones are percentile bands, and the percentile that decides a
    // historical date's zone must be point-in-time — otherwise every
    // pre-2020 classification is made with knowledge of 2020.
    const pit = pitPercentiles(scores);
    const raws = pit.map((p) => (p === null ? null : zoneOf(layerId, p)));
    return { scores, raws, regimes: applyHysteresis(raws), pit, coverage, vel: velocitySeries(scores), subZAt };
  }

  const base: Record<LayerId, Record<ZWindow, ReturnType<typeof layerSeries>>> = {
    pressure: { '2y': layerSeries('pressure', '2y'), '5y': layerSeries('pressure', '5y') },
    altitude: { '2y': layerSeries('altitude', '2y'), '5y': layerSeries('altitude', '5y') },
  };

  // ── history + divergence ─────────────────────────────────────────────
  // Altitude stretched AND pressure falling — direction, not level. A
  // level test fires on any quiet day below the median, which is most of
  // them, and would bury the configuration this instrument exists to catch.
  const divergence = (w: ZWindow, i: number): 0 | 1 => {
    const aPct = base.altitude[w].pit[i];
    const pVel = base.pressure[w].vel[i];
    if (aPct === null || pVel === null) return 0;
    return aPct >= DIVERGENCE.altitudePctAtLeast && pVel < DIVERGENCE.pressureVelocityBelow ? 1 : 0;
  };

  // Persistence, consistent with regime hysteresis: the configuration must
  // hold HYSTERESIS_DAYS consecutive sessions to count as open, and fail as
  // many to count as closed. Without it the flag flickers on 1-2 day
  // wobbles in pressure velocity and the duration chart becomes noise.
  const divRaw: Record<ZWindow, (0 | 1)[]> = {
    '2y': dates.map((_, i) => divergence('2y', i)),
    '5y': dates.map((_, i) => divergence('5y', i)),
  };
  const divHeld: Record<ZWindow, (0 | 1)[]> = {
    '2y': persist(divRaw['2y']),
    '5y': persist(divRaw['5y']),
  };

  const history: HistoryRow[] = dates.map((date, i) => ({
    date,
    p_2y: r4(base.pressure['2y'].scores[i]), p_5y: r4(base.pressure['5y'].scores[i]),
    a_2y: r4(base.altitude['2y'].scores[i]), a_5y: r4(base.altitude['5y'].scores[i]),
    pp_2y: r4(base.pressure['2y'].pit[i]), pp_5y: r4(base.pressure['5y'].pit[i]),
    ap_2y: r4(base.altitude['2y'].pit[i]), ap_5y: r4(base.altitude['5y'].pit[i]),
    pr_2y: base.pressure['2y'].regimes[i], pr_5y: base.pressure['5y'].regimes[i],
    ar_2y: base.altitude['2y'].regimes[i], ar_5y: base.altitude['5y'].regimes[i],
    div_2y: divHeld['2y'][i], div_5y: divHeld['5y'][i],
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
        gauge: buildGauge(layer.id, dates, b.scores, b.pit, b.coverage, b.regimes, li),
      };
    }
  }

  // ── diagnostics ──────────────────────────────────────────────────────
  // Correlation matrix of all inputs' 5y-window z-series, plus any series
  // flagged `correlate` — carried as observations with no weight. A tile
  // excluded from the signal still has to answer whether it is simply
  // re-expressing something the signal already reads, and the matrix is
  // where that question gets answered. They are appended after the
  // weighted inputs and never enter a layer, the leave-one-out, or the
  // analogue z-vector.
  const observed = KPIS.filter((k) => !k.subIndex && k.correlate);
  for (const def of observed) {
    const pts = seriesMap.get(def.id) ?? [];
    const z5 = rollingZScore(pts, Z_WINDOWS['5y'][def.freq ?? 'daily']);
    const cap = FFILL_CAP[def.freq ?? 'daily'];
    const map = new Map<string, number>();
    let i = 0, last: Point | null = null;
    for (const date of dates) {
      while (i < z5.length && z5[i].date <= date) { last = z5[i]; i++; }
      if (last && last.date >= isoDaysAgo(date, cap)) map.set(date, last.value);
    }
    zByInput.set(def.id, { def, byWindow: { '2y': map, '5y': map } });
  }

  const ids = [...members.map((m) => m.id), ...observed.map((o) => o.id)];
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

  return { detail, divergenceNow, analogues, history, changes, diagnostics: { corr: { ids, matrix, flagged, observed: observed.map((o) => o.id) }, loo, divergenceEpisodes } };
}

/** Everything behind the gauge face for one (layer, window). */
function buildGauge(
  layerId: LayerId,
  dates: string[],
  scores: (number | null)[],
  pit: (number | null)[],
  coverage: number[],
  regimes: (Regime | null)[],
  li: number,
): GaugeData {
  const empty: GaugeData = {
    percentileLive: null, percentilePIT: null, firstDate: null, pitFirstDate: null, obs: 0,
    hist: { bins: [], min: -2.5, max: 2.5 }, zoneBounds: [],
    refMarks: [],
    tfRange: { d: null, w: null, m: null, y: null, y5: null },
    velocity: null, velocityZ: null, velocityPct: null,
    daysInDirection: 0, daysInZone: 0, partialNow: false,
  };
  if (li < 0) return empty;
  const cur = scores[li]!;

  const vals: number[] = [];
  let firstDate: string | null = null;
  for (let i = 0; i <= li; i++) {
    if (scores[i] === null) continue;
    vals.push(scores[i]!);
    if (!firstDate) firstDate = dates[i];
  }
  let pitFirstDate: string | null = null;
  for (let i = 0; i <= li; i++) if (pit[i] !== null) { pitFirstDate = dates[i]; break; }

  // headline: today ranked against everything, which today legitimately has
  const percentileLive = rankPct(vals, cur);

  const sorted = [...vals].sort((a, b) => a - b);
  const min = sorted[0], max = sorted[sorted.length - 1];
  const NBINS = 100;
  const bins = new Array(NBINS).fill(0);
  const span = max - min || 1;
  for (const v of vals) bins[Math.min(NBINS - 1, Math.floor(((v - min) / span) * NBINS))]++;
  const peak = Math.max(...bins, 1);
  const zoneBounds = ZONE_PCTS.map((p) => quantile(sorted, p));

  // ── reference marks ────────────────────────────────────────────────
  const refMarks: RefMark[] = [];
  const push = (label: string, i: number) => {
    if (i < 0 || i > li || scores[i] === null) return;
    if (refMarks.some((m) => m.date === dates[i] && m.label === label)) return;
    refMarks.push({
      label, date: dates[i], score: r4(scores[i])!, pct: r4(pit[i]),
      // partial rather than dropped or fabricated: some sub-indices simply
      // had no data that far back (sentiment starts later than credit)
      partial: coverage[i] < 0.999,
    });
  };
  for (const ref of GAUGE_REF_DATES) {
    const idx = idxOnOrBefore(dates, ref.date);
    if (idx >= 0 && dates[idx] >= isoDaysAgo(ref.date, 21)) push(ref.label, idx);
  }
  let hiIdx = -1, loIdx = -1, hi12 = -1, lo12 = -1;
  const yearAgo = isoDaysAgo(dates[li], 365);
  for (let i = 0; i <= li; i++) {
    if (scores[i] === null) continue;
    if (hiIdx < 0 || scores[i]! > scores[hiIdx]!) hiIdx = i;
    if (loIdx < 0 || scores[i]! < scores[loIdx]!) loIdx = i;
    if (dates[i] >= yearAgo) {
      if (hi12 < 0 || scores[i]! > scores[hi12]!) hi12 = i;
      if (lo12 < 0 || scores[i]! < scores[lo12]!) lo12 = i;
    }
  }
  push('RECORD HIGH', hiIdx);
  push('RECORD LOW', loIdx);
  if (hi12 !== hiIdx) push('12M HIGH', hi12);
  if (lo12 !== loIdx) push('12M LOW', lo12);

  // ── range over each timeframe ──────────────────────────────────────
  const tfRange = { d: null, w: null, m: null, y: null, y5: null } as GaugeData['tfRange'];
  const HORIZON = { d: 1, w: 7, m: 30, y: 365, y5: 1826 } as const;
  for (const tf of ['d', 'w', 'm', 'y', 'y5'] as const) {
    const from = isoDaysAgo(dates[li], HORIZON[tf]);
    let lo = Infinity, hi = -Infinity;
    for (let i = li; i >= 0 && dates[i] >= from; i--) {
      if (scores[i] === null) continue;
      if (scores[i]! < lo) lo = scores[i]!;
      if (scores[i]! > hi) hi = scores[i]!;
    }
    if (lo <= hi) tfRange[tf] = { lo: r4(lo)!, hi: r4(hi)! };
  }

  // ── velocity: level alone is half the information. A slow drift into
  //    UNSETTLED and a two-week collapse into it are different events. ──
  const idxs: number[] = [];
  for (let i = 0; i <= li; i++) if (scores[i] !== null) idxs.push(i);
  const deltas: number[] = [];
  const deltaAt = new Map<number, number>();
  for (let k = VELOCITY_OBS; k < idxs.length; k++) {
    const d = scores[idxs[k]]! - scores[idxs[k - VELOCITY_OBS]]!;
    deltas.push(d);
    deltaAt.set(idxs[k], d);
  }
  let velocity: number | null = null, velocityZ: number | null = null, velocityPct: number | null = null;
  let daysInDirection = 0;
  if (deltas.length >= 30) {
    velocity = deltaAt.get(li) ?? null;
    const mean = deltas.reduce((s, x) => s + x, 0) / deltas.length;
    const sd = Math.sqrt(deltas.reduce((s, x) => s + (x - mean) ** 2, 0) / deltas.length);
    if (velocity !== null && sd > 1e-12) velocityZ = (velocity - mean) / sd;
    // magnitude percentile: "how fast is this move" regardless of sign —
    // the direction word beside it carries which way
    if (velocity !== null) velocityPct = rankPct(deltas.map(Math.abs), Math.abs(velocity));
    if (velocity !== null) {
      const sign = Math.sign(velocity);
      for (let k = idxs.length - 1; k >= 0; k--) {
        const d = deltaAt.get(idxs[k]);
        if (d === undefined || Math.sign(d) !== sign || sign === 0) break;
        daysInDirection++;
      }
    }
  }

  // ── how long in the current zone ───────────────────────────────────
  // counted on the DISPLAYED (hysteresis-applied) regime, so the readout
  // matches the label beside it rather than the raw band
  let daysInZone = 0;
  const curZone = regimes[li];
  if (curZone) {
    for (let i = li; i >= 0 && regimes[i] === curZone; i--) daysInZone++;
  }

  return {
    percentileLive: r4(percentileLive),
    percentilePIT: r4(pit[li]),
    firstDate,
    pitFirstDate,
    obs: vals.length,
    hist: { bins: bins.map((b: number) => r4(b / peak)!), min: r4(min)!, max: r4(max)! },
    zoneBounds: zoneBounds.map((z) => r4(z)!),
    refMarks: refMarks.sort((a, b) => a.score - b.score),
    tfRange,
    velocity: r4(velocity),
    velocityZ: r4(velocityZ),
    velocityPct: r4(velocityPct),
    daysInDirection,
    daysInZone,
    partialNow: coverage[li] < 0.999,
  };
}

/** Nearest-neighbour search on the current 5y-window z-vector across all
 *  history: cosine similarity over shared dimensions, ≥70% of today's
 *  dimensions required, candidates ≥180d old and ≥60d apart.
 *  No look-ahead: the vector is built from ROLLING z-scores, each computed
 *  from a trailing window only, so a 2009 candidate is described exactly as
 *  it would have been described in 2009. */
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

/** Require HYSTERESIS_DAYS consecutive sessions to flip a boolean state. */
function persist(flags: (0 | 1)[]): (0 | 1)[] {
  const out: (0 | 1)[] = new Array(flags.length).fill(0);
  let state: 0 | 1 = 0, run = 0, runVal: 0 | 1 = 0;
  for (let i = 0; i < flags.length; i++) {
    if (flags[i] === runVal) run++;
    else { runVal = flags[i]; run = 1; }
    if (runVal !== state && run >= HYSTERESIS_DAYS) state = runVal;
    out[i] = state;
  }
  return out;
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

/** Percentile → zone. Both faces use the same band edges (ZONE_PCTS); the
 *  vocabularies differ because the layers mean different things. Pressure
 *  is already polarity-flipped at score time, so low percentile = STORM on
 *  one face and GROUNDED on the other, consistently "low end of its own
 *  history". */
function zoneOf(layer: LayerId, pct: number): Regime {
  const names = layer === 'pressure' ? PRESSURE_REGIMES : ALTITUDE_REGIMES;
  let i = 0;
  while (i < ZONE_PCTS.length && pct >= ZONE_PCTS[i]) i++;
  return names[i] as Regime;
}

// ── percentile machinery ───────────────────────────────────────────────
// A Fenwick tree over quantised score buckets keeps the expanding-window
// rank O(n log n) instead of O(n²); at ~6k dates × 2 layers × 2 windows ×
// 25 leave-one-out passes the quadratic version would blow the CPU budget.

const Q_LO = -8, Q_HI = 8, Q_STEPS = 3200; // 0.005 resolution

function bucket(v: number): number {
  const t = (Math.max(Q_LO, Math.min(Q_HI, v)) - Q_LO) / (Q_HI - Q_LO);
  return Math.min(Q_STEPS - 1, Math.max(0, Math.floor(t * Q_STEPS))) + 1;
}

class Fenwick {
  private t = new Int32Array(Q_STEPS + 2);
  add(i: number): void { for (; i <= Q_STEPS; i += i & -i) this.t[i]++; }
  countUpTo(i: number): number { let s = 0; for (; i > 0; i -= i & -i) s += this.t[i]; return s; }
}

/** 20-observation change in the score, on the master date axis. */
function velocitySeries(scores: (number | null)[]): (number | null)[] {
  const out: (number | null)[] = new Array(scores.length).fill(null);
  const idxs: number[] = [];
  for (let i = 0; i < scores.length; i++) if (scores[i] !== null) idxs.push(i);
  for (let k = VELOCITY_OBS; k < idxs.length; k++) {
    out[idxs[k]] = scores[idxs[k]]! - scores[idxs[k - VELOCITY_OBS]]!;
  }
  return out;
}

/** Point-in-time percentile for every entry: rank against observations
 *  STRICTLY BEFORE it. Null until PIT_MIN_OBS priors exist — a percentile
 *  off a thin distribution is a number pretending to be information. */
function pitPercentiles(scores: (number | null)[]): (number | null)[] {
  const fw = new Fenwick();
  const out: (number | null)[] = new Array(scores.length).fill(null);
  let n = 0;
  for (let i = 0; i < scores.length; i++) {
    const v = scores[i];
    if (v === null) continue;
    if (n >= PIT_MIN_OBS) out[i] = (fw.countUpTo(bucket(v)) / n) * 100;
    fw.add(bucket(v));
    n++;
  }
  return out;
}

/** Rank of one value against a full pool (used for today's live figure and
 *  for velocity magnitudes). */
function rankPct(pool: number[], v: number): number | null {
  if (!pool.length) return null;
  let below = 0;
  for (const x of pool) if (x <= v) below++;
  return (below / pool.length) * 100;
}

/** Score value at a given percentile of the pool (for the zone arcs). */
function quantile(sorted: number[], pct: number): number {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((pct / 100) * sorted.length) - 1));
  return sorted[idx];
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
