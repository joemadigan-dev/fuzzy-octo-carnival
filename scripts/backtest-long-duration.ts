// Historical validation of the Long Duration Setup score.
//
// THE TEST IS NOT "can thresholds be tuned to fit history". It is the
// narrow question the brief asks: did high readings tend to PRECEDE periods
// in which long-duration Treasuries produced strong returns? And, given
// equal weight, where did high readings FAIL — specifically the periods
// where growth weakened but inflation, fiscal or term-premium pressure kept
// long yields elevated, which is the one failure mode that would make the
// whole module dangerous rather than merely unhelpful.
//
// NO THRESHOLD IS TUNED HERE. The script imports config/thresholds.json and
// reads it; it never writes it. If the results are poor, the honest output
// is a poor result and a stated limitation, not a better-looking number.
//
// WHAT IT CANNOT DO, stated up front because it bounds every conclusion:
//
//  1. The full three-pillar score needs a 30-year REAL yield, and DFII30
//     begins 2010-02-22 — 30-year TIPS were not issued between 2001 and
//     2010. So the real score cannot be evaluated over 2001 or 2008 at all.
//  2. For those two episodes a REDUCED variant is run: nominal yield
//     percentile, term premium percentile and core CPI trend, with DLTIIT
//     (TIPS 10y+ average yield, from 2000) standing in where a long real
//     yield is needed. That is a DIFFERENT and weaker instrument. Its
//     results are reported separately and never averaged with the full
//     score's, because doing so would manufacture a track record the score
//     does not have.
//  3. The macro pillar consumes Bust Risk, the Credit Canary, the phase
//     model and the liquidity card. Those cannot be reconstructed for 2001
//     without the equity, credit and balance-sheet history the Wall does
//     not hold that far back in every series. The backtest therefore
//     evaluates the VALUATION and INFLATION pillars plus a proxy for the
//     macro pillar built from what FRED alone can supply (the 2s10s curve
//     and the unemployment rate's own trend). That proxy is not the
//     production macro pillar and is labelled as such throughout.
//
// Run: npx tsx scripts/backtest-long-duration.ts

import thresholds from '../config/thresholds.json' with { type: 'json' };

const T = thresholds.long_duration;
const UA = 'the-wall/1.0 (+https://the-wall.joemadigan.workers.dev)';
const CSV = 'https://fred.stlouisfed.org/graph/fredgraph.csv';

interface Pt { date: string; value: number }

async function fred(id: string, from = '1980-01-01'): Promise<Pt[]> {
  const url = `${CSV}?id=${id}&cosd=${from}`;
  const res = await fetch(url, { headers: { accept: 'text/csv', 'user-agent': UA } });
  if (!res.ok) throw new Error(`${id}: HTTP ${res.status}`);
  const text = await res.text();
  const out: Pt[] = [];
  for (const line of text.trim().split('\n').slice(1)) {
    const [d, v] = line.split(',');
    const n = Number(v);
    if (v && v.trim() !== '.' && Number.isFinite(n)) out.push({ date: d.trim(), value: n });
  }
  return out;
}

// ── series helpers, deliberately independent of src/ ──────────────────
// Re-implemented here rather than imported so a change in production
// behaviour cannot silently alter a historical result that has already
// been reported.

const at = (pts: Pt[], date: string): Pt | null => {
  let lo = 0, hi = pts.length - 1, best: Pt | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (pts[mid].date <= date) { best = pts[mid]; lo = mid + 1; } else hi = mid - 1;
  }
  return best;
};

const daysAgo = (iso: string, d: number) =>
  new Date(Date.parse(iso + 'T00:00:00Z') - d * 86400000).toISOString().slice(0, 10);

/** Percentile of the value at `date` against everything up to `date`.
 *  POINT IN TIME: it must never see the future, or the whole exercise is
 *  worthless. */
function pctAsOf(pts: Pt[], date: string): { pct: number; n: number } | null {
  let below = 0, n = 0, v: number | null = null;
  for (const p of pts) {
    if (p.date > date) break;
    v = p.value; n++;
  }
  if (v === null || n < 250) return null;
  for (const p of pts) {
    if (p.date > date) break;
    if (p.value <= v) below++;
  }
  return { pct: (below / n) * 100, n };
}

const chgBp = (pts: Pt[], date: string, days: number): number | null => {
  const now = at(pts, date), then = at(pts, daysAgo(date, days));
  return now && then && then.date < now.date ? (now.value - then.value) * 100 : null;
};

