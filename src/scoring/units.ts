// UNIT SEMANTICS — section 7 of the reliability brief.
//
// The bug this exists to make impossible: `eq_gdp` is stored as a RATIO
// (2.56 = 256% of GDP) and was compared against a threshold expressed in
// PERCENT (160). It scored the most stretched market-cap-to-GDP on record
// as "within normal range" — silently, with no error, for as long as it
// went unnoticed.
//
// The rule is that a scoring function must never have to guess. Every
// indicator a score reads declares a storage unit here, and scores ask for
// the unit they want by name. `asPercent('eq_gdp', 2.56)` is 256 and
// cannot be anything else.
//
// AUDIT of every indicator the cockpit scores against, checked against
// what the source actually publishes and what the registry stores:
//
//   ratio      eq_gdp              corp equities / GDP, ~2.56. THE BUG.
//   percent    hy_oas ccc_oas bb_oas ig_oas   FRED publishes OAS in
//                                  percent (2.70 = 2.70%), NOT bp. Every
//                                  rate-of-change in the credit engine
//                                  multiplies by 100 to reach bp, which is
//                                  correct and now asserted by tests.
//   percent    us10y us2y us10y_real          FRED yields in percent.
//                                  Curve = (10y - 2y) * 100 → bp. Correct.
//   percent    erp erp_norm erp_rf            Damodaran, percent.
//   percent    breadth_conf        63-session RSP/SPY change, already a
//                                  percentage. No conversion anywhere.
//   percent    cpi_yoy             (not currently scored — listed so a
//                                  future component cannot assume points)
//   bp         sofr_iorb           stored in bp by its combo (x100).
//                                  Compared against a bp threshold. OK.
//   bp         real_yield_impulse  trough_impulse scales by 100 → bp.
//   usd_tn     walcl net_liq       WALCL fetched with fetchScale 1e-6, so
//                                  $tn. The liquidity card multiplies by
//                                  1000 to report $bn against $bn
//                                  thresholds. Correct, and tested.
//   usd_bn     tga rrp             FRED publishes $bn; the net_liq combo
//                                  scales them by 1e-3 to reach $tn.
//   index      spx dow nasdaq rut vix vix3m   plain index levels.
//   usd        gold silver copper wti gdx smh spy
//   count      fng naaim put_call  (put_call is a ratio ~0.75 but is
//                                  compared only against another ratio)
//   usd_mn     margin_debt         Z.1 in $mn; only y/y percent change is
//                                  used, which is scale-free.
//
// Anything not listed is not read by a scoring function. Adding one means
// adding it here first.

/** How a series is STORED in `observations`. */
export type Unit =
  | 'ratio'      // 2.56 means 256%
  | 'percent'    // 2.70 means 2.70%
  | 'bp'         // 270 means 2.70%
  | 'usd' | 'usd_mn' | 'usd_bn' | 'usd_tn'
  | 'index' | 'count' | 'z';

export const UNITS: Record<string, Unit> = {
  eq_gdp: 'ratio',
  hy_oas: 'percent', ccc_oas: 'percent', bb_oas: 'percent', ig_oas: 'percent',
  ccc_bb: 'percent', hy_roc20: 'bp',
  us10y: 'percent', us2y: 'percent', us10y_real: 'percent',
  erp: 'percent', erp_norm: 'percent', erp_rf: 'percent', erp_expret: 'percent',
  breadth_conf: 'percent', parabolicity: 'percent', meltup: 'percent',
  sofr: 'percent', iorb: 'percent', sofr_iorb: 'bp', real_yield_impulse: 'bp',
  response_gap: 'z',
  walcl: 'usd_tn', net_liq: 'usd_tn', reserves: 'usd_tn',
  tga: 'usd_bn', rrp: 'usd_bn',
  margin_debt: 'usd_mn',
  spx: 'index', dow: 'index', nasdaq: 'index', rut: 'index',
  vix: 'index', vix3m: 'index', vix_term: 'ratio',
  gold: 'usd', silver: 'usd', copper: 'usd', wti: 'usd', gdx: 'usd', smh: 'usd',
  spy: 'usd', rsp: 'usd', xlf: 'usd', xlb: 'usd', igv: 'usd',
  fng: 'count', naaim: 'count', put_call: 'ratio',
  cre_delinq: 'percent', ci_delinq: 'percent',
};

class UnitError extends Error {}

/** The stored unit of `id`, or a thrown error. Scoring a series with no
 *  declared unit is a programming mistake, not a data condition — failing
 *  loudly here is the whole point. */
export function unitOf(id: string): Unit {
  const u = UNITS[id];
  if (!u) throw new UnitError(`no unit declared for '${id}' — add it to src/scoring/units.ts before scoring it`);
  return u;
}

/** Convert a stored value to PERCENT, whatever it is stored as. */
export function asPercent(id: string, value: number): number {
  switch (unitOf(id)) {
    case 'ratio': return value * 100;
    case 'percent': return value;
    case 'bp': return value / 100;
    default:
      throw new UnitError(`'${id}' is stored as ${unitOf(id)} and has no meaning in percent`);
  }
}

/** Convert a stored value to BASIS POINTS. */
export function asBp(id: string, value: number): number {
  switch (unitOf(id)) {
    case 'ratio': return value * 10000;
    case 'percent': return value * 100;
    case 'bp': return value;
    default:
      throw new UnitError(`'${id}' is stored as ${unitOf(id)} and has no meaning in basis points`);
  }
}

/** Convert a stored value to BILLIONS of dollars. */
export function asBn(id: string, value: number): number {
  switch (unitOf(id)) {
    case 'usd_tn': return value * 1000;
    case 'usd_bn': return value;
    case 'usd_mn': return value / 1000;
    default:
      throw new UnitError(`'${id}' is stored as ${unitOf(id)} and has no meaning in billions`);
  }
}

/** How a ratio-stored series should be DISPLAYED. */
export const displayPercent = (id: string, value: number): string =>
  `${asPercent(id, value).toFixed(0)}%`;
