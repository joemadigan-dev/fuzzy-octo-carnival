-- Phase 3: the accountability layer.

-- Decision journal — personal, token-gated, never public. Every entry
-- snapshots the full wall state at write time; the cron fills in what
-- actually happened at +1m/+3m/+6m so memory can't rewrite it.
CREATE TABLE IF NOT EXISTS journal_entries (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at  TEXT NOT NULL,
  entry       TEXT NOT NULL,      -- free text: what you're seeing
  stance      TEXT,               -- 'bullish' | 'bearish' | 'neutral' (next 3 months)
  action      TEXT,               -- action taken or considered
  conviction  INTEGER,            -- 1..5
  instruments TEXT,               -- JSON array of KPI ids named in the entry
  snapshot    TEXT NOT NULL,      -- JSON: gauges, regimes, every input reading
  realized    TEXT                -- JSON: forward returns + stance hit, cron-filled
);

-- Alerts — append-only. The PRIMARY KEY is the rate limit: one row per
-- (date, kind, key) means at most one alert per state per day, by
-- construction. `delivered` records which channels actually fired.
CREATE TABLE IF NOT EXISTS alerts (
  date       TEXT NOT NULL,
  kind       TEXT NOT NULL,       -- regime | divergence | input95 | response_gap | thesis
  key        TEXT NOT NULL,
  message    TEXT NOT NULL,       -- what changed, what drove it, what it was before
  detail     TEXT,                -- JSON
  delivered  TEXT,                -- JSON: channels that fired (webhook/email/log)
  created_at TEXT NOT NULL,
  PRIMARY KEY (date, kind, key)
) WITHOUT ROWID;
