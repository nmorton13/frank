PRAGMA foreign_keys = ON;

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email_normalized TEXT NOT NULL COLLATE NOCASE,
  email_verified_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE UNIQUE INDEX users_verified_email_idx
  ON users(email_normalized COLLATE NOCASE)
  WHERE email_verified_at IS NOT NULL;

CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  state TEXT NOT NULL DEFAULT 'unclaimed'
    CHECK (state IN ('unclaimed', 'active', 'deleting', 'deleted')),
  public_handle TEXT COLLATE NOCASE UNIQUE,
  display_name TEXT,
  page_title TEXT,
  time_zone TEXT NOT NULL DEFAULT 'UTC',
  public_enabled INTEGER NOT NULL DEFAULT 0
    CHECK (public_enabled IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  claimed_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  deleted_at TEXT
);

CREATE TABLE workspace_owners (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (workspace_id, user_id)
);

CREATE TABLE agent_credentials (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  token_hash BLOB NOT NULL UNIQUE,
  token_prefix TEXT NOT NULL,
  label TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'revoked')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_used_at TEXT,
  revoked_at TEXT
);

CREATE INDEX agent_credentials_workspace_idx
  ON agent_credentials(workspace_id, status);

CREATE TABLE claim_tokens (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  token_hash BLOB NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  used_at TEXT,
  reservation_id TEXT,
  reserved_until TEXT
);

CREATE INDEX claim_tokens_workspace_idx
  ON claim_tokens(workspace_id, expires_at);

CREATE TABLE auth_tokens (
  id TEXT PRIMARY KEY,
  purpose TEXT NOT NULL CHECK (purpose IN ('claim', 'login')),
  token_hash BLOB NOT NULL UNIQUE,
  workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  email_normalized TEXT NOT NULL COLLATE NOCASE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  used_at TEXT
);

CREATE INDEX auth_tokens_lookup_idx
  ON auth_tokens(purpose, expires_at, used_at);

CREATE TABLE email_attempts (
  id TEXT PRIMARY KEY,
  auth_token_id TEXT NOT NULL REFERENCES auth_tokens(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK (purpose IN ('claim', 'login')),
  recipient TEXT NOT NULL COLLATE NOCASE,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sent', 'failed')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  delivered_at TEXT,
  failed_at TEXT
);

CREATE TABLE browser_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash BLOB NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_seen_at TEXT,
  revoked_at TEXT
);

CREATE INDEX browser_sessions_user_idx
  ON browser_sessions(user_id, expires_at);

CREATE TABLE email_preferences (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  digest_enabled INTEGER NOT NULL DEFAULT 0
    CHECK (digest_enabled IN (0, 1)),
  digest_address TEXT,
  digest_local_time TEXT NOT NULL DEFAULT '08:00',
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
