import type { Point } from '../sources/types.ts';
import type { Derivation } from '../registry/kpis.ts';
import { ratioSeries, rollingCorrelation } from './stats.ts';

/** Compute a derived series from already-loaded input series.
 *  `seriesMap` is keyed by KPI id (not provider seriesId). */
export function computeDerived(d: Derivation, seriesMap: Map<string, Point[]>): Point[] {
  switch (d.type) {
    case 'ratio': {
      const num = seriesMap.get(d.num);
      const den = seriesMap.get(d.den);
      if (!num?.length || !den?.length) return [];
      return ratioSeries(num, den);
    }
    case 'rolling_corr': {
      const a = seriesMap.get(d.a);
      const b = seriesMap.get(d.b);
      if (!a?.length || !b?.length) return [];
      return rollingCorrelation(a, b, d.window);
    }
  }
}
