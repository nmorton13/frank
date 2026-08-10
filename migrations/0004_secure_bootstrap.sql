-- Replace the original bootstrap replay table, which persisted raw capability
-- credentials, with a reservation table containing only hashes and metadata.
-- Existing replay rows are deliberately discarded; their workspaces and
-- credentials remain intact, but old idempotency keys can no longer retrieve
-- the stored raw tokens.
ALTER TABLE bootstrap_idempotency RENAME TO bootstrap_idempotency_legacy;

CREATE TABLE bootstrap_idempotency (
  key_hash TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'completed')),
  owner_nonce TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  credential_id TEXT NOT NULL,
  claim_id TEXT NOT NULL,
  claim_expires_at TEXT NOT NULL,
  quota_reserved INTEGER NOT NULL DEFAULT 0 CHECK (quota_reserved IN (0, 1)),
  reserved_until TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  completed_at TEXT,
  expires_at TEXT NOT NULL
);

DROP TABLE bootstrap_idempotency_legacy;
DROP TABLE bootstrap_client_quota;

-- Atomically enforced count of currently retained workspaces. Scheduled
-- cleanup reconciles this bucket against authoritative workspace state.
INSERT OR REPLACE INTO bootstrap_quota (bucket, count)
SELECT 'live', COUNT(*) FROM workspaces WHERE state IN ('unclaimed', 'active');
