// Transmission map, supplier signal, Hunter cross and the thesis test.
//
// The failure this file exists to prevent is the dashboard concluding
// "the AI bubble is bursting" from an elevated capital score. Capital
// intensity at six companies is not a credit event, and the whole point
// of the transmission panel is to keep those two claims apart. So most of
// what follows checks that an elevated score, on its own, CANNOT produce
// a confirmed transmission or a confirmed bust.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  transmissionMap, supplierSignal, hunterCross, thesisTest, dataCaveats,
} from '../src/scoring/aipanel.ts';
import type { AiCapitalScore } from '../src/scoring/aicapital.ts';
import type { CompanyMetrics, Measure } from '../src/compute/aicapital.ts';
import type { Point } from '../src/sources/types.ts';

const n = (value: number | null, unit: Measure['unit'] = 'fraction'): Measure =>
  value === null ? { value: null, unit, unknown: 'unavailable' } : { value, unit, periods: ['2026-06-30'] };

function co(ticker: string, o: Partial<Record<string, number | null>> = {}): CompanyMetrics {
  const m: Record<string, Measure> = {
    ttm_capex: n(o.capex ?? 20, 'usd_bn'),
    ttm_capex_prior: n(o.capexPrior ?? 10, 'usd_bn'),
    ttm_revenue: n(o.revenue ?? 100, 'usd_bn'),
    ttm_ocf: n(o.ocf ?? 50, 'usd_bn'),
    capex_to_ocf: n(o.capexToOcf ?? 0.4),
    capex_intensity: n(o.capexIntensity ?? 0.2),
    net_debt_to_ocf: n(o.netDebtToOcf === undefined ? 0.2 : o.netDebtToOcf, 'ratio'),
    incr_opinc_on_capital: n(o.incrOpinc === undefined ? 0.2 : o.incrOpinc),
    incr_fcf_on_capital: n(o.incrFcf === undefined ? 0.1 : o.incrFcf),
    revenue_growth_yoy: n(o.revGrowth === undefined ? 0.15 : o.revGrowth),
  };
  return { ticker, periodEnd: '2026-06-30', accn: 'A', filed: '2026-07-29', form: '10-Q', measures: m };
}

const universe = (dep: Parameters<typeof co>[1] = {}, sup: Parameters<typeof co>[1] = {}) =>
  new Map<string, CompanyMetrics>([
    ['MSFT', co('MSFT', dep)], ['GOOGL', co('GOOGL', dep)], ['AMZN', co('AMZN', dep)],
    ['META', co('META', dep)], ['ORCL', co('ORCL', dep)], ['NVDA', co('NVDA', sup)],
  ]);

const score = (o: Partial<AiCapitalScore> = {}): AiCapitalScore => ({
  score: 3, max: 5, level: 'ELEVATED', components: [], coverage: 1,
  evidenceAvailable: 5, evidenceTotal: 5, status: 'ELEVATED',
  newestPeriod: '2026-06-30', oldestPeriod: '2026-06-30',
  contradicting: [], supporting: [], ...o,
});

/** Flat spread series at a given level, with an optional 60-day move. */
function spread(level: number, move = 0): Point[] {
  const out: Point[] = [];
  const start = Date.UTC(2026, 0, 1);
  for (let i = 0; i < 200; i++) {
    out.push({
      date: new Date(start + i * 86400000).toISOString().slice(0, 10),
      value: i < 140 ? level - move : level,
    });
  }
  return out;
}

const calmCredit = () => new Map<string, Point[]>([
  ['ccc_oas', spread(7.0)], ['bb_oas', spread(2.0)],
  ['hy_oas', spread(3.0)], ['ig_oas', spread(1.0)],
]);

// ── an elevated score must not confirm transmission ───────────────────

test('elevated AI capital with calm credit is NOT CONFIRMED', () => {
  const tr = transmissionMap(score({ score: 4.5, status: 'CRITICAL' }), universe(), calmCredit());
  assert.equal(tr.status, 'NOT CONFIRMED',
    'the capital score must never be able to confirm transmission by itself');
  assert.match(tr.explanation, /has not shown up in the price of credit/);
});

test('the AI capital score is not an input to any credit node', () => {
  const calm = calmCredit();
  const low = transmissionMap(score({ score: 0, status: 'NO SIGNAL' }), universe(), calm);
  const high = transmissionMap(score({ score: 5, status: 'CRITICAL' }), universe(), calm);
  const creditOf = (t: ReturnType<typeof transmissionMap>) =>
    t.nodes.filter((x) => ['ccc', 'bb', 'hy', 'ig'].includes(x.id)).map((x) => x.state);
  assert.deepEqual(creditOf(low), creditOf(high),
    'credit nodes must depend on credit data only');
});

test('two stressed credit nodes are what confirms transmission', () => {
  const m = new Map<string, Point[]>([
    ['ccc_oas', spread(12.0)], ['bb_oas', spread(4.5)],
    ['hy_oas', spread(3.0)], ['ig_oas', spread(1.0)],
  ]);
  const tr = transmissionMap(score(), universe(), m);
  assert.equal(tr.status, 'CONFIRMED');
});

