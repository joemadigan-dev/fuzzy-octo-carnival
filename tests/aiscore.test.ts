// The AI Capital Stress Score.
//
// The binding requirement is §: "The score must permit the Noble/Chanos
// thesis to be WRONG." A score that rises on evidence for a claim and is
// merely silent on evidence against it is not a measurement of the claim,
// and most of what follows tests that the low end works as hard as the
// high end.
//
// The other failure being locked out is the one found by running the real
// filings through it: averaging five companies' ratios and describing the
// result as what the group does. Oracle spends 105% of revenue on capital
// and Amazon 22%; the mean says 46%, the group says 32%, and the mean
// reads as a far more dramatic finding than the data supports.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreAiCapital, aiCapitalStatus, aiCapitalLine } from '../src/scoring/ai-capital-score.ts';
import type { CompanyMetrics, Measure } from '../src/compute/ai-capital-metrics.ts';

const n = (value: number | null, unit: Measure['unit'] = 'fraction'): Measure =>
  value === null ? { value: null, unit, unknown: 'unavailable' } : { value, unit, periods: ['2026-06-30'] };

interface Shape {
  revenue?: number; capex?: number; ocf?: number; opinc?: number; fcf?: number;
  revenuePrior?: number; capexPrior?: number; ocfPrior?: number;
  incrOpinc?: number | null; incrFcf?: number | null; netDebtToOcf?: number | null;
  revGrowth?: number | null;
}

function co(ticker: string, s: Shape): CompanyMetrics {
  const m: Record<string, Measure> = {
    ttm_revenue: n(s.revenue ?? 100, 'usd_bn'),
    ttm_capex: n(s.capex ?? 20, 'usd_bn'),
    ttm_ocf: n(s.ocf ?? 50, 'usd_bn'),
    ttm_opinc: n(s.opinc ?? 30, 'usd_bn'),
    ttm_revenue_prior: n(s.revenuePrior ?? 90, 'usd_bn'),
    ttm_capex_prior: n(s.capexPrior ?? 18, 'usd_bn'),
    ttm_ocf_prior: n(s.ocfPrior ?? 45, 'usd_bn'),
    incr_opinc_on_capital: n(s.incrOpinc === undefined ? 0.25 : s.incrOpinc),
    incr_fcf_on_capital: n(s.incrFcf === undefined ? 0.15 : s.incrFcf),
    net_debt_to_ocf: n(s.netDebtToOcf === undefined ? 0.2 : s.netDebtToOcf, 'ratio'),
    revenue_growth_yoy: n(s.revGrowth === undefined ? 0.11 : s.revGrowth),
  };
  return { ticker, periodEnd: '2026-06-30', accn: 'A', filed: '2026-07-29', form: '10-Q', measures: m };
}

/** A whole universe in one call: four deployers plus the supplier. */
function universe(dep: Shape = {}, sup: Shape = {}, orclOverride?: Shape): Map<string, CompanyMetrics> {
  return new Map([
    ['MSFT', co('MSFT', dep)], ['GOOGL', co('GOOGL', dep)],
    ['AMZN', co('AMZN', dep)], ['META', co('META', dep)],
    ['ORCL', co('ORCL', orclOverride ?? dep)],
    ['NVDA', co('NVDA', sup)],
  ]);
}

const byName = (s: ReturnType<typeof scoreAiCapital>) => ({
  intensity: s.components[0], funding: s.components[1], returns: s.components[2],
  financing: s.components[3], divergence: s.components[4],
});

// ── the thesis must be able to be WRONG ───────────────────────────────

test('a healthy, self-funded, high-return build-out scores zero and says why', () => {
  const s = scoreAiCapital(universe(
    { revenue: 100, capex: 12, ocf: 60, capexPrior: 11, revenuePrior: 90, incrOpinc: 0.30, incrFcf: 0.2, netDebtToOcf: 0.2 },
    { revGrowth: 0.12 },
  ));
  assert.equal(s.score, 0, `expected a clean zero, got ${s.score}: ${JSON.stringify(s.components, null, 1)}`);
  assert.equal(s.status, 'NO SIGNAL');
  assert.ok(s.contradicting.length >= 3,
    `a benign reading must produce positive evidence against the thesis, got ${s.contradicting.length}`);
});