function annualisedIdx(pts: Pt[], date: string, months: number): number | null {
  const now = at(pts, date), then = at(pts, daysAgo(date, Math.round(months * 30.44)));
  if (!now || !then || then.date >= now.date || then.value <= 0) return null;
  const years = (Date.parse(now.date) - Date.parse(then.date)) / (365.25 * 86400000);
  return years > 0 ? (Math.pow(now.value / then.value, 1 / years) - 1) * 100 : null;
}

// ── the zero-coupon forward return we are trying to predict ───────────

/** Total return of a constant-maturity ~29y zero over `horizonDays`,
 *  proxied by DGS30. Roll-down is included, as it is in the live module. */
function stripForwardReturn(dgs30: Pt[], date: string, horizonDays: number): number | null {
  const y0 = at(dgs30, date);
  const y1 = at(dgs30, daysAgo(date, -horizonDays));
  if (!y0 || !y1 || y1.date <= y0.date) return null;
  const T0 = 29.4;
  const years = (Date.parse(y1.date) - Date.parse(y0.date)) / (365.25 * 86400000);
  const price = (y: number, t: number) => 100 / Math.pow(1 + y / 200, 2 * t);
  const p0 = price(y0.value, T0);
  const p1 = price(y1.value, T0 - years);
  return p0 > 0 ? (p1 / p0 - 1) * 100 : null;
}

// ── the score, reconstructed point-in-time ────────────────────────────

interface Reading {
  date: string;
  score: number;
  valuation: number;
  inflation: number;
  macroProxy: number;
  compat: number;
  veto: 'OFF' | 'WATCH' | 'ACTIVE';
  variant: 'full' | 'reduced';
  realPct: number | null;
  nomPct: number | null;
}

interface Series {
  dgs30: Pt[]; dfii30: Pt[]; dltiit: Pt[]; tp: Pt[];
  core: Pt[]; wti: Pt[]; dgs2: Pt[]; dgs10: Pt[]; unrate: Pt[];
}

