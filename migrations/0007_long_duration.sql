-- LONG DURATION / TREASURY CONVEXITY history.
--
-- One row per day, mirroring cockpit_history's shape so the same read
-- patterns work and no new index strategy is introduced. The full payload
-- lives in `detail` as JSON; the columns are the ones worth querying
-- directly — for the signal-history panel and for the backtest, both of
-- which need to scan states across dates without parsing every blob.
--
-- WHY THE STATES ARE SEPARATE COLUMNS. The whole point of this module is
-- that the score and its qualifications are different facts: a 4.5 with
-- the veto ACTIVE and confirmation absent is not the same reading as a 4.5
-- with neither. Storing them as one number would make the history
-- unreadable later, and "later" is when the question "did high readings
-- precede strong long-duration returns?" actually gets asked.
--
-- Nothing here stores a price for CUSIP 912803HS5. The STRIP table is
-- recomputed from the proxy yield on every render, so it can never go
-- stale in the database and be served as though it were current.
CREATE TABLE IF NOT EXISTS long_duration_history (
  date              TEXT PRIMARY KEY,
  computed_at       TEXT NOT NULL,
  score             REAL,
  band              TEXT,
  macro_regime      TEXT,
  confirmation      TEXT,
  veto              TEXT,
  -- The multiplier applied to the macro pillar: 1, 0.5 or 0. Kept as its
  -- own column because it is the mechanism that stops "recession = buy
  -- bonds", and a backtest that could not see it would be unable to tell
  -- a suppressed reading from an absent one.
  inflation_compat  REAL,
  pillar_valuation  REAL,
  pillar_macro      REAL,
  pillar_inflation  REAL,
  -- The inputs, stored so the backtest never has to re-fetch and so a
  -- reading can be reconstructed exactly as it was seen on the day.
  us30y             REAL,
  us30y_real        REAL,
  be30              REAL,
  term_premium      REAL,
  -- 0/1, NOT a count: whether coverage was too thin to present a score.
  low_confidence    INTEGER NOT NULL DEFAULT 0,
  coverage          REAL,
  detail            TEXT NOT NULL
);

-- The backtest and the history panel both read by date range.
CREATE INDEX IF NOT EXISTS idx_long_duration_band
  ON long_duration_history (band, date);
