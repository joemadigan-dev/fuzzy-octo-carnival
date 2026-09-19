// Cockpit persistence: load prior state, compute, store, log transitions.
//
// Kept out of scheduled/index.ts so the cron file stays a pipeline rather
// than an implementation. Runs after the barometer and independently of it.

import type { Point } from '../sources/types.ts';
import { buildCockpit, type Cockpit } from '../scoring/index.ts';
import type { Phase } from '../scoring/phase.ts';
import type { Snapshot } from '../scoring/whatchanged.ts';
import type { Env } from './index.ts';

/** How much snapshot history "What Changed?" needs — a month plus slack. */
const HISTORY_DAYS = 45;
/** Candidate phases inspected for the persistence rule. */
const CANDIDATE_WINDOW = 10;

export async function runCockpit(env: Env, seriesMap: Map<string, Point[]>, nowIso: string): Promise<string[]> {
  const log: string[] = [];
  const today = nowIso.slice(0, 10);

  const rows = await env.DB.prepare(
    `SELECT date, phase, candidate_phase, meltup, bust, credit, credit_stage, liquidity_regime
       FROM cockpit_history WHERE date < ? ORDER BY date DESC LIMIT ?`,
  ).bind(today, HISTORY_DAYS).all<{
    date: string; phase: string | null; candidate_phase: string | null;
    meltup: number | null; bust: number | null; credit: number | null;
    credit_stage: string | null; liquidity_regime: string | null;
  }>();

  const desc = rows.results ?? [];
  const asc = [...desc].reverse();
  const history: Snapshot[] = asc.map((r) => ({
    date: r.date, phase: r.phase, meltup: r.meltup, bust: r.bust,
    credit: r.credit, credit_stage: r.credit_stage, liquidity_regime: r.liquidity_regime,
  }));
  const priorPhase = (desc[0]?.phase ?? null) as Phase | null;
  const candidates = asc.slice(-CANDIDATE_WINDOW)
    .map((r) => r.candidate_phase)
    .filter((p): p is string => Boolean(p)) as Phase[];

  const c = buildCockpit(seriesMap, nowIso, { phase: priorPhase, candidates, history });

  await env.DB.prepare(
    `INSERT INTO cockpit_history
       (date, computed_at, phase, candidate_phase, phase_settled, meltup, bust,
        bust_vulnerability, bust_onset, credit, credit_stage, credit_systemic,
        liquidity_regime, liquidity_level, detail)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(date) DO UPDATE SET
       computed_at=excluded.computed_at, phase=excluded.phase,
       candidate_phase=excluded.candidate_phase, phase_settled=excluded.phase_settled,
       meltup=excluded.meltup, bust=excluded.bust,
       bust_vulnerability=excluded.bust_vulnerability, bust_onset=excluded.bust_onset,
       credit=excluded.credit, credit_stage=excluded.credit_stage,
       credit_systemic=excluded.credit_systemic, liquidity_regime=excluded.liquidity_regime,
       liquidity_level=excluded.liquidity_level, detail=excluded.detail`,
  ).bind(
    today, nowIso, c.phase.phase, c.phase.candidate, c.phase.settled ? 1 : 0,
    c.meltup.score, c.bust.score, c.bust.vulnerability, c.bust.onset,
    c.credit.score, c.credit.stage, c.credit.systemic ? 1 : 0,
    c.liquidity.regime, c.liquidity.level, JSON.stringify(c),
  ).run();

  if (priorPhase && priorPhase !== c.phase.phase) {
    await env.DB.prepare(
      `INSERT INTO phase_changes (date, from_phase, to_phase, held_days, evidence)
       VALUES (?,?,?,?,?) ON CONFLICT(date) DO UPDATE SET
         from_phase=excluded.from_phase, to_phase=excluded.to_phase,
         held_days=excluded.held_days, evidence=excluded.evidence`,
    ).bind(today, priorPhase, c.phase.phase, c.phase.heldDays, JSON.stringify(c.phase.evidence)).run();
    log.push(`cockpit: PHASE ${priorPhase} → ${c.phase.phase} (held ${c.phase.heldDays}d)`);
  }

  log.push(
    `cockpit: ${c.phase.phase}${c.phase.settled ? '' : ` (candidate ${c.phase.candidate}, ${c.phase.heldDays}/${c.phase.persistDays}d)`}`
    + ` · melt-up ${c.meltup.score}/5 · bust ${c.bust.score}/5 (vuln ${c.bust.vulnerability} / onset ${c.bust.onset})`
    + ` · credit ${c.credit.score}/5 ${c.credit.stage} · liquidity ${c.liquidity.regime}`,
  );
  return log;
}

export type { Cockpit };