function scoreAt(s: Series, date: string, variant: 'full' | 'reduced'): Reading | null {
  const V = T.valuation, I = T.inflation, W = T.veto;

  // The long real yield: DFII30 for the full variant, DLTIIT for the
  // reduced one. NOT interchangeable — DLTIIT is an average maturity.
  const realSeries = variant === 'full' ? s.dfii30 : s.dltiit;
  const real = pctAsOf(realSeries, date);
  const nom = pctAsOf(s.dgs30, date);
  const tp = pctAsOf(s.tp, date);
  if (!real || !nom) return null;

  const bandOf = (pct: number) =>
    pct >= V.real_pct_exceptional ? 1
    : pct >= V.real_pct_attractive ? 0.75
    : pct >= V.real_pct_fair ? 0.375
    : pct >= V.real_pct_poor ? 0.125 : 0;

  let valuation = bandOf(real.pct) * V.real_cap + bandOf(nom.pct) * V.nominal_cap;
  if (tp) {
    valuation += tp.pct >= V.tp_pct_high ? V.tp_cap
      : tp.pct >= V.tp_pct_moderate ? V.tp_cap * 0.6 : 0;
  }

  // Inflation pillar. Breakeven = nominal minus the long real yield.
  const nomNow = at(s.dgs30, date), realNow = at(realSeries, date);
  const beNow = nomNow && realNow ? nomNow.value - realNow.value : null;
  const beThen = (() => {
    const a = at(s.dgs30, daysAgo(date, 91)), b = at(realSeries, daysAgo(date, 91));
    return a && b ? a.value - b.value : null;
  })();
  const be3m = beNow !== null && beThen !== null ? (beNow - beThen) * 100 : null;
  const core3 = annualisedIdx(s.core, date, 3), core12 = annualisedIdx(s.core, date, 12);
  const oilNow = at(s.wti, date), oilThen = at(s.wti, daysAgo(date, 91));
  const oil3m = oilNow && oilThen && oilThen.value > 0
    ? ((oilNow.value - oilThen.value) / oilThen.value) * 100 : null;

  let inflation = 0;
  if (be3m !== null) {
    inflation += be3m >= I.be_rising_bp ? 0 : be3m <= I.be_falling_bp ? I.be_cap : I.be_cap * 0.4;
  }
  if (core3 !== null && core12 !== null) {
    const gap = core3 - core12;
    inflation += gap > 0.3 && core3 >= I.core_hot_pct ? 0
      : gap > 0.3 ? I.core_cap * 0.3
      : gap < -0.3 ? I.core_cap : I.core_cap * 0.55;
  }
  if (oil3m !== null) {
    inflation += oil3m >= I.energy_shock_pct ? 0
      : oil3m <= I.energy_falling_pct ? I.energy_cap : I.energy_cap * 0.5;
  }

  const compat = inflation >= I.compat_full ? 1 : inflation >= I.compat_partial ? 0.5 : 0;

  // MACRO PROXY — not the production pillar. Built from FRED alone: curve
  // inversion recently present, the 2Y rolling over, and unemployment
  // rising from its own 12-month low. Labelled everywhere it appears.
  const c10 = at(s.dgs10, date), c2 = at(s.dgs2, date);
  const curve = c10 && c2 ? (c10.value - c2.value) * 100 : null;
  const inverted12m = (() => {
    let seen = false;
    for (const p of s.dgs10) {
      if (p.date > date) break;
      if (p.date < daysAgo(date, 365)) continue;
      const two = at(s.dgs2, p.date);
      if (two && p.value - two.value < 0) { seen = true; break; }
    }
    return seen;
  })();
  const us2y20 = chgBp(s.dgs2, date, 20);
  const unNow = at(s.unrate, date);
  const unLow = (() => {
    let lo = Infinity;
    for (const p of s.unrate) {
      if (p.date > date) break;
      if (p.date < daysAgo(date, 365)) continue;
      if (p.value < lo) lo = p.value;
    }
    return Number.isFinite(lo) ? lo : null;
  })();
  const unRising = unNow && unLow !== null ? unNow.value - unLow >= 0.4 : false;

  let macroProxy = 0;
  if (inverted12m) macroProxy += 0.6;
  if (unRising) macroProxy += 0.6;
  if (us2y20 !== null && us2y20 <= T.macro.us2y_rollover_bp) macroProxy += 0.3;
  if (curve !== null && curve > 0 && inverted12m) macroProxy += 0.25;  // dis-inverting
  macroProxy = Math.min(macroProxy, T.weights.macro) * compat;

  // Veto, same conditions as production.
  const real3m = chgBp(realSeries, date, 91);
  const bePct = (() => {
    // breakeven percentile needs a breakeven series; build it lazily and
    // cheaply by ranking the last 5 years of daily values
    const vals: number[] = [];
    for (const p of s.dgs30) {
      if (p.date > date) break;
      if (p.date < daysAgo(date, 1826)) continue;
      const r = at(realSeries, p.date);
      if (r) vals.push(p.value - r.value);
    }
    if (vals.length < 250 || beNow === null) return null;
    return (vals.filter((x) => x <= beNow).length / vals.length) * 100;
  })();

  const triggers = [
    be3m !== null && be3m >= W.be_3m_bp && bePct !== null && bePct >= W.be_pct,
    core3 !== null && core12 !== null && core3 > core12 && core3 >= W.core_3m_ann_pct,
    oil3m !== null && oil3m >= W.energy_3m_pct,
    real3m !== null && real3m >= W.real30_3m_bp,
  ].filter(Boolean).length;
  const veto: Reading['veto'] = triggers >= W.active_at ? 'ACTIVE'
    : triggers >= W.watch_at ? 'WATCH' : 'OFF';

  let score = Math.min(5, valuation + macroProxy + inflation);
  if (veto === 'ACTIVE') score = Math.min(score, W.cap_active);
  else if (veto === 'WATCH') score = Math.min(score, W.cap_watch);

  return {
    date, score: Math.round(score * 10) / 10,
    valuation, inflation, macroProxy, compat, veto, variant,
    realPct: real.pct, nomPct: nom.pct,
  };
}

// ── reporting ─────────────────────────────────────────────────────────

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const median = (xs: number[]) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const f = (v: number, dp = 1) => (Number.isFinite(v) ? v.toFixed(dp) : '—');

