// Provider abstraction. Adding a data source = implementing this interface
// and registering it in ./index.ts. Adding a KPI never touches fetch logic.

export interface Point {
  date: string;  // ISO yyyy-mm-dd
  value: number;
}

export interface FetchOpts {
  from?: string; // ISO date, inclusive
  to?: string;   // ISO date, inclusive
}

export interface SourceEnv {
  FRED_API_KEY?: string;
}

export interface DataSource {
  id: string;
  fetchSeries(seriesId: string, opts: FetchOpts, env: SourceEnv): Promise<Point[]>;
}
