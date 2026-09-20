// Quarterly fundamentals in "What Changed?".
//
// THE NOISE PROBLEM this is built around: a 10-Q lands once a quarter and
// then sits unchanged for three months. A naive implementation would
// re-announce the same capex figure every single day, which would bury the
// macro moves the list exists to surface and teach the reader to ignore it.
//
// So nothing here fires on the presence of a filing. Everything fires on a
// MODEL READING MOVING: the score changing by a material step, a company
// crossing a named threshold, the supplier signal changing state, the
// transmission map changing status. The comparison is against yesterday's
// stored snapshot, so an unchanged quarter produces nothing at all —
// on the day of the filing it produces a lot, which is exactly right.

import thresholds from '../../config/thresholds.json' with { type: 'json' };
import { KIND_WEIGHT, type Change, type Horizon } from './whatchanged.ts';
import type { AiCapitalView } from '../scheduled/ai-capital-view.ts';
import type { Env } from '../scheduled/index.ts';

const T = thresholds.ai_whatchanged;

/** What yesterday's row holds, in the compact shape saveAiCapital writes. */
interface PriorCompany { t: string; p: string | null; cr: number | null; co: number | null; io: number | null; nd: number | null }
interface Prior {
  score: number | null;
  status: string | null;
  transmission: string | null;
  hunter: string | null;
  supplier: string | null;
  companies: Map<string, PriorCompany>;
}

async function loadPrior(env: Env, today: string): Promise<Prior | null> {
  const row = await env.DB.prepare(
    `SELECT score, status, transmission, hunter_link, detail
       FROM ai_capital_history WHERE date < ? ORDER BY date DESC LIMIT 1`,
  ).bind(today).first<{ score: number | null; status: string | null; transmission: string | null; hunter_link: string | null; detail: string | null }>();
  if (!row) return null;
  let transmission: string | null = null;
  let supplier: string | null = null;
  const companies = new Map<string, PriorCompany>();
  try { transmission = row.transmission ? (JSON.parse(row.transmission).status ?? null) : null; } catch { /* keep null */ }
  try {
    const d = row.detail ? JSON.parse(row.detail) : null;
    supplier = d?.supplier?.state ?? null;
    for (const c of d?.companies ?? []) companies.set(c.t, c);
  } catch { /* keep empty */ }
  return { score: row.score, status: row.status, transmission, hunter: row.hunter_link, supplier, companies };
}

const HORIZONS: Horizon[] = ['day'];

/** A fundamental change is a THRESHOLD crossing in the model's terms, so it
 *  ranks with the macro threshold crossings rather than below them — a
 *  company moving into financing stress is not a smaller event than a
 *  spread crossing a level. */