function bucketTable(rows: { score: number; fwd: number }[], label: string) {
  const buckets: [string, (s: number) => boolean][] = [
    ['0.0-1.9  unfavourable/weak', (s) => s < 2],
    ['2.0-2.9  watch', (s) => s >= 2 && s < 3],
    ['3.0-3.9  setup building', (s) => s >= 3 && s < 4],
    ['4.0-4.4  attractive', (s) => s >= 4 && s < 4.5],
    ['4.5-5.0  exceptional', (s) => s >= 4.5],
  ];
  console.log(`\n  ${label}`);
  console.log('  band                          n     mean fwd    median    % positive    worst');
  for (const [name, test] of buckets) {
    const hit = rows.filter((r) => test(r.score));
    if (!hit.length) { console.log(`  ${name.padEnd(28)} ${'0'.padStart(5)}        —         —            —        —`); continue; }
    const fwd = hit.map((r) => r.fwd);
    const pos = (fwd.filter((x) => x > 0).length / fwd.length) * 100;
    console.log(
      `  ${name.padEnd(28)} ${String(hit.length).padStart(5)}`
      + `  ${f(mean(fwd)).padStart(8)}%  ${f(median(fwd)).padStart(8)}%`
      + `  ${f(pos, 0).padStart(9)}%  ${f(Math.min(...fwd)).padStart(7)}%`,
    );
  }
}

const EPISODES: { label: string; from: string; to: string }[] = [
  { label: '2001 recession', from: '2000-06-01', to: '2002-06-30' },
  { label: '2008 financial crisis', from: '2007-06-01', to: '2009-06-30' },
  { label: '2020 recession', from: '2019-09-01', to: '2020-12-31' },
  { label: '2023-24 disinflation', from: '2023-01-01', to: '2024-12-31' },
];