test('one amber node is EARLY SIGNS, not FORMING', () => {
  const m = calmCredit();
  m.set('ccc_oas', spread(9.5));
  const tr = transmissionMap(score(), universe(), m);
  assert.equal(tr.status, 'EARLY SIGNS');
  assert.match(tr.explanation, /noise more often than it is a signal/);
});

test('a rapid widening triggers a node even below its level threshold', () => {
  const m = calmCredit();
  m.set('hy_oas', spread(3.0, 1.2));   // +120bp over 60 days, level still 300bp
  const tr = transmissionMap(score(), universe(), m);
  assert.equal(tr.nodes.find((x) => x.id === 'hy')!.state, 'RED');
});

test('missing spreads are UNKNOWN and say they are not calm', () => {
  const tr = transmissionMap(score(), universe(), new Map());
  assert.equal(tr.status, 'UNKNOWN');
  assert.ok(tr.nodes.filter((x) => x.state === 'UNKNOWN').length >= 4);
  assert.match(tr.explanation, /not the same as it being calm/);
});

test('partial spread coverage says which nodes are unknown', () => {
  const m = calmCredit();
  m.delete('ccc_oas');
  const tr = transmissionMap(score(), universe(), m);
  assert.match(tr.explanation, /CCC unavailable — read as unknown, not calm/);
});

test('the AI CREDIT node is issuer leverage and says so', () => {
  const tr = transmissionMap(score(), universe({ netDebtToOcf: 2.5 }), calmCredit());
  const node = tr.nodes.find((x) => x.id === 'ai_credit')!;
  assert.equal(node.state, 'RED');
  assert.match(node.detail, /not a traded spread/);
  assert.equal(tr.status, 'NOT CONFIRMED', 'issuer leverage alone must not confirm transmission');
});

test('spreads are read as percent and reported in basis points', () => {
  const m = calmCredit();
  m.set('hy_oas', spread(4.0));
  const tr = transmissionMap(score(), universe(), m);
  assert.match(tr.nodes.find((x) => x.id === 'hy')!.detail, /400bp/);
});

// ── supplier signal ───────────────────────────────────────────────────

test('supplier and buyers growing together is ALIGNED', () => {
  const s = supplierSignal(universe({ capex: 20, capexPrior: 10 }, { revGrowth: 1.0 }));
  assert.equal(s.state, 'ALIGNED');
  assert.ok(Math.abs(s.gap!) < 0.01);
});

test('a supplier far ahead of its buyers is SUPPLIER DIVERGENCE', () => {
  const s = supplierSignal(universe({ capex: 11, capexPrior: 10 }, { revGrowth: 0.9 }));
  assert.equal(s.state, 'SUPPLIER DIVERGENCE');
  assert.match(s.explanation, /pulled forward/);
});

test('a supplier far behind its buyers is SUPPLIER LAGGING', () => {
  const s = supplierSignal(universe({ capex: 20, capexPrior: 10 }, { revGrowth: 0.1 }));
  assert.equal(s.state, 'SUPPLIER LAGGING');
  assert.match(s.explanation, /somewhere other than chips/);
});

test('an unreadable supplier is UNKNOWN, not ALIGNED', () => {
  const u = universe();
  u.get('NVDA')!.measures.revenue_growth_yoy = n(null);
  const s = supplierSignal(u);
  assert.equal(s.state, 'UNKNOWN');
});

// ── Hunter × AI ───────────────────────────────────────────────────────

test('high AI stress with a calm Credit Canary is EARLY WATCH, never a bust', () => {
  const tr = transmissionMap(score(), universe(), calmCredit());
  const h = hunterCross(score({ score: 4.0, status: 'STRESS' }), 2.0, 0.0, 0.0, 'NEUTRAL', tr);
  assert.equal(h.state, 'EARLY WATCH');
  assert.match(h.explanation, /watch condition, not a bust/);
});

test('a confirmed bust needs credit AND equity onset, not just capital stress', () => {
  const stressed = new Map<string, Point[]>([
    ['ccc_oas', spread(12.0)], ['bb_oas', spread(4.5)],
    ['hy_oas', spread(6.5)], ['ig_oas', spread(2.0)],
  ]);
  const tr = transmissionMap(score(), universe(), stressed);
  assert.equal(tr.status, 'CONFIRMED');

  // capital + credit ladder, but no broad credit score and no onset
  assert.equal(hunterCross(score({ score: 5 }), 2, 0.0, 0.0, 'NEUTRAL', tr).state, 'TRANSMISSION FORMING');
  // all three legs
  assert.equal(hunterCross(score({ score: 5 }), 2, 4.0, 3.0, 'QE', tr).state, 'BUST TRANSMISSION CONFIRMED');
});

test('a low AI score with calm credit is NO CONNECTION', () => {
  const tr = transmissionMap(score({ score: 1 }), universe(), calmCredit());
  assert.equal(hunterCross(score({ score: 1 }), 2, 0, 0, 'NEUTRAL', tr).state, 'NO CONNECTION');
});

