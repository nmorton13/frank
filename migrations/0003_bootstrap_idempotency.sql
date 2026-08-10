-- Bootstrap idempotency records so an agent retry cannot accidentally create
-- multiple workspaces. Stores the full bootstrap response for replay on retry.
CREATE TABLE IF NOT EXISTS bootstrap_idempotency (
  idempotency_key TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  agent_credential_token TEXT NOT NULL,
  agent_credential_id TEXT NOT NULL,
  claim_token TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at TEXT NOT NULL
);

-- Per-client (hashed IP) creation limit tracking.
CREATE TABLE IF NOT EXISTS bootstrap_client_quota (
  bucket TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
