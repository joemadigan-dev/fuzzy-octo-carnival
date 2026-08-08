-- Gauge ranges: point-in-time percentiles alongside the raw scores, and a
-- slowly-changing table for the distribution + reference marks.
--
-- pp_/ap_ are POINT-IN-TIME percentiles (each date ranked only against
-- observations strictly before it). They are the only percentiles safe to
-- plot across history. Today's live percentile — ranked against everything,
-- which today legitimately has — lives in signal_state and is never written
-- into this per-date table, so a future edit cannot quietly plot it.

ALTER TABLE barometer_history ADD COLUMN pp_2y REAL;
ALTER TABLE barometer_history ADD COLUMN pp_5y REAL;
ALTER TABLE barometer_history ADD COLUMN ap_2y REAL;
ALTER TABLE barometer_history ADD COLUMN ap_5y REAL;

-- Distribution bins, zone boundary scores and fixed reference marks.
-- Only change when history is backfilled or a new extreme is set, so they
-- are kept out of the per-date table.
CREATE TABLE IF NOT EXISTS gauge_meta (
  layer       TEXT NOT NULL,     -- 'pressure' | 'altitude'
  window      TEXT NOT NULL,     -- '2y' | '5y'
  computed_at TEXT NOT NULL,
  detail      TEXT NOT NULL,     -- JSON GaugeData
  PRIMARY KEY (layer, window)
) WITHOUT ROWID;
