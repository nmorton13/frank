-- Read-only dashboard share tokens. A workspace owner may create a share
-- token to grant read-only access to the dashboard to someone without a
-- Frank account. The token is hashed (never stored in plaintext) and can be
-- revoked by the owner at any time, which invalidates the link immediately.
CREATE TABLE share_tokens (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  token_hash BLOB NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE INDEX share_tokens_workspace_idx
  ON share_tokens(workspace_id, revoked_at, expires_at);
