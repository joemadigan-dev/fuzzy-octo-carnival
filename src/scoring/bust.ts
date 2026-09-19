// BUST RISK (0-5) — section 7.
//
// The brief's central instruction for this module: do NOT equate an
// expensive market with an imminent crash. The score therefore separates
// two things and reports both:
//
//   vulnerability — valuation, leverage, liquidity. Conditions that make a
//                   bust worse if one starts. These can sit at maximum for
//                   years without anything happening.
//   onset         — internals, volatility, credit. Evidence a bust is
//                   actually beginning.
//
// The headline score is weighted toward onset, and the UI shows the split,
// so "vulnerable but nothing happening" can never render the same as
// "it has started".

import type { Point } from '../sources/types.ts';
import thresholds from '../../config/thresholds.json' with { type: 'json' };
import { build, change, drawdown, latest, noData, pctChange, type Component, type Score } from './common.ts';
import type { CreditResult } from './credit.ts';
import { asPercent } from './units.ts';

const T = thresholds.bust;

export interface BustResult extends Score {
  vulnerability: number;   // 0-3: valuation + leverage + liquidity
  onset: number;           // 0-2: internals + credit
  /** One sentence naming which of the two is driving the reading. */
  posture: string;
}

export function bustRisk(m: Map<string, Point[]>, credit: CreditResult): BustResult {
  const vuln: Component[] = [];
  const onset: Component[] = [];

  // ── VULNERABILITY ───────────────────────────────────────────────────
  // 1. valuation. Alone this must NEVER trigger a bust reading.
  //    CAPE is not on FRED; equity market cap / GDP and the implied ERP
  //    are what this build actually has, and the reason is stated.
  const mcap = latest(m.get('eq_gdp'));
  const erp = latest(m.get('erp'));
  if (!mcap && !erp) vuln.push(noData('Valuation'));
  else {
    const parts: string[] = [];
    let d = 0;
    if (mcap) {
      // eq_gdp is stored as a RATIO (2.56 = 256% of GDP) and the
      // thresholds are in percent, because that is how the Buffett
      // indicator is quoted. asPercent reads the declared unit rather than
      // letting this line assume one — read raw, 2.56 sits below a 120
      // "elevated" threshold and scores the most stretched valuation on
      // record as normal, which is exactly what happened.
      const v = asPercent('eq_gdp', mcap.value);
      if (v >= T.valuation.mcap_gdp_extreme) { d = Math.max(d, 1); parts.push(`equity market cap / GDP ${v.toFixed(0)}% is past the ${T.valuation.mcap_gdp_extreme}% extreme band`); }
      else if (v >= T.valuation.mcap_gdp_elevated) { d = Math.max(d, 0.5); parts.push(`equity market cap / GDP ${v.toFixed(0)}% is elevated`); }
      else parts.push(`equity market cap / GDP ${v.toFixed(0)}% is within normal range`);
    }
    if (erp) {
      if (erp.value <= T.valuation.erp_thin_pct) { d = Math.max(d, 1); parts.push(`implied ERP ${erp.value.toFixed(2)}% is at or below the ${T.valuation.erp_thin_pct}% thin-cushion threshold`); }
      else parts.push(`implied ERP ${erp.value.toFixed(2)}% still offers a cushion`);
    }
    vuln.push({ delta: d, reason: `Valuation — ${parts.join('; ')}. Expensive is not the same as breaking` });
  }

  // 2. leverage and speculation
  const margin = m.get('margin_debt');
  const marginYoY = pctChange(margin, 365);
  const pc = latest(m.get('put_call'));
  if (marginYoY === null && !pc) vuln.push(noData('Leverage and speculation'));
  else {
    let d = 0;
    const parts: string[] = [];
    if (marginYoY !== null) {
      if (marginYoY >= T.leverage.margin_debt_yoy_extreme) { d = Math.max(d, 1); parts.push(`broker receivables +${marginYoY.toFixed(0)}% y/y, past the ${T.leverage.margin_debt_yoy_extreme}% extreme band`); }
      else if (marginYoY >= T.leverage.margin_debt_yoy_elevated) { d = Math.max(d, 0.5); parts.push(`broker receivables +${marginYoY.toFixed(0)}% y/y, elevated`); }
      else parts.push(`broker receivables ${marginYoY > 0 ? '+' : ''}${marginYoY.toFixed(0)}% y/y`);
    }
    if (pc) {
      if (pc.value <= T.leverage.put_call_complacent) { d = Math.max(d, 0.5); parts.push(`equity put/call ${pc.value.toFixed(2)} at or below the ${T.leverage.put_call_complacent} complacency mark`); }
      else parts.push(`equity put/call ${pc.value.toFixed(2)}`);
    }
    vuln.push({ delta: d, reason: `Leverage and speculation — ${parts.join('; ')}` });
  }

  // 3. liquidity contracting
  const walcl13 = pctChange(m.get('walcl'), 91);
  const netliq13 = pctChange(m.get('net_liq'), 91);
  const sofrIorb = latest(m.get('sofr_iorb'));
  if (walcl13 === null && netliq13 === null) vuln.push(noData('Liquidity'));
  else {
    let d = 0;
    const parts: string[] = [];
    if (walcl13 !== null) {
      if (walcl13 <= T.liquidity.walcl_13w_contraction_pct) { d = Math.max(d, 0.5); parts.push(`Fed balance sheet ${walcl13.toFixed(1)}% over 13 weeks`); }
      else parts.push(`Fed balance sheet ${walcl13 > 0 ? '+' : ''}${walcl13.toFixed(1)}% over 13 weeks`);
    }
    if (netliq13 !== null && netliq13 <= T.liquidity.net_liq_13w_contraction_pct) {
      d = Math.max(d, 1); parts.push(`net liquidity ${netliq13.toFixed(1)}% over 13 weeks, past the ${T.liquidity.net_liq_13w_contraction_pct}% drain threshold`);
    }
    if (sofrIorb && Math.abs(sofrIorb.value) > T.liquidity.sofr_iorb_stress_bp) {
      d = Math.max(d, 1); parts.push(`SOFR-IORB ${sofrIorb.value.toFixed(0)}bp outside the normal band — plumbing under pressure`);
    }
    vuln.push({ delta: d, reason: `Liquidity — ${parts.join('; ')}` });
  }

  // ── ONSET ───────────────────────────────────────────────────────────
  // 4. internals and volatility — is it actually breaking?
  const dd = drawdown(m.get('spx'), 365);
  const vix = latest(m.get('vix'));
  const breadth = latest(m.get('breadth_conf'));
  if (dd === null && !vix) onset.push(noData('Market internals'));
  else {
    let d = 0;
    const parts: string[] = [];
    if (dd !== null) {
      if (dd <= T.internals.drawdown_bear) { d = Math.max(d, 1); parts.push(`S&P ${dd.toFixed(1)}% from its one-year peak, past the ${T.internals.drawdown_bear}% bear threshold`); }
      else if (dd <= T.internals.drawdown_correction) { d = Math.max(d, 0.5); parts.push(`S&P ${dd.toFixed(1)}% from its peak, in correction`); }
      else parts.push(`S&P ${dd.toFixed(1)}% from its one-year peak — no meaningful drawdown yet`);
    }
    if (vix) {
      if (vix.value >= T.internals.vix_crisis) { d = Math.max(d, 1); parts.push(`VIX ${vix.value.toFixed(1)} past ${T.internals.vix_crisis}`); }
      else if (vix.value >= T.internals.vix_stress) { d = Math.max(d, 0.5); parts.push(`VIX ${vix.value.toFixed(1)} elevated`); }
      else parts.push(`VIX ${vix.value.toFixed(1)} subdued`);
    }
    if (breadth && breadth.value < T.internals.breadth_deteriorating_pct) {
      parts.push(`equal-weight lagging cap-weight by ${Math.abs(breadth.value).toFixed(1)}% over 63 sessions`);
      d = Math.max(d, Math.min(1, d + 0.25));
    }
    onset.push({ delta: d, reason: `Internals — ${parts.join('; ')}` });
  }

  // 5. credit — delegated wholesale to the Canary, which is the better
  //    instrument for it. Scaled from its own 0-5 onto this 0-1 slot.
  onset.push({
    delta: Math.min(1, credit.score / 5),
    reason: `Credit — Canary at ${credit.score.toFixed(1)}/5 (${credit.stage}). ${credit.systemic ? 'Stress has reached investment grade' : 'Stress has not reached investment grade'}`,
  });

  const all = [...vuln, ...onset];
  const base = build(all);
  const vulnScore = vuln.filter((c) => !c.unknown).reduce((s, c) => s + c.delta, 0);
  const onsetScore = onset.filter((c) => !c.unknown).reduce((s, c) => s + c.delta, 0);

  const posture = onsetScore >= 1.5
    ? 'A bust appears to be beginning — onset evidence, not just vulnerability.'
    : vulnScore >= 2
      ? 'Conditions are vulnerable to a bust, but nothing has started. Vulnerability can persist for years.'
      : 'Neither markedly vulnerable nor showing onset evidence.';

  return {
    ...base,
    vulnerability: Math.round(vulnScore * 10) / 10,
    onset: Math.round(onsetScore * 10) / 10,
    posture,
  };
}
