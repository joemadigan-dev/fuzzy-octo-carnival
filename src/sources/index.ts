import type { DataSource } from './types.ts';
import { fred } from './fred.ts';
import { stooq } from './stooq.ts';
import { yahoo } from './yahoo.ts';
import { cnn } from './cnn.ts';
import { naaim } from './naaim.ts';
import { damodaran } from './damodaran.ts';

export const SOURCES: Record<string, DataSource> = {
  fred,
  stooq,
  yahoo,
  cnn,
  naaim,
  damodaran,
};

export type { DataSource, Point, FetchOpts, SourceEnv } from './types.ts';
