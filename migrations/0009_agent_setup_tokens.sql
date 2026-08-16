-- Agent-provisioning setup tokens. A workspace owner mints a credential from
-- the dashboard; the resulting short-lived, single-use setup token lets a new
-- agent redeem its write credential once. The token is hashed (never stored
-- in plaintext) and consumes itself on first redeem. The provisioned write
-- credential itself lives in agent_credentials and stays hashed + revocable.
CREATE TABLE agent_setup_tokens (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  credential_id TEXT NOT NULL REFERENCES agent_credentials(id) ON DELETE CASCADE,
  token_hash BLOB NOT NULL UNIQUE,
  token_prefix TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  used_at TEXT
);

CREATE INDEX agent_setup_tokens_workspace_idx
  ON agent_setup_tokens(workspace_id, expires_at, used_at);
