import type { DataSource } from './types.ts';
import { fred } from './fred.ts';
import { stooq } from './stooq.ts';
import { yahoo } from './yahoo.ts';

export const SOURCES: Record<string, DataSource> = {
  fred,
  stooq,
  yahoo,
};

export type { DataSource, Point, FetchOpts, SourceEnv } from './types.ts';
