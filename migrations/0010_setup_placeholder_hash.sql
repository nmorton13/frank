-- Unredeemed agent credentials previously used their setup token's hash as the
-- placeholder token_hash, which let the setup token authenticate as a bearer
-- credential (and keep working after the setup TTL if never redeemed). Replace
-- every such placeholder with an unguessable random value. Redeeming a still-
-- valid setup link overwrites token_hash, so in-flight setups keep working.
UPDATE agent_credentials
SET token_hash = randomblob(32)
WHERE token_hash IN (SELECT token_hash FROM agent_setup_tokens);