export async function aiCapitalChanges(env: Env, view: AiCapitalView, today: string): Promise<Change[]> {
  const prior = await loadPrior(env, today);
  if (!prior) return [];          // first day: nothing to compare against
  const out: Change[] = [];
  const h: Horizon = HORIZONS[0];
  const pct = (v: number | null) => (v === null ? '—' : `${(v * 100).toFixed(0)}%`);
  const x = (v: number | null) => (v === null ? '—' : `${v.toFixed(2)}x`);

  // 1. the score itself moving a material step
  if (prior.score !== null && Math.abs(view.score.score - prior.score) >= T.score_move) {
    const dir = view.score.score > prior.score ? 'rose' : 'fell';
    out.push({
      horizon: h, weight: KIND_WEIGHT.score + 8, kind: 'score',
      headline: `AI Capital Stress ${dir} ${prior.score.toFixed(1)} → ${view.score.score.toFixed(1)}`,
      detail: `${view.score.status}, evidence ${view.score.evidenceAvailable}/${view.score.evidenceTotal}. `
        + view.score.components.filter((c) => c.delta > 0).map((c) => c.reason.split('.')[0]).slice(0, 2).join('. '),
    });
  }
  // 2. status band change
  if (prior.status && prior.status !== view.score.status) {
    out.push({
      horizon: h, weight: KIND_WEIGHT.stage, kind: 'stage',
      headline: `AI Capital Stress: ${prior.status} → ${view.score.status}`,
      detail: `Now ${view.score.score.toFixed(1)}/5 on ${view.score.evidenceAvailable}/${view.score.evidenceTotal} components.`,
    });
  }
  // 3. transmission status change — the one that matters most, because it
  //    is the difference between a capital observation and a credit event
  if (prior.transmission && prior.transmission !== view.transmission.status) {
    out.push({
      horizon: h, weight: KIND_WEIGHT.regime, kind: 'regime',
      headline: `AI → credit transmission: ${prior.transmission} → ${view.transmission.status}`,
      detail: view.transmission.explanation,
    });
  }
  // 4. supplier signal state change
  if (prior.supplier && prior.supplier !== view.supplier.state) {
    out.push({
      horizon: h, weight: KIND_WEIGHT.stage - 2, kind: 'stage',
      headline: `Supplier signal: ${prior.supplier} → ${view.supplier.state}`,
      detail: view.supplier.explanation,
    });
  }
  // 5. Hunter × AI state change
  if (prior.hunter && prior.hunter !== view.hunter.state) {
    out.push({
      horizon: h, weight: KIND_WEIGHT.regime - 4, kind: 'regime',
      headline: `Hunter × AI Capital: ${prior.hunter} → ${view.hunter.state}`,
      detail: view.hunter.explanation,
    });
  }

  // 6. per-company threshold crossings. Only crossings — a company sitting
  //    above a threshold for a quarter is reported once, when it crosses.
  for (const c of view.companies) {
    const p = prior.companies.get(c.ticker);
    if (!p) continue;
    const crossed = (now: number | null, was: number | null, level: number) =>
      now !== null && was !== null && (now >= level) !== (was >= level);

    if (crossed(c.capexToOcf, p.co, T.capex_ocf_cross)) {
      const up = (c.capexToOcf ?? 0) >= T.capex_ocf_cross;
      out.push({
        horizon: h, weight: KIND_WEIGHT.threshold, kind: 'threshold',
        headline: `${c.ticker} capex ${up ? 'now exceeds' : 'no longer exceeds'} operating cash flow`,
        detail: `Capex / OCF ${pct(p.co)} → ${pct(c.capexToOcf)} as of ${c.periodEnd}. `
          + (up ? 'Spending beyond the cash the business generates has to be funded from the balance sheet or from lenders.'
                : 'The build-out is once again covered by operating cash flow.'),
      });
    }
    if (crossed(c.netDebtToOcf, p.nd, T.net_debt_ocf_cross)) {
      const up = (c.netDebtToOcf ?? 0) >= T.net_debt_ocf_cross;
      out.push({
        horizon: h, weight: KIND_WEIGHT.threshold + 4, kind: 'threshold',
        headline: `${c.ticker} leverage moved ${up ? 'into' : 'out of'} financing stress`,
        detail: `Net debt / OCF ${x(p.nd)} → ${x(c.netDebtToOcf)} as of ${c.periodEnd}. `
          + 'Borrowed money funding the build-out is the mechanism by which a capital-spending problem becomes a credit problem.',
      });
    }
    if (crossed(c.incrOpincOnCapital, p.io, T.incr_return_cross)) {
      const down = (c.incrOpincOnCapital ?? 1) < T.incr_return_cross;
      out.push({
        horizon: h, weight: KIND_WEIGHT.threshold, kind: 'threshold',
        headline: `${c.ticker} incremental return on capital ${down ? 'fell below' : 'recovered above'} ${(T.incr_return_cross * 100).toFixed(0)}%`,
        detail: `Incremental operating income per additional dollar of capital ${pct(p.io)} → ${pct(c.incrOpincOnCapital)} as of ${c.periodEnd}.`
          + (down ? ' Below any plausible cost of that capital.' : ''),
      });
    }
    // A genuinely new quarter for this company is itself worth one line —
    // once, on the day it lands, and only when it actually changed.
    if (p.p && c.periodEnd && p.p !== c.periodEnd) {
      out.push({
        horizon: h, weight: KIND_WEIGHT.threshold - 6, kind: 'threshold',
        headline: `${c.ticker} filed a new quarter (${c.periodEnd})`,
        detail: `${c.form ?? 'filing'} filed ${c.filed ?? '—'}: capex ${pct(c.capexToRevenue)} of revenue, `
          + `${pct(c.capexToOcf)} of operating cash flow, incremental return ${pct(c.incrOpincOnCapital)}.`,
      });
    }
  }
  return out;
}
