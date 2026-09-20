// Signal history and transition timestamps.
//
// The question this answers is not "what is the reading today" — the
// cockpit already answers that — but "is it moving". A 3.0 that has been
// 3.0 for a month and a 3.0 that was 2.0 last week are different facts,
// and only the second one is news.
//
// TRANSITIONS ARE ON THE BAND, NOT THE NUMBER. A score drifting 2.9 → 3.1
// is not a transition; crossing from WATCH into ELEVATED is. Otherwise
// every rounding wobble would reset the "since" date and the panel would
// report constant change, which is precisely the noise this is meant to
// cut through.
//
// WHERE HISTORY RUNS OUT, SAY SO. If the oldest row we hold is already in
// the current state, the true transition happened before tracking began
// and we do not know when. That is reported as SINCE TRACKING BEGAN
// rather than quietly presenting the first stored date as if it were the
// change date — which would be a fabricated fact, and a very plausible
// looking one.

import { levelOf } from './common.ts';

export interface SignalPoint {
  date: string;
  /** Banded state — what transitions are measured on. */
  state: string | null;
  /** Underlying number where the signal has one. */
  value: number | null;
}

export interface SignalSeries {
  id: string;
  label: string;
  /** 'score' renders as a 0-5 line; 'state' as a band ribbon. */
  kind: 'score' | 'state';
  points: SignalPoint[];
  current: string | null;
  currentValue: number | null;
  /** Date the current state began, or null when unknown. */
  since: string | null;
  /** True when the oldest row we hold is already in the current state, so
   *  the real transition predates our history. */
  sinceTrackingBegan: boolean;
  /** The state immediately before the current one, when we saw it change. */
  previous: string | null;
  /** How many days the current state has held, where known. */
  heldDays: number | null;
}

/** Rows as stored, oldest first. */
export interface CockpitRow {
  date: string;
  phase: string | null;
  meltup: number | null;
  bust: number | null;
  bust_onset: number | null;
  credit: number | null;
  credit_stage: string | null;
  liquidity_regime: string | null;
  liquidity_level: string | null;
}

export interface AiRow {
  date: string;
  score: number | null;
  status: string | null;
  /** JSON blob; the transmission status is read out of it. */
  transmission: string | null;
  hunter_link: string | null;
}

const transmissionOf = (raw: string | null): string | null => {
  if (!raw) return null;
  try {
    const j = JSON.parse(raw) as { status?: string };
    return j.status ?? null;
  } catch {
    return null;
  }
};

/** Walk a series backwards to find where the current state began.
 *
 *  Deliberately tolerant of gaps: a missing day does not end a run, since
 *  a skipped cron is an operational fact about us and not a change in the
 *  world. Only an observed DIFFERENT state ends one. */
function transition(points: SignalPoint[]): Pick<SignalSeries, 'since' | 'sinceTrackingBegan' | 'previous' | 'heldDays'> {
  const seen = points.filter((p) => p.state !== null);
  if (!seen.length) {
    return { since: null, sinceTrackingBegan: false, previous: null, heldDays: null };
  }
  const current = seen[seen.length - 1].state;
  let i = seen.length - 1;
  while (i > 0 && seen[i - 1].state === current) i--;

  if (i === 0) {
    // The oldest reading we hold is already in this state — the change,
    // if there was one, happened before we were looking.
    const first = seen[0].date;
    const held = Math.round((Date.parse(seen[seen.length - 1].date) - Date.parse(first)) / 86400000);
    return { since: first, sinceTrackingBegan: true, previous: null, heldDays: held >= 0 ? held : null };
  }
  const since = seen[i].date;
  const held = Math.round((Date.parse(seen[seen.length - 1].date) - Date.parse(since)) / 86400000);
  return { since, sinceTrackingBegan: false, previous: seen[i - 1].state, heldDays: held >= 0 ? held : null };
}

function series(
  id: string, label: string, kind: SignalSeries['kind'], points: SignalPoint[],
): SignalSeries {
  const last = [...points].reverse().find((p) => p.state !== null) ?? null;
  return {
    id, label, kind, points,
    current: last?.state ?? null,
    currentValue: last?.value ?? null,
    ...transition(points),
  };
}

/** Bands for the 0-5 scores, reusing the cockpit's own vocabulary so the
 *  history cannot disagree with the card above it. */
const band = (v: number | null): string | null => (v === null ? null : levelOf(v));

export function buildSignalHistory(cockpit: CockpitRow[], ai: AiRow[]): SignalSeries[] {
  const aiByDate = new Map(ai.map((r) => [r.date, r]));
  // One date axis: every date either table has a row for.
  const dates = [...new Set([...cockpit.map((r) => r.date), ...ai.map((r) => r.date)])].sort();
  const cByDate = new Map(cockpit.map((r) => [r.date, r]));

  const pick = (fn: (c: CockpitRow | undefined, a: AiRow | undefined) => SignalPoint): SignalPoint[] =>
    dates.map((d) => fn(cByDate.get(d), aiByDate.get(d)));

  return [
    series('phase', 'Market Regime', 'state',
      pick((c) => ({ date: c?.date ?? '', state: c?.phase ?? null, value: null }))),
    series('meltup', 'Melt-Up Score', 'score',
      pick((c) => ({ date: c?.date ?? '', state: band(c?.meltup ?? null), value: c?.meltup ?? null }))),
    series('bust', 'Bust Risk', 'score',
      pick((c) => ({ date: c?.date ?? '', state: band(c?.bust ?? null), value: c?.bust ?? null }))),
    series('bust_onset', 'Bust Onset', 'score',
      pick((c) => ({ date: c?.date ?? '', state: band(c?.bust_onset ?? null), value: c?.bust_onset ?? null }))),
    series('credit', 'Credit Canary', 'score',
      pick((c) => ({ date: c?.date ?? '', state: c?.credit_stage ?? band(c?.credit ?? null), value: c?.credit ?? null }))),
    series('liquidity', 'Liquidity / Rates', 'state',
      pick((c) => ({ date: c?.date ?? '', state: c?.liquidity_regime ?? null, value: null }))),
    series('ai_capital', 'AI Capital Stress', 'score',
      pick((_c, a) => ({ date: a?.date ?? '', state: a?.status ?? null, value: a?.score ?? null }))),
    series('ai_transmission', 'AI → Credit Transmission', 'state',
      pick((_c, a) => ({ date: a?.date ?? '', state: transmissionOf(a?.transmission ?? null), value: null }))),
    series('hunter_ai', 'Hunter × AI Capital', 'state',
      pick((_c, a) => ({ date: a?.date ?? '', state: a?.hunter_link ?? null, value: null }))),
  ].map((s) => ({ ...s, points: s.points.filter((p) => p.date !== '') }));
}

/** Human form of the since line, including the honest fallback. */
export function sinceLabel(s: SignalSeries): string {
  if (!s.since) return 'No history yet';
  if (s.sinceTrackingBegan) return 'Since tracking began';
  const d = new Date(s.since + 'T00:00:00Z');
  const month = d.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' });
  return `Since ${d.getUTCDate()} ${month} ${d.getUTCFullYear()}`;
}
