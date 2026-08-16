-- Add token_prefix to share_tokens so the owner dashboard can list active
-- share links (prefix + expiry) and revoke them. The full token is a
-- capability shown only once at creation; the prefix is stored for display.
ALTER TABLE share_tokens ADD COLUMN token_prefix TEXT;
