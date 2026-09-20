// Cockpit persistence: load prior state, compute, store, log transitions.
//
// Kept out of scheduled/index.ts so the cron file stays a pipeline rather
// than an implementation. Runs after the barometer and independently of it.

import type { Point } from '../sources/types.ts';
import { buildCockpit, type Cockpit } from '../scoring/index.ts';
import { systemHealth } from '../scoring/health.ts';
import type { Phase } from '../scoring/phase.ts';
import type { Snapshot } from '../scoring/whatchanged.ts';
import { buildAiCapital, saveAiCapital, type AiCapitalView } from './aicapital.ts';
import { aiCapitalChanges } from '../scoring/aichanged.ts';
import type { Env } from './index.ts';

/** How much snapshot history "What Changed?" needs — a month plus slack. */
const HISTORY_DAYS = 45;
/** Candidate phases inspected for the persistence rule. */
const CANDIDATE_WINDOW = 10;

export interface CockpitOpts {
  runCompleted: boolean;
  lastFailedStage: string | null;
  fetchFailed: string[];
  lastRun: string | null;
  lastBarometer: string | null;
}

export async function runCockpit(
  env: Env, seriesMap: Map<string, Point[]>, nowIso: string, opts: CockpitOpts,
): Promise<string[]> {
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

  // Health is assembled here because this is where the run's own outcome
  // and the loaded series are both in hand. It rides the cockpit payload
  // rather than needing its own table or request.
  // ── V2: AI CAPITAL ───────────────────────────────────────────────────
  // Built here so it rides the cockpit payload rather than needing its own
  // request, and inside its own try so that a fault in the newest part of
  // the system cannot take down the five cards that were working before it
  // existed.
  let ai: AiCapitalView | null = null;
  try {
    ai = await buildAiCapital(env, seriesMap, nowIso, {
      meltup: c.meltup.score,
      credit: c.credit.score,
      bustOnset: c.bust.onset,
      liquidityRegime: c.liquidity.regime,
    });
    if (ai) {
      await saveAiCapital(env, ai, today);
      log.push(`ai capital: ${ai.score.score}/5 ${ai.score.status} · transmission ${ai.transmission.status}`
        + ` · supplier ${ai.supplier.state} · hunter ${ai.hunter.state}`);
    } else {
      log.push('ai capital: no company filings stored yet — panel reports UNKNOWN');
    }
  } catch (e) {
    log.push(`ai capital: FAILED — ${e}`);
  }

  // Quarterly fundamentals only enter "What Changed?" when the MODEL
  // moves. An unchanged filing must not generate an entry every day.
  let aiChanges: Awaited<ReturnType<typeof aiCapitalChanges>> = [];
  if (ai) {
    try {
      aiChanges = await aiCapitalChanges(env, ai, today);
      if (aiChanges.length) log.push(`ai capital: ${aiChanges.length} fundamental change(s) ranked into What Changed`);
    } catch (e) {
      log.push(`ai capital changes: FAILED — ${e}`);
    }
  }

  const health = systemHealth({
    nowIso,
    lastRun: opts.lastRun,
    lastCockpit: nowIso,
    lastBarometer: opts.lastBarometer,
    runCompleted: opts.runCompleted,
    lastFailedStage: opts.lastFailedStage,
    seriesMap,
    fetchFailed: opts.fetchFailed,
    ai: ai ? {
      ingested: ai.coverage.ingested, total: ai.coverage.total,
      latestFiled: ai.coverage.latestFiled, ageDays: ai.ageDays,
      evidenceAvailable: ai.score.evidenceAvailable, evidenceTotal: ai.score.evidenceTotal,
      status: ai.score.status,
    } : null,
  });

  // The AI fundamentals ride the existing What Changed structure rather
  // than getting a panel of their own, so one list still answers "what
  // moved?" across macro and fundamentals alike.
  if (aiChanges.length) {
    for (const horizon of ['day', 'week', 'month'] as const) {
      c.whatChanged[horizon] = [...aiChanges, ...(c.whatChanged[horizon] ?? [])]
        .sort((a, b) => b.weight - a.weight).slice(0, 8);
    }
  }
  const payload = { ...c, health, aiCapital: ai };

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
    c.liquidity.regime, c.liquidity.level, JSON.stringify(payload),
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

  log.push(`cockpit health: ${health.state} — ${health.summary}`);
  log.push(
    `cockpit: ${c.phase.phase}${c.phase.settled ? '' : ` (candidate ${c.phase.candidate}, ${c.phase.heldDays}/${c.phase.persistDays}d)`}`
    + ` · melt-up ${c.meltup.score}/5 · bust ${c.bust.score}/5 (vuln ${c.bust.vulnerability} / onset ${c.bust.onset})`
    + ` · credit ${c.credit.score}/5 ${c.credit.stage} · liquidity ${c.liquidity.regime}`,
  );
  return log;
}

export type { Cockpit };
