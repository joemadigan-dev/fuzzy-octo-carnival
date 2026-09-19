// CREDIT CANARY (0-5) — section 8.
//
// The point of this module is the distinction the brief calls extremely
// important: is stress ISOLATED or SYSTEMIC? Broad high-yield spreads stay
// calm until late, so watching them alone means finding out last. The
// ladder runs speculative → BB/B → investment grade, and the stage is set
// by HOW FAR UP that ladder stress has travelled, not by any single level.
//
// Rate of change carries equal weight to level throughout: a move from
// 2.7% to 3.7% is more informative than a static 4.0%.
//
// DATA LIMIT, stated here and on the page: FRED licenses the ICE BofA tier
// indices on a rolling ~3-year window, so CCC/BB/IG history begins around
// 2023. The ladder cannot be backtested through 2008 or 2020.

import type { Point } from '../sources/types.ts';
import thresholds from '../../config/thresholds.json' with { type: 'json' };
import { bp, build, change, latest, noData, type Component, type Score } from './common.ts';

const T = thresholds.credit;

export const STAGES = [
  'CALM',
  'ISOLATED STRESS',
  'SPECULATIVE CREDIT DETERIORATING',
  'CREDIT CONTAGION',
  'FUNDING SHOCK',
  'SYSTEMIC CREDIT EVENT',
] as const;
export type CreditStage = (typeof STAGES)[number];

export interface CreditResult extends Score {
  stage: CreditStage;
  /** Which rungs of the ladder are currently widening. */
  ladder: { tier: string; level: number | null; roc20: number | null; widening: boolean | null }[];
  /** The headline distinction: has stress reached investment grade? */
  systemic: boolean;
}

export function creditCanary(m: Map<string, Point[]>): CreditResult {
  const hy = m.get('hy_oas'), ccc = m.get('ccc_oas'), bbb = m.get('bb_oas'), ig = m.get('ig_oas');
  const out: Component[] = [];

  const hyNow = latest(hy), cccRoc = change(ccc, 28), bbRoc = change(bbb, 28);
  const igNow = latest(ig), igRoc = change(ig, 28);
  const hyRoc20 = change(hy, 28), hyRoc5 = change(hy, 7);

  // 1. speculative tier moving first — the earliest rung
  if (cccRoc === null) out.push(noData('CCC & lower spreads'));
  else if (cccRoc * 100 >= T.ccc_roc20_bp) {
    out.push({ delta: 1, reason: `CCC & lower widened ${bp(cccRoc * 100)} over 20 sessions — past the ${T.ccc_roc20_bp}bp trigger. The speculative rung moves first` });
  } else {
    out.push({ delta: 0, reason: `CCC & lower ${bp(cccRoc * 100)} over 20 sessions — below the ${T.ccc_roc20_bp}bp trigger` });
  }

  // 2. has it climbed to BB/B?
  if (bbRoc === null) out.push(noData('BB spreads'));
  else if (bbRoc * 100 >= T.bb_roc20_bp) {
    out.push({ delta: 1, reason: `BB widened ${bp(bbRoc * 100)} over 20 sessions — stress has climbed off the speculative rung` });
  } else {
    out.push({ delta: 0, reason: `BB ${bp(bbRoc * 100)} over 20 sessions — below the ${T.bb_roc20_bp}bp trigger, stress not yet climbing` });
  }

  // 3. broad HY level
  if (!hyNow) out.push(noData('Broad HY OAS'));
  else if (hyNow.value >= T.hy_stress) {
    out.push({ delta: 1, reason: `Broad HY OAS ${hyNow.value.toFixed(2)}% — at or past the ${T.hy_stress}% crisis threshold` });
  } else if (hyNow.value >= T.hy_caution) {
    out.push({ delta: 0.75, reason: `Broad HY OAS ${hyNow.value.toFixed(2)}% — in the ${T.hy_caution}%+ stress band` });
  } else if (hyNow.value >= T.hy_calm) {
    out.push({ delta: 0.5, reason: `Broad HY OAS ${hyNow.value.toFixed(2)}% — above the ${T.hy_calm}% calm threshold` });
  } else {
    out.push({ delta: 0, reason: `Broad HY OAS ${hyNow.value.toFixed(2)}% — below the ${T.hy_calm}% calm threshold` });
  }

  // 4. broad HY velocity — deliberately separate from level
  if (hyRoc20 === null) out.push(noData('HY 20-session change'));
  else if (hyRoc20 * 100 >= T.hy_roc20_bp) {
    out.push({ delta: 1, reason: `Broad HY widened ${bp(hyRoc20 * 100)} in 20 sessions — velocity past ${T.hy_roc20_bp}bp regardless of level` });
  } else if (hyRoc5 !== null && hyRoc5 * 100 >= T.hy_roc5_bp) {
    out.push({ delta: 0.5, reason: `Broad HY widened ${bp(hyRoc5 * 100)} in the last week — a fast short-window move` });
  } else {
    out.push({ delta: 0, reason: `Broad HY ${bp(hyRoc20 * 100)} over 20 sessions — velocity below the ${T.hy_roc20_bp}bp trigger` });
  }

  // 5. investment grade — the rung that makes stress systemic rather than
  //    a high-yield sector problem
  const igWide = igRoc !== null && igRoc * 100 >= T.ig_roc20_bp;
  const igHigh = igNow !== null && igNow.value >= T.ig_stress_pct;
  if (igNow === null) out.push(noData('Investment-grade spreads'));
  else if (igHigh && igWide) {
    out.push({ delta: 1, reason: `IG at ${igNow.value.toFixed(2)}% and widening ${bp(igRoc! * 100)} — stress has reached investment grade. This is the systemic rung` });
  } else if (igWide) {
    out.push({ delta: 0.5, reason: `IG widening ${bp(igRoc! * 100)} over 20 sessions but still at ${igNow.value.toFixed(2)}% — early movement on the systemic rung` });
  } else {
    out.push({ delta: 0, reason: `IG ${igNow.value.toFixed(2)}%, ${bp(igRoc === null ? null : igRoc * 100)} over 20 sessions — investment grade remains calm. Stress, if any, is contained below it` });
  }

  const score = build(out);
  const systemic = igHigh && igWide;

  // Stage is the score, but capped below CONTAGION while IG is calm: stress
  // that has not touched investment grade is by definition not yet systemic,
  // however violent it looks further down the ladder.
  let idx = Math.min(5, Math.round(score.score));
  if (!systemic && idx > 2) idx = Math.min(idx, hyNow && hyNow.value >= T.hy_caution ? 3 : 2);

  return {
    ...score,
    stage: STAGES[idx],
    systemic,
    ladder: [
      { tier: 'CCC & lower', level: latest(ccc)?.value ?? null, roc20: cccRoc === null ? null : cccRoc * 100, widening: cccRoc === null ? null : cccRoc > 0 },
      { tier: 'BB', level: latest(bbb)?.value ?? null, roc20: bbRoc === null ? null : bbRoc * 100, widening: bbRoc === null ? null : bbRoc > 0 },
      { tier: 'Broad HY', level: hyNow?.value ?? null, roc20: hyRoc20 === null ? null : hyRoc20 * 100, widening: hyRoc20 === null ? null : hyRoc20 > 0 },
      { tier: 'Investment grade', level: igNow?.value ?? null, roc20: igRoc === null ? null : igRoc * 100, widening: igRoc === null ? null : igRoc > 0 },
    ],
  };
}
