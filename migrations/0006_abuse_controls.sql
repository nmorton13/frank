-- Security/abuse-control metadata for reserved public signup capacity.
ALTER TABLE workspaces ADD COLUMN bootstrap_mode TEXT NOT NULL DEFAULT 'public'
  CHECK (bootstrap_mode IN ('public', 'operator'));

-- Pending reservations consume live capacity before their workspace row exists.
-- Persist their mode so cleanup reconciliation cannot erase reserved capacity.
ALTER TABLE bootstrap_idempotency ADD COLUMN bootstrap_mode TEXT NOT NULL DEFAULT 'public'
  CHECK (bootstrap_mode IN ('public', 'operator'));

CREATE INDEX IF NOT EXISTS workspaces_bootstrap_mode_state_idx
  ON workspaces(bootstrap_mode, state, created_at);

INSERT OR REPLACE INTO bootstrap_quota (bucket, count)
SELECT 'live:public', COUNT(*)
FROM workspaces
WHERE state IN ('unclaimed', 'active') AND bootstrap_mode = 'public';
