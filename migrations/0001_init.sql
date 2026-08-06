-- THE WALL — D1 schema.
-- KPI metadata (label, cluster, unit, direction …) lives in code:
-- src/registry/kpis.ts is the single source of truth, so adding a KPI is
-- exactly one config object and zero SQL. The tables below hold only data.

-- Raw + derived observations. Derived series (ratios, correlations) are
-- written here too, under their own series_id, so every series downstream
-- (sparks, charts, z-scores) flows through one path.
CREATE TABLE IF NOT EXISTS observations (
  series_id TEXT NOT NULL,
  date      TEXT NOT NULL,             -- ISO yyyy-mm-dd
  value     REAL NOT NULL,
  PRIMARY KEY (series_id, date)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_obs_series_date ON observations (series_id, date DESC);

-- Precomputed, display-ready state per KPI. Written only by the cron job.
-- The request path does a single read of this table and serializes it.
CREATE TABLE IF NOT EXISTS wall_state (
  series_id       TEXT PRIMARY KEY,
  computed_at     TEXT NOT NULL,       -- ISO timestamp of the cron run
  latest_value    REAL,
  latest_date     TEXT,
  changes         TEXT NOT NULL,       -- JSON {d,w,m,y,y5: {abs,pct}|null}
  sparks          TEXT NOT NULL,       -- JSON {d,w,m,y,y5: {v:[…≤60 numbers],t0,t1}}
  direction_state TEXT NOT NULL,       -- JSON {d,w,m,y,y5: 'up'|'down'|'flat'}
  status          TEXT NOT NULL,       -- 'ok' | 'stale' | 'error'
  status_detail   TEXT,                -- human-readable: what broke, when
  last_success_at TEXT                 -- last time a fetch for this series succeeded
);

-- Precomputed expanded-chart data (~5y daily, capped) per series.
CREATE TABLE IF NOT EXISTS charts (
  series_id TEXT NOT NULL,
  range     TEXT NOT NULL,             -- 'y5'
  points    TEXT NOT NULL,             -- JSON [[epoch_s,…],[value,…]] (uPlot layout)
  PRIMARY KEY (series_id, range)
) WITHOUT ROWID;

-- Composite signal: current state + full transparency detail.
CREATE TABLE IF NOT EXISTS signal_state (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  computed_at TEXT NOT NULL,
  detail      TEXT NOT NULL            -- JSON: per-window {score, regime, inputs:[{id,z,weight,contribution}]}
);

-- Daily composite history (both z-score windows) for the displayed backtest.
CREATE TABLE IF NOT EXISTS signal_history (
  date      TEXT PRIMARY KEY,
  score_2y  REAL,
  score_5y  REAL,
  regime_2y TEXT,
  regime_5y TEXT
) WITHOUT ROWID;

-- Every regime transition, with the inputs that caused it. Append-only.
CREATE TABLE IF NOT EXISTS signal_changes (
  date        TEXT NOT NULL,
  window      TEXT NOT NULL,           -- '2y' | '5y'
  from_regime TEXT NOT NULL,
  to_regime   TEXT NOT NULL,
  score       REAL NOT NULL,
  drivers     TEXT NOT NULL,           -- JSON [{id,z,contribution}] at transition
  PRIMARY KEY (date, window)
) WITHOUT ROWID;

-- Small key/value metadata (last run timestamp, etc.).
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) WITHOUT ROWID;