test('no filings at all is NO CONNECTION and says why', () => {
  const tr = transmissionMap(score({ status: 'UNKNOWN' }), universe(), calmCredit());
  const h = hunterCross(score({ status: 'UNKNOWN' }), null, null, null, null, tr);
  assert.equal(h.state, 'NO CONNECTION');
  assert.match(h.explanation, /no company filings/i);
});

test('every Hunter input is listed, with UNKNOWN where absent', () => {
  const tr = transmissionMap(score(), universe(), calmCredit());
  const h = hunterCross(score(), null, null, null, null, tr);
  assert.equal(h.inputs.length, 5);
  assert.ok(h.inputs.filter((i) => i.value === 'UNKNOWN').length >= 3);
});

// ── thesis test ───────────────────────────────────────────────────────

test('both sides of the thesis are populated from the readings', () => {
  const u = universe({ capexToOcf: 1.2, incrFcf: -0.2, incrOpinc: 0.05, netDebtToOcf: 0.2 });
  const tr = transmissionMap(score(), u, calmCredit());
  const sup = supplierSignal(u);
  const th = thesisTest(score(), u, sup, tr);
  assert.ok(th.supporting.length > 0, 'capex exceeding OCF must appear as supporting evidence');
  assert.ok(th.contradicting.length > 0, 'calm credit must appear as contradicting evidence');
  assert.match(th.supporting.join(' '), /spent more on capital than/);
});

test('the supplier reading is counted once, not once per wording', () => {
  const u = universe({ capex: 20, capexPrior: 10 }, { revGrowth: 1.0 });
  const tr = transmissionMap(score(), u, calmCredit());
  const sup = supplierSignal(u);
  const th = thesisTest(score({ contradicting: [sup.explanation] }), u, sup, tr);
  const nvda = th.contradicting.filter((x) => /NVDA/.test(x));
  assert.equal(nvda.length, 1, `the supplier fact must appear once, got ${nvda.length}`);
});

test('the verdict refuses to call a bust while the supplier is aligned', () => {
  const u = universe({ capexToOcf: 1.3, incrFcf: -0.3 }, { revGrowth: 1.0 });
  const tr = transmissionMap(score({ score: 4 }), u, calmCredit());
  const th = thesisTest(score({ score: 4 }), u, supplierSignal(u), tr);
  assert.match(th.verdict, /not yet confirmed/);
  assert.ok(!/burst|bursting|collapse/i.test(th.verdict));
});

test('no BUY, SELL, LONG or SHORT language in any generated sentence', () => {
  const u = universe({ capexToOcf: 1.4, netDebtToOcf: 3, incrOpinc: -0.1 });
  const tr = transmissionMap(score({ score: 5 }), u, calmCredit());
  const sup = supplierSignal(u);
  const th = thesisTest(score({ score: 5 }), u, sup, tr);
  const h = hunterCross(score({ score: 5 }), 4, 3, 3, 'QE', tr);
  const text = [
    tr.explanation, ...tr.nodes.map((x) => x.detail), sup.explanation,
    h.explanation, th.verdict, ...th.supporting, ...th.contradicting,
  ].join(' ');
  assert.ok(!/\b(buy|sell|long|short)\b/i.test(text), `forbidden trading language: ${text.slice(0, 200)}`);
});

// ── caveats ───────────────────────────────────────────────────────────

test('caveats are generated from what was extracted, not a stored list', () => {
  const u = universe();
  u.get('ORCL')!.measures.incr_opinc_on_capital = {
    value: 0.07, unit: 'fraction',
    basisNote: 'Computed on the property base net of depreciation: this company does not tag a gross figure at both period ends. Not directly comparable with a company measured on the gross base.',
  };
  u.get('ORCL')!.measures.net_debt = {
    value: 98, unit: 'usd_bn',
    basisNote: 'Balance sheet as of 2026-05-31, the most recent date at which this company tags both borrowings and cash; the income and cash-flow figures above are to 2026-08-31.',
  };
  const cav = dataCaveats(u, [{ ticker: 'MSFT', concept_id: 'cip', reason: 'NOT DISCLOSED' }]);
  assert.ok(cav.some((c) => c.ticker === 'ORCL' && /NET property, not gross/.test(c.text)),
    `expected a gross-vs-net caveat for ORCL, got ${JSON.stringify(cav.filter((c) => c.ticker === 'ORCL'))}`);
  assert.ok(cav.some((c) => c.ticker === 'ORCL' && /Balance sheet as of 2026-05-31/.test(c.text)));
  assert.ok(cav.some((c) => /Construction in progress is NOT DISCLOSED by MSFT/.test(c.text)));
});

test('the no-AI-capex-disclosed caveat is always present', () => {
  const cav = dataCaveats(universe(), []);
  assert.ok(cav.some((c) => /None of these companies discloses AI-specific capital expenditure/.test(c.text)),
    'the most important limitation must never be droppable');
});
