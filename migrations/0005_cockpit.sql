-- Cockpit: daily snapshots of the scores and the adopted phase.
--
-- `candidate_phase` is what today's indicators alone say; `phase` is what
-- has actually been adopted after the persistence requirement. Storing both
-- is what lets the phase model apply hysteresis across runs, and lets the
-- regime timeline show where a candidate appeared but never settled.

CREATE TABLE IF NOT EXISTS cockpit_history (
  date             TEXT PRIMARY KEY,
  computed_at      TEXT NOT NULL,
  phase            TEXT,
  candidate_phase  TEXT,
  phase_settled    INTEGER NOT NULL DEFAULT 0,
  meltup           REAL,
  bust             REAL,
  bust_vulnerability REAL,
  bust_onset       REAL,
  credit           REAL,
  credit_stage     TEXT,
  credit_systemic  INTEGER,
  liquidity_regime TEXT,
  liquidity_level  TEXT,
  detail           TEXT
);

CREATE INDEX IF NOT EXISTS idx_cockpit_date ON cockpit_history(date DESC);

-- Phase transitions, recorded once per change rather than per day.
CREATE TABLE IF NOT EXISTS phase_changes (
  date        TEXT PRIMARY KEY,
  from_phase  TEXT,
  to_phase    TEXT NOT NULL,
  held_days   INTEGER,
  evidence    TEXT
);