async function main() {
  // MATCH PRODUCTION'S STORED WINDOW. The first version of this script
  // fetched DGS30 from 1980 and the term premium from 1990, while the live
  // system stores from BACKFILL_START = 2000-01-01 and computes its
  // percentiles on that. The mismatch was not cosmetic: measured against a
  // distribution containing the 10%+ yields of the early eighties, a 5.59%
  // 30Y ranks around the 20th percentile and the valuation pillar scored
  // 0.09 of its 0.70 cap. Measured against 2000+, as production actually
  // does, the same yield is at the 94th percentile and the pillar scores
  // its full 0.70. Production reached 2.00 of 2.00 on 2026-10-01 while
  // this script had concluded the pillar was nearly unreachable.
  //
  // So the harness was testing a weaker instrument than the one that
  // shipped, and every score it produced was too macro-driven. Matching
  // the window is a correction to the TEST, not a tuning of the system —
  // no threshold in config/thresholds.json is touched by it.
  const PROD_START = '2000-01-01';
  console.log(`Fetching FRED history (percentile windows start ${PROD_START}, matching production)…`);
  const [dgs30, dfii30, dltiit, tp, core, wti, dgs2, dgs10, unrate] = await Promise.all([
    fred('DGS30', PROD_START), fred('DFII30', '2010-01-01'), fred('DLTIIT', PROD_START),
    fred('THREEFYTP10', PROD_START), fred('CPILFESL', PROD_START), fred('DCOILWTICO', PROD_START),
    fred('DGS2', PROD_START), fred('DGS10', PROD_START), fred('UNRATE', PROD_START),
  ]);
  const s: Series = { dgs30, dfii30, dltiit, tp, core, wti, dgs2, dgs10, unrate };
  console.log(`  DGS30 ${dgs30[0].date}..${dgs30[dgs30.length - 1].date} (${dgs30.length})`);
  console.log(`  DFII30 ${dfii30[0].date}.. (${dfii30.length})  DLTIIT ${dltiit[0].date}.. (${dltiit.length})`);

  // Monthly sampling: the inputs are slow-moving and daily sampling would
  // overstate the sample size by ~21x without adding independent evidence.
  const sample = (from: string, to: string) => {
    const out: string[] = [];
    for (const p of dgs30) {
      if (p.date < from || p.date > to) continue;
      if (!out.length || p.date.slice(0, 7) !== out[out.length - 1].slice(0, 7)) out.push(p.date);
    }
    return out;
  };

  for (const horizon of [252, 504]) {
    for (const variant of ['full', 'reduced'] as const) {
      const start = variant === 'full' ? '2011-01-01' : '2001-01-01';
      const rows: { date: string; score: number; fwd: number; veto: string }[] = [];
      for (const d of sample(start, daysAgo(dgs30[dgs30.length - 1].date, horizon))) {
        const r = scoreAt(s, d, variant);
        const fwd = stripForwardReturn(dgs30, d, horizon);
        if (r && fwd !== null) rows.push({ date: d, score: r.score, fwd, veto: r.veto });
      }
      bucketTable(rows,
        `${variant === 'full' ? 'FULL score (DFII30, 2011+)' : 'REDUCED variant (DLTIIT, 2001+) — a DIFFERENT, weaker instrument'}`
        + `  ·  ${horizon === 252 ? '1-year' : '2-year'} forward return of a ~29y zero  ·  n=${rows.length} monthly observations`);

      // rank correlation, reported as one number with its sign
      const xs = rows.map((r) => r.score), ys = rows.map((r) => r.fwd);
      const rank = (a: number[]) => {
        const idx = a.map((v, i) => [v, i] as const).sort((p, q) => p[0] - q[0]);
        const out = new Array(a.length).fill(0);
        idx.forEach(([, i], k) => { out[i] = k; });
        return out;
      };
      const rx = rank(xs), ry = rank(ys);
      const mx = mean(rx), my = mean(ry);
      const cov = rx.reduce((acc, v, i) => acc + (v - mx) * (ry[i] - my), 0);
      const sx = Math.sqrt(rx.reduce((a, v) => a + (v - mx) ** 2, 0));
      const sy = Math.sqrt(ry.reduce((a, v) => a + (v - my) ** 2, 0));
      console.log(`  Spearman rank correlation, score vs forward return: ${f(cov / (sx * sy), 2)}`);
    }
  }

  // ── FALSE POSITIVES ─────────────────────────────────────────────────
  // The failure the brief singles out: growth weakened but inflation,
  // fiscal or term-premium pressure kept long yields elevated. Reported in
  // full rather than summarised, because a mean hides exactly this.
  console.log('\n\n══ FALSE POSITIVES — high reading, poor subsequent return ══');
  for (const variant of ['full', 'reduced'] as const) {
    const start = variant === 'full' ? '2011-01-01' : '2001-01-01';
    const bad: { date: string; score: number; fwd: number; veto: string; real: string }[] = [];
    for (const d of sample(start, daysAgo(dgs30[dgs30.length - 1].date, 252))) {
      const r = scoreAt(s, d, variant);
      const fwd = stripForwardReturn(dgs30, d, 252);
      if (r && fwd !== null && r.score >= 3.0 && fwd < 0) {
        bad.push({ date: d, score: r.score, fwd, veto: r.veto, real: f(r.realPct ?? NaN, 0) });
      }
    }
    console.log(`\n  ${variant.toUpperCase()}: ${bad.length} month(s) scored >= 3.0 and lost money over the next year`);
    for (const b of bad.slice(0, 24)) {
      console.log(`    ${b.date}  score ${f(b.score)}  veto ${b.veto.padEnd(6)}  real pct ${b.real.padStart(3)}  forward ${f(b.fwd).padStart(7)}%`);
    }
    if (bad.length > 24) console.log(`    … and ${bad.length - 24} more`);
  }

  // ── the named episodes ──────────────────────────────────────────────
  console.log('\n\n══ EPISODES ══');
  for (const e of EPISODES) {
    const variant = e.from >= '2010-06-01' ? 'full' : 'reduced';
    console.log(`\n  ${e.label}  (${variant} variant)`);
    console.log('  date         score  val   macro*  infl  compat  veto    fwd 1y');
    for (const d of sample(e.from, e.to)) {
      const r = scoreAt(s, d, variant);
      if (!r) { console.log(`  ${d}   — no reading (inputs unavailable)`); continue; }
      const fwd = stripForwardReturn(dgs30, d, 252);
      console.log(
        `  ${d}  ${f(r.score).padStart(5)}  ${f(r.valuation, 2)}  ${f(r.macroProxy, 2).padStart(5)}`
        + `   ${f(r.inflation, 2)}  ${f(r.compat, 1).padStart(5)}   ${r.veto.padEnd(6)}  ${fwd === null ? '   n/a' : `${f(fwd).padStart(6)}%`}`,
      );
    }
  }
  console.log('\n  * macro is a FRED-only PROXY (curve inversion, 2Y rolling over,');
  console.log('    unemployment off its 12-month low), NOT the production macro pillar,');
  console.log('    which consumes Bust Risk, the Credit Canary, the phase model and the');
  console.log('    liquidity card. Treat the macro column as indicative only.');
}

main().catch((e) => { console.error(e); process.exit(1); });
