// LIQUIDITY / RATES (card 5) and the QE detector — sections 11 and 12.
//
// This card exists to watch for a specific SEQUENCE rather than a level:
//
//   higher rates → credit stress → equity bust → deflation → rate collapse → QE
//
// Hunter expects rates to COLLAPSE during the bust; Noble and Chanos
// identify RISING rates as what breaks it first. Both can be true in
// order, so the module reports which leg of that sequence the data
// currently looks like, and never collapses the two into one reading.
//
// The QE detector's job is the distinction in section 12: routine
// balance-sheet drift is not QE. Only expansion past the configured
// magnitudes counts, and the size is always shown.

import type { Point } from '../sources/types.ts';
import thresholds from '../../config/thresholds.json' with { type: 'json' };
import { change, latest, pctChange, type Level } from './common.ts';

const TR = thresholds.rates;
const TL = thresholds.liquidity;

export type RateLeg =
  | 'RATES RISING — PRESSURE BUILDING'
  | 'RATES COLLAPSING — DEFLATIONARY CONFIRMATION'
  | 'RATES STABLE';

export interface LiquidityResult {
  level: Level;
  regime: 'EXPANDING' | 'NEUTRAL' | 'CONTRACTING' | 'UNKNOWN';
  us10y: number | null;
  us2y: number | null;
  curve: number | null;            // 10y - 2y, bp
  walcl13wPct: number | null;
  walcl13wBn: number | null;
  walcl4wBn: number | null;
  usdTrend: 'UP' | 'DOWN' | 'FLAT' | null;
  creditWord: 'CALM' | 'WIDENING' | 'STRESSED' | null;
  rateLeg: RateLeg;
  /** QE detector — never fires on ordinary drift. */
  qe: { active: boolean; magnitude: string; detail: string };
  notes: string[];
}

export function liquidityCard(m: Map<string, Point[]>): LiquidityResult {
  const us10 = latest(m.get('us10y'))?.value ?? null;
  const us2 = latest(m.get('us2y'))?.value ?? null;
  const walcl = m.get('walcl');
  const walcl13wPct = pctChange(walcl, 91);
  const walcl4w = change(walcl, 28);       // stored in $tn
  const walcl13w = change(walcl, 91);
  const walcl4wBn = walcl4w === null ? null : walcl4w * 1000;
  const walcl13wBn = walcl13w === null ? null : walcl13w * 1000;

  const dxy60 = pctChange(m.get('dxy'), 60);
  const usdTrend = dxy60 === null ? null : dxy60 > 1 ? 'UP' : dxy60 < -1 ? 'DOWN' : 'FLAT';

  const hy = latest(m.get('hy_oas'))?.value ?? null;
  const hyRoc = change(m.get('hy_oas'), 28);
  const creditWord = hy === null ? null
    : hy >= thresholds.credit.hy_caution ? 'STRESSED'
    : (hyRoc !== null && hyRoc * 100 >= thresholds.credit.hy_roc20_bp) ? 'WIDENING'
    : 'CALM';

  // which leg of the sequence do the rates look like?
  const r60 = change(m.get('us10y'), 60);
  const r60bp = r60 === null ? null : r60 * 100;
  let rateLeg: RateLeg = 'RATES STABLE';
  if (r60bp !== null && r60bp <= TR.collapse_60d_bp && creditWord !== 'CALM') {
    rateLeg = 'RATES COLLAPSING — DEFLATIONARY CONFIRMATION';
  } else if (us10 !== null && us10 >= TR.us10y_watch && r60bp !== null && r60bp > 0) {
    rateLeg = 'RATES RISING — PRESSURE BUILDING';
  }

  // QE detector — magnitude-gated, never a verdict on drift alone
  let qe = { active: false, magnitude: 'NONE', detail: 'Balance sheet within ordinary drift — not a liquidity intervention.' };
  if (walcl13wBn !== null) {
    if (walcl13wBn >= TL.walcl_extraordinary_bn) {
      qe = { active: true, magnitude: 'EXTRAORDINARY', detail: `Fed balance sheet +$${(walcl13wBn / 1000).toFixed(2)}tn over 13 weeks — past the $${(TL.walcl_extraordinary_bn / 1000).toFixed(0)}tn extraordinary-expansion threshold.` };
    } else if (walcl13wBn >= TL.walcl_major_qe_bn) {
      qe = { active: true, magnitude: 'MAJOR QE', detail: `Fed balance sheet +$${(walcl13wBn / 1000).toFixed(2)}tn over 13 weeks — past the $${(TL.walcl_major_qe_bn / 1000).toFixed(0)}tn major-response threshold.` };
    } else if (walcl13wBn >= TL.walcl_qe_13w_bn) {
      qe = { active: true, magnitude: 'INTERVENTION', detail: `Fed balance sheet +$${walcl13wBn.toFixed(0)}bn over 13 weeks — past the $${TL.walcl_qe_13w_bn}bn intervention threshold.` };
    } else if (walcl4wBn !== null && walcl4wBn >= TL.walcl_qe_4w_bn) {
      qe = { active: true, magnitude: 'FAST EXPANSION', detail: `Fed balance sheet +$${walcl4wBn.toFixed(0)}bn in four weeks — a fast expansion, below the 13-week intervention threshold.` };
    } else if (walcl13wBn <= TL.walcl_qt_13w_bn) {
      qe = { active: false, magnitude: 'CONTRACTING', detail: `Fed balance sheet $${walcl13wBn.toFixed(0)}bn over 13 weeks — actively draining.` };
    }
  }

  const regime: LiquidityResult['regime'] =
    walcl13wBn === null ? 'UNKNOWN'
    : walcl13wBn >= TL.walcl_qe_13w_bn ? 'EXPANDING'
    : walcl13wBn <= TL.walcl_qt_13w_bn ? 'CONTRACTING'
    : 'NEUTRAL';

  const notes: string[] = [];
  if (us10 !== null && us10 >= TR.us10y_critical) notes.push(`10Y at ${us10.toFixed(2)}% is past the ${TR.us10y_critical}% critical mark.`);
  else if (us10 !== null && us10 >= TR.us10y_warning) notes.push(`10Y at ${us10.toFixed(2)}% is past the ${TR.us10y_warning}% warning mark.`);
  else if (us10 !== null && us10 >= TR.us10y_watch) notes.push(`10Y at ${us10.toFixed(2)}% is past the ${TR.us10y_watch}% watch mark.`);
  if (us2 !== null && us10 !== null) {
    const c = (us10 - us2) * 100;
    notes.push(c < 0 ? `Curve inverted ${c.toFixed(0)}bp.` : `Curve +${c.toFixed(0)}bp.`);
  }
  if (qe.active) notes.push(qe.detail);

  const level: Level =
    rateLeg !== 'RATES STABLE' && creditWord === 'STRESSED' ? 'STRESS'
    : creditWord === 'WIDENING' || rateLeg === 'RATES RISING — PRESSURE BUILDING' ? 'ELEVATED'
    : regime === 'CONTRACTING' ? 'WATCH'
    : 'NORMAL';

  return {
    level, regime, us10y: us10, us2y: us2,
    curve: us10 !== null && us2 !== null ? Math.round((us10 - us2) * 100 * 10) / 10 : null,
    walcl13wPct, walcl13wBn, walcl4wBn, usdTrend, creditWord, rateLeg, qe, notes,
  };
}
