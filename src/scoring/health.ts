// SYSTEM HEALTH — section 5.
//
// The failure this exists to prevent is the one that has already happened
// twice: part of the system stops updating and the page goes on looking
// authoritative. A stale reading rendered confidently is worse than no
// reading, because it cannot be told apart from a quiet market.
//
// Deliberately small — a chip beside the timestamp, not a sixth card.

import { KPIS } from '../registry/kpis.ts';
import type { Point } from '../sources/types.ts';
import { defaultStaleDays } from '../registry/kpis.ts';

export type HealthState = 'GREEN' | 'AMBER' | 'RED';

export interface Health {
  state: HealthState;
  /** One line, shown collapsed. */
  summary: string;
  lastRun: string | null;
  lastCockpit: string | null;
  lastBarometer: string | null;
  kpisOk: number;
  kpisStale: number;
  kpisFailed: number;
  /** Series the scores actually depend on that are stale or missing. */
  criticalStale: string[];
  lastFailedStage: string | null;
  runCompleted: boolean;
  hoursSinceRun: number | null;
  notes: string[];
}

/** Series whose absence or staleness invalidates a headline score, as
 *  opposed to degrading a detail panel. */
const CRITICAL = ['spx', 'hy_oas', 'us10y', 'vix', 'walcl'];

export interface HealthInput {
  nowIso: string;
  lastRun: string | null;
  lastCockpit: string | null;
  lastBarometer: string | null;
  runCompleted: boolean;
  lastFailedStage: string | null;
  seriesMap: Map<string, Point[]>;
  fetchFailed: string[];
}

export function systemHealth(i: HealthInput): Health {
  const today = i.nowIso.slice(0, 10);
  const notes: string[] = [];
  let ok = 0, stale = 0, failed = 0;
  const criticalStale: string[] = [];

  for (const def of KPIS) {
    const pts = i.seriesMap.get(def.id);
    if (!pts?.length) {
      failed++;
      if (CRITICAL.includes(def.id)) criticalStale.push(`${def.label} (no data)`);
      continue;
    }
    const last = pts[pts.length - 1].date;
    const ageDays = Math.floor((Date.parse(today + 'T00:00:00Z') - Date.parse(last + 'T00:00:00Z')) / 86400000);
    if (ageDays > defaultStaleDays(def)) {
      stale++;
      if (CRITICAL.includes(def.id)) criticalStale.push(`${def.label} (${ageDays}d old)`);
    } else ok++;
  }
  failed += i.fetchFailed.length;

  const hoursSinceRun = i.lastRun
    ? (Date.parse(i.nowIso) - Date.parse(i.lastRun)) / 3600000 : null;
  const cockpitAgeH = i.lastCockpit
    ? (Date.parse(i.nowIso) - Date.parse(i.lastCockpit)) / 3600000 : null;

  // RED: the cockpit itself is unavailable or stale, critical data is
  // stale, or the cron has not completed in a long while.
  let state: HealthState = 'GREEN';
  if (cockpitAgeH === null) { state = 'RED'; notes.push('Cockpit has never been computed.'); }
  else if (cockpitAgeH > 26) { state = 'RED'; notes.push(`Cockpit last computed ${cockpitAgeH.toFixed(0)}h ago.`); }
  if (criticalStale.length) { state = 'RED'; notes.push(`Critical data stale: ${criticalStale.join(', ')}.`); }
  if (hoursSinceRun !== null && hoursSinceRun > 26) { state = 'RED'; notes.push(`No completed scheduled run for ${hoursSinceRun.toFixed(0)}h.`); }

  // AMBER: something is degraded but the headline readings still stand.
  if (state === 'GREEN') {
    if (!i.runCompleted) { state = 'AMBER'; notes.push(`The last scheduled run did not finish${i.lastFailedStage ? ` — stopped after ${i.lastFailedStage}` : ''}.`); }
    else if (i.lastFailedStage) { state = 'AMBER'; notes.push(`Isolated stage failure: ${i.lastFailedStage}.`); }
    else if (stale > 0) { state = 'AMBER'; notes.push(`${stale} non-critical source${stale > 1 ? 's' : ''} stale.`); }
    else if (failed > 0) { state = 'AMBER'; notes.push(`${failed} source${failed > 1 ? 's' : ''} failed to refresh.`); }
    else if (hoursSinceRun !== null && hoursSinceRun > 10) { state = 'AMBER'; notes.push(`Last completed run ${hoursSinceRun.toFixed(0)}h ago.`); }
  }

  const summary = state === 'GREEN'
    ? 'All sources fresh, last scheduled run completed.'
    : notes[0] ?? 'Degraded.';

  return {
    state, summary,
    lastRun: i.lastRun, lastCockpit: i.lastCockpit, lastBarometer: i.lastBarometer,
    kpisOk: ok, kpisStale: stale, kpisFailed: failed,
    criticalStale, lastFailedStage: i.lastFailedStage,
    runCompleted: i.runCompleted, hoursSinceRun: hoursSinceRun === null ? null : Math.round(hoursSinceRun * 10) / 10,
    notes,
  };
}