test('every component can state evidence against, not merely fail to trigger', () => {
  const s = scoreAiCapital(universe(
    { revenue: 100, capex: 12, ocf: 60, capexPrior: 11, revenuePrior: 90, incrOpinc: 0.30, netDebtToOcf: 0.2 },
    { revGrowth: 0.12 },
  ));
  const c = byName(s);
  for (const [name, comp] of Object.entries(c)) {
    if (name === 'returns') continue; // returns contradicts via its own threshold, checked below
    assert.match(comp.reason, /EVIDENCE AGAINST/, `${name} cannot express a refutation`);
  }
});

test('a strong incremental return is reported as refutation, in those words', () => {
  const s = scoreAiCapital(universe({ incrOpinc: 0.35 }));
  assert.match(byName(s).returns.reason, /EVIDENCE AGAINST the claim that this capital is being destroyed/);
  assert.equal(byName(s).returns.delta, 0);
});

test('capital earning less than it costs scores the full point', () => {
  const s = scoreAiCapital(universe({ incrOpinc: 0.04 }));
  assert.equal(byName(s).returns.delta, 1);
  assert.match(byName(s).returns.reason, /below any plausible cost of that capital/);
});

test('capital earning less than nothing is named as the central claim', () => {
  const s = scoreAiCapital(universe({ incrOpinc: -0.05 }));
  assert.equal(byName(s).returns.delta, 1);
  assert.match(byName(s).returns.reason, /central claim of the thesis/);
});

// ── group readings, not averages of ratios ────────────────────────────

test('group ratios are totals over totals, not the mean of the parts', () => {
  // Four companies at 20/100, Oracle at 80/76 — the real shape.
  // mean of ratios = (0.2*4 + 1.05)/5 = 37%; group = 160/476 = 34%
  const s = scoreAiCapital(universe(
    { revenue: 100, capex: 20 }, {},
    { revenue: 76, capex: 80, ocf: 47 },
  ));
  const m = byName(s).intensity.reason.match(/(\d+)% of their revenue|(\d+)% of combined revenue/);
  const got = Number((m?.[1] ?? m?.[2]));
  assert.equal(got, 34, `group capex/revenue must be 160/476 = 34%, got ${got}% — an average of the ratios gives 37%`);
});

test('a company missing one side of a group ratio is excluded from both sides', () => {
  const u = universe({ revenue: 100, capex: 20 });
  u.get('ORCL')!.measures.ttm_revenue = n(null, 'usd_bn');
  const s = scoreAiCapital(u);
  // 4 of 5 companies, still 20/100
  assert.match(byName(s).intensity.reason, /20% of their revenue|20% of combined revenue/);
  assert.match(byName(s).intensity.reason, /4\/5/);
});

// ── UNKNOWN is not zero ───────────────────────────────────────────────

test('a component with no data contributes zero AND is flagged unknown', () => {
  const u = universe();
  for (const t of ['MSFT', 'GOOGL', 'AMZN', 'META', 'ORCL']) {
    u.get(t)!.measures.incr_opinc_on_capital = n(null);
  }
  const s = scoreAiCapital(u);
  assert.equal(byName(s).returns.delta, 0);
  assert.equal(byName(s).returns.unknown, true);
  assert.equal(s.evidenceAvailable, 4, 'the missing component must reduce the evidence count');
  assert.equal(s.evidenceTotal, 5);
});

test('missing evidence is not renormalised into confidence', () => {
  const u = universe({ capex: 45, ocf: 40, revenue: 100 });   // genuinely stressed
  for (const t of ['MSFT', 'GOOGL', 'AMZN', 'META', 'ORCL']) {
    u.get(t)!.measures.incr_opinc_on_capital = n(null);
    u.get(t)!.measures.net_debt_to_ocf = n(null, 'ratio');
  }
  const s = scoreAiCapital(u);
  assert.equal(s.max, 5, 'the scale must not shrink to the evidence available');
  assert.ok(s.score <= 3, 'a partial reading stays low rather than being scaled up');
  assert.equal(s.evidenceAvailable, 3);
});

test('an empty universe is UNKNOWN, not NO SIGNAL', () => {
  const s = scoreAiCapital(new Map());
  assert.equal(s.evidenceAvailable, 0);
  assert.equal(s.status, 'UNKNOWN');
  assert.match(aiCapitalLine(s, '2026-09-19'), /UNKNOWN/);
});

