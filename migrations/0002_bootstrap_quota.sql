-- Atomic bootstrap quota counters for the operator-authorized bootstrap gate.
-- A single windowed row per hour lets us reserve quota atomically (INSERT...
-- ON CONFLICT DO UPDATE ... WHERE ... RETURNING) without a race-prone COUNT.

CREATE TABLE IF NOT EXISTS bootstrap_quota (
  bucket TEXT PRIMARY KEY,          -- e.g. 'hour:<yyyy-mm-ddThh>' or 'total'
  count INTEGER NOT NULL DEFAULT 0
);
