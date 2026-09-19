// Assembles the executive cockpit — sections 2, 3, 5 and 27.
//
// Everything the first screen needs, computed here in the cron and served
// as a finished object. The request path does no arithmetic.

import type { Point } from '../sources/types.ts';
import targets from '../../config/hunter_targets.json' with { type: 'json' };
import thresholds from '../../config/thresholds.json' with { type: 'json' };
import { drawdown, latest, pctChange, type Level } from './common.ts';
import { meltupScore, targetProximity } from './meltup.ts';
import { creditCanary, type CreditResult } from './credit.ts';
import { bustRisk, type BustResult } from './bust.ts';
import { liquidityCard, type LiquidityResult } from './liquidity.ts';
import { classify, settle, PERSIST_DAYS, type Phase, type PhaseResult } from './phase.ts';
import { whatChanged, type Change, type Horizon, type Snapshot } from './whatchanged.ts';
import { marketSetup, type Setup } from './setup.ts';
import { asPercent } from './units.ts';
import type { Score } from './common.ts';

export interface TargetRow {
  id: string; label: string; target: number;
  current: number | null; asOf: string | null;
  distancePct: number | null;
  change1m: number | null; change6m: number | null;
  drawdownFromPeak: number | null;
  status: 'THROUGH TARGET' | 'IMMINENT' | 'CLOSE' | 'APPROACHING' | 'DISTANT' | 'NO DATA';
}

export interface Cockpit {
  computedAt: string;
  asOf: string | null;
  phase: PhaseResult;
  meltup: Score;
  bust: BustResult;
  credit: CreditResult;
  liquidity: LiquidityResult;
  targets: TargetRow[];
  /** One deterministic sentence built from the readings above it. */
  setup: Setup;
  whatChanged: Record<Horizon, Change[]>;
  commodities: { id: string; label: string; r6m: number | null; vsSpx: number | null; leading: boolean }[];
  snapshot: Snapshot;
}

const TARGET_MAP: [string, string, number][] = [
  ['spx', targets.meltup.sp500.label, targets.meltup.sp500.target],
  ['dow', targets.meltup.dow.label, targets.meltup.dow.target],
  ['nasdaq', targets.meltup.nasdaq.label, targets.meltup.nasdaq.target],
  ['rut', targets.meltup.russell2000.label, targets.meltup.russell2000.target],
  ['gold', targets.meltup.gold.label, targets.meltup.gold.target],
  ['silver', targets.meltup.silver.label, targets.meltup.silver.target],
  ['gdx', targets.meltup.gdx.label, targets.meltup.gdx.target],
  ['smh', targets.meltup.smh.label, targets.meltup.smh.target],
];

function targetRows(m: Map<string, Point[]>): TargetRow[] {
  const T = thresholds.meltup;
  return TARGET_MAP.map(([id, label, target]) => {
    const l = latest(m.get(id));
    const distancePct = l && l.value > 0 ? ((target - l.value) / l.value) * 100 : null;
    const status: TargetRow['status'] =
      distancePct === null ? 'NO DATA'
      : distancePct < 0 ? 'THROUGH TARGET'
      : distancePct <= T.target_imminent_pct ? 'IMMINENT'
      : distancePct <= T.target_close_pct ? 'CLOSE'
      : distancePct <= T.target_within_pct ? 'APPROACHING'
      : 'DISTANT';
    return {
      id, label, target,
      current: l?.value ?? null,
      asOf: l?.date ?? null,
      distancePct,
      change1m: pctChange(m.get(id), 30),
      change6m: pctChange(m.get(id), 182),
      drawdownFromPeak: drawdown(m.get(id), 365),
      status,
    };
  });
}

function commodityLeadership(m: Map<string, Point[]>) {
  const spx6 = pctChange(m.get('spx'), 182);
  const out = [['gold', 'Gold'], ['silver', 'Silver'], ['copper', 'Copper'], ['wti', 'WTI Oil']]
    .map(([id, label]) => {
      const r6m = pctChange(m.get(id), 182);
      const vsSpx = r6m === null || spx6 === null ? null : r6m - spx6;
      return { id, label, r6m, vsSpx, leading: vsSpx !== null && vsSpx >= thresholds.commodities.outperformance_6m_pct };
    });
  return out;
}

export function buildCockpit(
  m: Map<string, Point[]>,
  nowIso: string,
  prior: { phase: Phase | null; candidates: Phase[]; history: Snapshot[] },
): Cockpit {
  const today = nowIso.slice(0, 10);
  const meltup = meltupScore(m);
  const credit = creditCanary(m);
  const bust = bustRisk(m, credit);
  const liquidity = liquidityCard(m);
  const commodities = commodityLeadership(m);

  const ret6m = pctChange(m.get('spx'), 182);
  const dd = drawdown(m.get('spx'), 365);

  const c = classify({
    ret6m, drawdown: dd, meltup: meltup.score, credit, bust, liquidity,
    commodityLeadership: commodities.filter((x) => x.leading).length,
  });
  const s = settle(c.phase, prior.phase, prior.candidates);
  const phase: PhaseResult = {
    ...s, candidate: c.phase, persistDays: PERSIST_DAYS,
    explanation: c.explanation, evidence: c.evidence,
  };

  const mcap = latest(m.get('eq_gdp'));
  const setup = marketSetup({
    phase, meltup, bust, credit, liquidity,
    ret6m, ret3mPace: (() => { const r3 = pctChange(m.get('spx'), 91); return r3 === null ? null : r3 * 2; })(),
    drawdown: dd,
    valuationPct: mcap ? asPercent('eq_gdp', mcap.value) : null,
    erp: latest(m.get('erp'))?.value ?? null,
    commoditiesLeading: commodities.filter((x) => x.leading).length,
  });

  const snapshot: Snapshot = {
    date: today,
    phase: phase.phase,
    meltup: meltup.score,
    bust: bust.score,
    credit: credit.score,
    credit_stage: credit.stage,
    liquidity_regime: liquidity.regime,
  };

  const asOf = latest(m.get('spx'))?.date ?? null;

  return {
    computedAt: nowIso, asOf, phase, meltup, bust, credit, liquidity,
    targets: targetRows(m), setup,
    whatChanged: whatChanged(m, snapshot, prior.history),
    commodities,
    snapshot,
  };
}

export type { Change, Horizon, Snapshot, Level, Phase };
