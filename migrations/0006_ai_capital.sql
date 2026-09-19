-- V2: AI capital & credit transmission.
--
-- Company fundamentals are stored per QUARTER, not per day. A quarterly
-- number does not become stale between filings — it becomes OLD, which is
-- a different thing and is shown as such: every row carries the accession
-- number and filing date it came from, so the UI can say "as of FY26 Q4,
-- filed 2026-07-29" rather than implying a live reading.
--
-- Nothing here stores a filing. Only the extracted facts are kept, which
-- is a few hundred rows per company against a multi-megabyte document.

-- One row per company per fetch cycle: what we last saw and when we last
-- looked. `facts_hash` is the change detector — companyfacts serves no
-- ETag or Last-Modified, so the only way to know a re-fetch changed
-- anything is to hash what was extracted from it. An unchanged hash
-- writes nothing at all.
CREATE TABLE IF NOT EXISTS company_filings (
  ticker           TEXT PRIMARY KEY,
  cik              TEXT NOT NULL,
  entity_name      TEXT,
  latest_accession TEXT,
  latest_filed     TEXT,
  latest_period    TEXT,
  facts_hash       TEXT,
  checked_at       TEXT NOT NULL,
  changed_at       TEXT,
  status           TEXT NOT NULL DEFAULT 'ok',   -- ok | failed
  note             TEXT
);

-- Extracted quarterly facts. `basis` distinguishes a figure the company
-- tagged for that quarter from one derived by subtracting cumulatives;
-- `derived_from` spells out the arithmetic. A quarter that could be
-- neither found nor derived has NO ROW — absence is the signal, and the
-- UI reads it as UNKNOWN. It is never written as zero.
CREATE TABLE IF NOT EXISTS company_financials (
  ticker       TEXT NOT NULL,
  concept_id   TEXT NOT NULL,
  period_end   TEXT NOT NULL,
  period_start TEXT,
  value        REAL NOT NULL,
  basis        TEXT NOT NULL,                    -- reported | derived
  derived_from TEXT,
  tags         TEXT NOT NULL,                    -- XBRL tag(s) summed, comma-joined
  form         TEXT NOT NULL,
  filed        TEXT NOT NULL,
  accn         TEXT NOT NULL,
  fy           INTEGER,
  fp           TEXT,
  PRIMARY KEY (ticker, concept_id, period_end)
);

CREATE INDEX IF NOT EXISTS idx_fin_ticker_period
  ON company_financials(ticker, period_end DESC);

-- A concept that resolved to nothing for a company. Recorded explicitly so
-- the page can state WHY a metric is blank ("Oracle does not separately
-- tag construction in progress") instead of leaving a silent gap that
-- looks like a bug or, worse, gets treated as zero.
CREATE TABLE IF NOT EXISTS company_missing (
  ticker      TEXT NOT NULL,
  concept_id  TEXT NOT NULL,
  reason      TEXT NOT NULL,
  noted_at    TEXT NOT NULL,
  PRIMARY KEY (ticker, concept_id)
);

-- Derived per-quarter measures: TTM aggregates, capex intensity, and the
-- incremental capital-efficiency ratios. Kept separate from the extracted
-- facts so a change in how a metric is computed never overwrites the
-- filing evidence it was computed from.
CREATE TABLE IF NOT EXISTS company_metrics (
  ticker     TEXT NOT NULL,
  period_end TEXT NOT NULL,
  metric     TEXT NOT NULL,
  value      REAL NOT NULL,
  detail     TEXT,
  PRIMARY KEY (ticker, period_end, metric)
);

CREATE INDEX IF NOT EXISTS idx_metrics_ticker_period
  ON company_metrics(ticker, period_end DESC);

-- The AI Capital Stress Score and the transmission map, one row per day.
-- `evidence_available` / `evidence_total` carry the partial-evidence count
-- forward: a 2/5 score built on 2 of 5 components says so rather than
-- presenting itself as a complete reading.
CREATE TABLE IF NOT EXISTS ai_capital_history (
  date               TEXT PRIMARY KEY,
  computed_at        TEXT NOT NULL,
  score              REAL,
  status             TEXT,
  evidence_available INTEGER,
  evidence_total     INTEGER,
  components         TEXT,      -- JSON: the five components with their inputs
  transmission       TEXT,      -- JSON: AI capital → AI credit → CCC → BB/B → HY → IG
  thesis             TEXT,      -- JSON: supporting vs contradicting evidence
  hunter_link        TEXT,      -- NO CONNECTION | WATCH | TRANSMISSION FORMING | CONFIRMED
  detail             TEXT
);

CREATE INDEX IF NOT EXISTS idx_ai_capital_date ON ai_capital_history(date DESC);
