-- Phase 2: THE BAROMETER (two-layer signal) + tile state flags.
-- The old single-composite history tables are dropped, not migrated —
-- every row in them is recomputed from `observations` on the next cron
-- run, so no accumulated data is lost.

ALTER TABLE wall_state ADD COLUMN flag TEXT;

DROP TABLE IF EXISTS signal_history;
DROP TABLE IF EXISTS signal_changes;

CREATE TABLE IF NOT EXISTS barometer_history (
  date  TEXT PRIMARY KEY,
  p_2y  REAL, p_5y REAL,          -- PRESSURE score per z-window
  a_2y  REAL, a_5y REAL,          -- ALTITUDE score per z-window
  pr_2y TEXT, pr_5y TEXT,         -- pressure regime
  ar_2y TEXT, ar_5y TEXT,         -- altitude regime
  div_2y INTEGER NOT NULL DEFAULT 0,  -- high-altitude + low-pressure divergence
  div_5y INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS barometer_changes (
  date        TEXT NOT NULL,
  layer       TEXT NOT NULL,      -- 'pressure' | 'altitude'
  window      TEXT NOT NULL,      -- '2y' | '5y'
  from_regime TEXT NOT NULL,
  to_regime   TEXT NOT NULL,
  score       REAL NOT NULL,
  drivers     TEXT NOT NULL,      -- JSON [{id,z,contribution}] (sub-indices)
  PRIMARY KEY (date, layer, window)
) WITHOUT ROWID;