// ── the supplier is never averaged into the deployers ─────────────────

test('the supplier is excluded from deployer aggregates', () => {
  // NVDA spends almost nothing on capex; including it would drag the
  // group intensity down and net the two sides of the same trade.
  const withSupplier = scoreAiCapital(universe({ revenue: 100, capex: 40 }, { revenue: 300, capex: 7 }));
  assert.match(byName(withSupplier).intensity.reason, /40% of their revenue/,
    'the group reading must be the deployers alone');
});

test('divergence compares the supplier with the buyers, and in-step is refutation', () => {
  const s = scoreAiCapital(universe({ capex: 20, capexPrior: 10 }, { revGrowth: 1.0 }));
  // deployer capex growth 100%, supplier revenue growth 100% → 0pp apart
  assert.equal(byName(s).divergence.delta, 0);
  assert.match(byName(s).divergence.reason, /EVIDENCE AGAINST a turn having begun/);
});

test('a supplier outrunning its customers scores the full point', () => {
  const s = scoreAiCapital(universe({ capex: 11, capexPrior: 10 }, { revGrowth: 0.9 }));
  // deployers +10%, supplier +90% → 80pp gap
  assert.equal(byName(s).divergence.delta, 1);
  assert.match(byName(s).divergence.reason, /pulled\s+forward/);
});

test('buyers outrunning the supplier is also a signal, in the other direction', () => {
  const s = scoreAiCapital(universe({ capex: 20, capexPrior: 10 }, { revGrowth: 0.1 }));
  assert.equal(byName(s).divergence.delta, 1);
  assert.match(byName(s).divergence.reason, /somewhere other than chips/);
});

// ── status banding and the one-line summary ───────────────────────────

test('status bands come from config and bottom out at NO SIGNAL', () => {
  assert.equal(aiCapitalStatus(0, 5), 'NO SIGNAL');
  assert.equal(aiCapitalStatus(1.5, 5), 'WATCH');
  assert.equal(aiCapitalStatus(2.5, 5), 'ELEVATED');
  assert.equal(aiCapitalStatus(3.5, 5), 'STRESS');
  assert.equal(aiCapitalStatus(5, 5), 'CRITICAL');
  assert.equal(aiCapitalStatus(4, 0), 'UNKNOWN', 'no evidence outranks any score');
});

test('the summary is one line and carries score, evidence and period', () => {
  const s = scoreAiCapital(universe());
  const line = aiCapitalLine(s, '2026-09-19');
  assert.ok(!line.includes('\n'), 'it goes under Market Setup as a single line');
  assert.match(line, /^AI CAPITAL: /);
  assert.match(line, /evidence \d\/5/);
  assert.match(line, /2026-06-30/);
});

test('data older than a couple of quarters says how old it is', () => {
  const s = scoreAiCapital(universe());
  assert.match(aiCapitalLine(s, '2027-06-30'), /months ago/);
  assert.ok(!/months ago/.test(aiCapitalLine(s, '2026-08-01')), 'a current quarter needs no age warning');
});

test('no BUY, SELL, LONG or SHORT language anywhere in the output', () => {
  const s = scoreAiCapital(universe({ capex: 60, ocf: 40, incrOpinc: -0.1, netDebtToOcf: 4 }, { revGrowth: 2 }));
  const text = [...s.components.map((c) => c.reason), aiCapitalLine(s, '2026-09-19')].join(' ');
  assert.ok(!/\b(buy|sell|long|short)\b/i.test(text), `forbidden trading language: ${text}`);
});

test('a fully stressed universe reaches the top of the scale', () => {
  const s = scoreAiCapital(universe(
    { revenue: 100, capex: 60, ocf: 40, capexPrior: 20, revenuePrior: 90, incrOpinc: -0.1, incrFcf: -0.3, netDebtToOcf: 4 },
    // deployer capex +200%, supplier revenue +300% → a 100pp gap, past the
    // extreme divergence threshold. (At +250% the gap is 50pp, which is
    // correctly only half a point.)
    { revGrowth: 3.0 },
  ));
  assert.equal(s.score, 5);
  assert.equal(s.status, 'CRITICAL');
  assert.equal(s.contradicting.length, 0);
});
