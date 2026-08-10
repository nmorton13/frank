-- Add index on workspaces(state, created_at) for cron cleanup queries.
CREATE INDEX IF NOT EXISTS workspaces_state_created_idx
  ON workspaces(state, created_at);
