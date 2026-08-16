import { HttpError, parseCookies } from "./http";
import {
  claimEmail,
  cloudflareEmailDelivery,
  loginEmail,
  type EmailDelivery,
} from "./email";
import {
  deriveOpaqueToken,
  hashText,
  hashToken,
  keyedHashText,
  newId,
  newOpaqueToken,
} from "./tokens";

const CLAIM_TTL_MS = 30 * 60 * 1000;
const CLAIM_RESERVATION_MS = 5 * 60 * 1000;
const LOGIN_TTL_MS = 20 * 60 * 1000;
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const SHARE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_LOGIN_CLIENT_CEILING = 20;
const DEFAULT_LOGIN_GLOBAL_CEILING = 200;
const DEFAULT_EMAIL_RECIPIENT_CEILING = 3;
const DEFAULT_EMAIL_GLOBAL_CEILING = 50;
const DEFAULT_AGENT_CREDENTIAL_MINUTE_CEILING = 120;
const DEFAULT_HUMAN_SESSION_MINUTE_CEILING = 120;
const DEFAULT_WORKSPACE_MINUTE_CEILING = 240;
const DEFAULT_WORKSPACE_WRITE_HOUR_CEILING = 1_000;
const DEFAULT_USER_WORKSPACE_CEILING = 5;
const DEFAULT_PUBLIC_TOTAL_CEILING = 80;
const DEFAULT_PUBLIC_HOURLY_CEILING = 5;
const DEFAULT_CLEANUP_BATCH_SIZE = 20;
const DEFAULT_DELETED_RETENTION_DAYS = 30;

// Operator-issued bootstrap authorization header. The bearer value is compared
// against a Cloudflare secret (BOOTSTRAP_TOKEN) and never logged or returned.
const BOOTSTRAP_AUTH_HEADER = "bootstrap-token";
// Global safety ceiling on live workspaces, independent of the hourly quota.
const DEFAULT_TOTAL_CEILING = 20;
// Per-client ceiling within the same UTC clock hour.
const DEFAULT_CLIENT_CEILING = 5;
// Replay remains available only while the associated claim is usable.
const BOOTSTRAP_IDEM_TTL_MS = CLAIM_TTL_MS;
const BOOTSTRAP_RESERVATION_MS = 60 * 1000;

function readBootstrapAuthorization(request: Request): string | null {
  return request.headers.get(BOOTSTRAP_AUTH_HEADER)?.trim() || null;
}

async function constantTimeEqual(a: string, b: string): Promise<boolean> {
  const aHash = await hashText(a);
  const bHash = await hashText(b);
  return aHash === bHash;
}

/**
 * Determine the client identity for rate limiting. In the deployed Cloudflare
 * environment, CF-Connecting-IP is trustworthy. In development and tests, use
 * the Frank-Client-IP header for deterministic behavior. The value is hashed
 * before storage so raw IPs are never persisted.
 */
function clientIp(request: Request): string {
  const cfIp = request.headers.get("cf-connecting-ip");
  if (cfIp) return cfIp;
  const hostname = new URL(request.url).hostname;
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname.endsWith(".test")) {
    const testIp = request.headers.get("frank-client-ip");
    if (testIp) return testIp;
  }
  return "unknown";
}

/**
 * Bootstrap authorization gate. When BOOTSTRAP_TOKEN is set:
 *   - No Bootstrap-Token header → public path (per-client + global quotas apply)
 *   - Valid Bootstrap-Token header → operator path (same quotas apply)
 *   - Invalid Bootstrap-Token header → rejected with 403
 * When BOOTSTRAP_TOKEN is unset, workspace creation is disabled (503).
 *
 * @returns "public" or "operator" to allow the caller to differentiate if needed.
 */
async function authorizeBootstrap(
  env: Env,
  request: Request,
): Promise<"public" | "operator"> {
  const expected = String(env.BOOTSTRAP_TOKEN ?? "");
  if (!expected) {
    throw new HttpError(503, "Workspace creation is not enabled");
  }
  const provided = readBootstrapAuthorization(request);
  if (!provided) {
    // No token → public agent path (subject to quotas).
    return "public";
  }
  const ok = await constantTimeEqual(provided, expected);
  if (!ok) {
    // Explicit invalid token → reject.
    throw new HttpError(403, "Workspace creation is not authorized");
  }
  return "operator";
}

/**
 * Atomically reserve one unit against a named quota bucket. Uses a single
 * INSERT ... ON CONFLICT ... WHERE ... RETURNING statement so concurrent
 * requests cannot all observe spare quota and exceed it.
 * @returns true if a slot was reserved, false if the bucket is at its ceiling.
 */
function hourlyBucket(now: Date): string {
  const key = now.toISOString().slice(0, 13); // yyyy-mm-ddThh (UTC)
  return `hour:${key}`;
}

interface QuotaReservation {
  buckets: string[];
}

function configuredCeiling(env: Env, name: keyof Env, fallback: number): number {
  const raw = Number(env[name]);
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

function minuteBucket(now = new Date()): string {
  return now.toISOString().slice(0, 16);
}

async function releaseQuotaSlots(env: Env, buckets: string[]): Promise<void> {
  if (buckets.length === 0) return;
  await env.DIRECTORY.batch(
    buckets.flatMap((bucket) => [
      env.DIRECTORY.prepare(
        "UPDATE bootstrap_quota SET count = MAX(count - 1, 0) WHERE bucket = ?",
      ).bind(bucket),
      // Fixed live rows are retained for reconciliation. Time-scoped/client
      // rows that return to zero are removed so failed distributed requests
      // cannot create an unbounded set of current-window bucket names.
      env.DIRECTORY.prepare(
        "DELETE FROM bootstrap_quota WHERE bucket = ? AND count = 0 AND bucket NOT IN ('live', 'live:public')",
      ).bind(bucket),
    ]),
  );
}

async function enforceQuota(
  env: Env,
  request: Request,
  mode: "public" | "operator",
): Promise<QuotaReservation> {
  const now = new Date();
  const buckets: string[] = [];
  const hour = hourlyBucket(now);

  const reserve = async (bucket: string, ceiling: number): Promise<void> => {
    const ok = await reserveQuotaSlot(env, bucket, ceiling);
    if (!ok) {
      await releaseQuotaSlots(env, buckets);
      throw new HttpError(429, "Workspace creation rate limit exceeded. Try again later.");
    }
    buckets.push(bucket);
  };

  // Fixed-cardinality circuits are always reserved first. If one is disabled
  // or full, attacker-controlled client identities never reach D1 bucket
  // creation. The all-mode circuits also preserve operator headroom.
  await reserve(hour, configuredCeiling(env, "BOOTSTRAP_QUOTA_PER_HOUR", 10));
  await reserve(
    "live",
    configuredCeiling(env, "BOOTSTRAP_TOTAL_CEILING", DEFAULT_TOTAL_CEILING),
  );

  if (mode === "public") {
    await reserve(
      `public:${hour}`,
      configuredCeiling(env, "BOOTSTRAP_PUBLIC_QUOTA_PER_HOUR", DEFAULT_PUBLIC_HOURLY_CEILING),
    );
    await reserve(
      "live:public",
      configuredCeiling(env, "BOOTSTRAP_PUBLIC_TOTAL_CEILING", DEFAULT_PUBLIC_TOTAL_CEILING),
    );
    const clientCeiling = configuredCeiling(
      env,
      "BOOTSTRAP_CLIENT_CEILING",
      DEFAULT_CLIENT_CEILING,
    );
    const secret = String(env.BOOTSTRAP_TOKEN ?? "");
    const ipHash = await keyedHashText(secret, `bootstrap-client:${clientIp(request)}`);
    await reserve(`client:${hour.slice("hour:".length)}:${ipHash}`, clientCeiling);
  }
  return { buckets };
}

async function reserveQuotaSlot(
  env: Env,
  bucket: string,
  ceiling: number,
): Promise<boolean> {
  if (!Number.isFinite(ceiling) || ceiling <= 0) return false;
  const row = await env.DIRECTORY.prepare(
    `INSERT INTO bootstrap_quota (bucket, count) VALUES (?, 1)
     ON CONFLICT(bucket) DO UPDATE SET count = count + 1 WHERE count < ?
     RETURNING count`,
  )
    .bind(bucket, ceiling)
    .first<{ count: number }>();
  return row !== null;
}

async function reserveAllOrRelease(
  env: Env,
  limits: Array<{ bucket: string; ceiling: number }>,
): Promise<QuotaReservation | null> {
  const buckets: string[] = [];
  for (const limit of limits) {
    if (!(await reserveQuotaSlot(env, limit.bucket, limit.ceiling))) {
      await releaseQuotaSlots(env, buckets);
      return null;
    }
    buckets.push(limit.bucket);
  }
  return { buckets };
}

async function clientHash(env: Env, request: Request, purpose: string): Promise<string> {
  return keyedHashText(
    String(env.BOOTSTRAP_TOKEN ?? ""),
    `${purpose}:${clientIp(request)}`,
  );
}

export async function enforcePublicRequestLimit(
  env: Env,
  request: Request,
  purpose: "login" | "claim",
): Promise<boolean> {
  const hour = new Date().toISOString().slice(0, 13);
  const hash = await clientHash(env, request, purpose);
  const prefix = `${purpose}:request:${hour}`;
  const limits = purpose === "login"
    ? [
        { bucket: `${prefix}:global`, ceiling: configuredCeiling(env, "LOGIN_GLOBAL_CEILING", DEFAULT_LOGIN_GLOBAL_CEILING) },
        { bucket: `${prefix}:client:${hash}`, ceiling: configuredCeiling(env, "LOGIN_CLIENT_CEILING", DEFAULT_LOGIN_CLIENT_CEILING) },
      ]
    : [
        { bucket: `${prefix}:global`, ceiling: configuredCeiling(env, "CLAIM_GLOBAL_CEILING", DEFAULT_LOGIN_GLOBAL_CEILING) },
        { bucket: `${prefix}:client:${hash}`, ceiling: configuredCeiling(env, "CLAIM_CLIENT_CEILING", DEFAULT_LOGIN_CLIENT_CEILING) },
      ];
  return (await reserveAllOrRelease(env, limits)) !== null;
}

async function reserveEmailBudget(
  env: Env,
  recipient: string,
): Promise<QuotaReservation | null> {
  const hour = new Date().toISOString().slice(0, 13);
  const recipientHash = await keyedHashText(
    String(env.BOOTSTRAP_TOKEN ?? ""),
    `email-recipient:${recipient}`,
  );
  return reserveAllOrRelease(env, [
    {
      bucket: `email:${hour}:global`,
      ceiling: configuredCeiling(env, "EMAIL_GLOBAL_CEILING", DEFAULT_EMAIL_GLOBAL_CEILING),
    },
    {
      bucket: `email:${hour}:recipient:${recipientHash}`,
      ceiling: configuredCeiling(env, "EMAIL_RECIPIENT_CEILING", DEFAULT_EMAIL_RECIPIENT_CEILING),
    },
  ]);
}

export async function enforceAgentRequestLimits(
  env: Env,
  credentialId: string,
  workspaceId: string,
  write: boolean,
): Promise<void> {
  const minute = minuteBucket();
  const hour = new Date().toISOString().slice(0, 13);
  const limits = [
    {
      bucket: `agent:${minute}:credential:${credentialId}`,
      ceiling: configuredCeiling(env, "AGENT_CREDENTIAL_MINUTE_CEILING", DEFAULT_AGENT_CREDENTIAL_MINUTE_CEILING),
    },
    {
      bucket: `workspace:${minute}:${workspaceId}`,
      ceiling: configuredCeiling(env, "WORKSPACE_MINUTE_CEILING", DEFAULT_WORKSPACE_MINUTE_CEILING),
    },
  ];
  if (write) {
    limits.push({
      bucket: `write:${hour}:workspace:${workspaceId}`,
      ceiling: configuredCeiling(env, "WORKSPACE_WRITE_HOUR_CEILING", DEFAULT_WORKSPACE_WRITE_HOUR_CEILING),
    });
  }
  if (!(await reserveAllOrRelease(env, limits))) {
    throw new HttpError(429, "Workspace request rate limit exceeded. Try again later.");
  }
}

/**
 * Bootstrap responses include capability credentials, so the idempotency key
 * is also a short-lived replay secret. Require a UUID-sized value.
 */
function bootstrapIdempotencyKey(request: Request): string {
  const value = request.headers.get("idempotency-key")?.trim();
  if (!value) throw new HttpError(400, "A valid Idempotency-Key header is required");
  if (value.length < 24) throw new HttpError(400, "Idempotency-Key is too short");
  if (value.length > 200) {
    throw new HttpError(400, "Idempotency-Key is too long");
  }
  return value;
}

export interface BootstrapResult {
  workspace: {
    id: string;
    state: "unclaimed";
  };
  agentCredential: {
    id: string;
    token: string;
    prefix: string;
    scopes: string[];
  };
  claim: {
    id: string;
    token: string;
    expiresAt: string;
  };
}

export interface HumanSession {
  userId: string;
  workspaceId: string;
}

export interface AgentIdentity {
  credentialId: string;
  workspaceId: string;
  scopes: string[];
}

interface BootstrapIdempotencyRow {
  requestHash: string;
  status: "pending" | "completed";
  ownerNonce: string;
  workspaceId: string;
  credentialId: string;
  claimId: string;
  claimExpiresAt: string;
  quotaReserved: number;
  bootstrapMode: "public" | "operator";
  reservedUntil: string;
  expiresAt: string;
}

async function deriveBootstrapResult(
  secret: string,
  idempotencyKey: string,
  requestHash: string,
  row: BootstrapIdempotencyRow,
): Promise<BootstrapResult> {
  const context = `${idempotencyKey}\u0000${requestHash}`;
  const agent = await deriveOpaqueToken("agent", secret, context);
  const claim = await deriveOpaqueToken("claim", secret, context);
  return {
    workspace: { id: row.workspaceId, state: "unclaimed" },
    agentCredential: {
      id: row.credentialId,
      token: agent.token,
      prefix: agent.prefix,
      scopes: ["read", "write"],
    },
    claim: { id: row.claimId, token: claim.token, expiresAt: row.claimExpiresAt },
  };
}

async function ensureBootstrapReplayIsUsable(
  env: Env,
  row: BootstrapIdempotencyRow,
): Promise<void> {
  const usable = await env.DIRECTORY.prepare(`
    SELECT 1 AS usable
    FROM claim_tokens ct
    JOIN workspaces w ON w.id = ct.workspace_id
    WHERE ct.id = ? AND ct.workspace_id = ?
      AND ct.used_at IS NULL
      AND ct.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      AND w.state = 'unclaimed'
    LIMIT 1
  `)
    .bind(row.claimId, row.workspaceId)
    .first<{ usable: number }>();
  if (!usable) throw new HttpError(410, "Bootstrap replay is no longer available");
}

export async function bootstrapWorkspace(
  env: Env,
  input: {
    displayName?: string;
    pageTitle?: string;
    timeZone?: string;
    agentLabel: string;
    request?: Request;
  },
): Promise<BootstrapResult> {
  const req = input.request ?? new Request("http://internal");
  const mode = await authorizeBootstrap(env, req);
  const idemKey = bootstrapIdempotencyKey(req);
  const secret = String(env.BOOTSTRAP_TOKEN ?? "");
  const body = {
    displayName: input.displayName ?? "",
    pageTitle: input.pageTitle ?? "",
    timeZone: input.timeZone ?? "",
    agentLabel: input.agentLabel,
    mode,
  };
  const requestHash = await hashText(JSON.stringify(body));
  const keyHash = await keyedHashText(secret, `bootstrap-idempotency:${idemKey}`);
  const ownerNonce = crypto.randomUUID();
  const workspaceId = newId("workspace");
  const credentialId = newId("credential");
  const claimId = newId("claim");
  const now = Date.now();
  const reservedUntil = new Date(now + BOOTSTRAP_RESERVATION_MS).toISOString();
  const claimExpiresAt = new Date(Date.now() + CLAIM_TTL_MS).toISOString();
  const expiresAt = new Date(now + BOOTSTRAP_IDEM_TTL_MS).toISOString();

  const readReservation = () =>
    env.DIRECTORY.prepare(`
      SELECT request_hash AS requestHash, status, owner_nonce AS ownerNonce,
        workspace_id AS workspaceId, credential_id AS credentialId,
        claim_id AS claimId, claim_expires_at AS claimExpiresAt,
        quota_reserved AS quotaReserved, bootstrap_mode AS bootstrapMode,
        reserved_until AS reservedUntil,
        expires_at AS expiresAt
      FROM bootstrap_idempotency WHERE key_hash = ? LIMIT 1
    `)
      .bind(keyHash)
      .first<BootstrapIdempotencyRow>();

  let row = await readReservation();
  if (row) {
    if (row.requestHash !== requestHash) {
      throw new HttpError(409, "Idempotency key was already used for a different request");
    }
    if (row.expiresAt <= new Date().toISOString()) {
      throw new HttpError(410, "Idempotency key has expired; use a new key");
    }
    if (row.status === "completed") {
      await ensureBootstrapReplayIsUsable(env, row);
      return deriveBootstrapResult(secret, idemKey, requestHash, row);
    }
  }

  // Reserve quota before creating a new idempotency row. A rejected request
  // therefore cannot grow the reservations table. If another request wins the
  // same key concurrently, release our duplicate reservation and use its row.
  let quota: QuotaReservation | null = null;
  if (!row) {
    let insertedOwned = false;
    try {
      quota = await enforceQuota(env, req, mode);
      const inserted = await env.DIRECTORY.prepare(`
        INSERT OR IGNORE INTO bootstrap_idempotency (
          key_hash, request_hash, status, owner_nonce, workspace_id,
          credential_id, claim_id, claim_expires_at, quota_reserved,
          bootstrap_mode, reserved_until, expires_at
        ) VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, 1, ?, ?, ?)
      `)
        .bind(
          keyHash,
          requestHash,
          ownerNonce,
          workspaceId,
          credentialId,
          claimId,
          claimExpiresAt,
          mode,
          reservedUntil,
          expiresAt,
        )
        .run();
      insertedOwned = inserted.meta.changes === 1;
      if (!insertedOwned) {
        await releaseQuotaSlots(env, quota.buckets);
        quota = null;
      }
      row = await readReservation();
      if (!row) throw new HttpError(503, "Workspace creation could not be reserved");
      if (row.requestHash !== requestHash) {
        throw new HttpError(409, "Idempotency key was already used for a different request");
      }
    } catch (error) {
      if (insertedOwned) {
        const removed = await env.DIRECTORY.prepare(
          "DELETE FROM bootstrap_idempotency WHERE key_hash = ? AND owner_nonce = ? AND status = 'pending'",
        ).bind(keyHash, ownerNonce).run();
        if (removed.meta.changes === 1 && quota) {
          await releaseQuotaSlots(env, quota.buckets);
          quota = null;
        }
      } else if (quota) {
        await releaseQuotaSlots(env, quota.buckets);
        quota = null;
      }
      throw error;
    }
  }

  if (row.ownerNonce !== ownerNonce) {
    const takeover = await env.DIRECTORY.prepare(`
      UPDATE bootstrap_idempotency SET owner_nonce = ?, reserved_until = ?
      WHERE key_hash = ? AND status = 'pending'
        AND reserved_until <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    `)
      .bind(ownerNonce, reservedUntil, keyHash)
      .run();
    if (takeover.meta.changes !== 1) {
      throw new HttpError(409, "Bootstrap request is already in progress; retry shortly");
    }
    row = (await readReservation())!;
  }

  try {
    if (row.quotaReserved !== 1) {
      quota = await enforceQuota(env, req, mode);
      const marked = await env.DIRECTORY.prepare(`
        UPDATE bootstrap_idempotency SET quota_reserved = 1
        WHERE key_hash = ? AND owner_nonce = ? AND status = 'pending'
      `)
        .bind(keyHash, ownerNonce)
        .run();
      if (marked.meta.changes !== 1) {
        throw new HttpError(409, "Bootstrap request ownership changed; retry shortly");
      }
    }

    row = (await readReservation())!;
    const result = await deriveBootstrapResult(secret, idemKey, requestHash, row);
    const agent = await deriveOpaqueToken("agent", secret, `${idemKey}\u0000${requestHash}`);
    const claim = await deriveOpaqueToken("claim", secret, `${idemKey}\u0000${requestHash}`);
    const scopes = ["read", "write"];

    const created = await env.DIRECTORY.batch([
      env.DIRECTORY.prepare(`
        INSERT INTO workspaces (id, display_name, page_title, time_zone, bootstrap_mode)
        VALUES (?, ?, ?, ?, ?)
      `).bind(
        row.workspaceId,
        input.displayName ?? null,
        input.pageTitle ?? null,
        input.timeZone ?? "UTC",
        mode,
      ),
      env.DIRECTORY.prepare(`
        INSERT INTO agent_credentials (
          id, workspace_id, token_hash, token_prefix, label, scopes_json
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).bind(
        row.credentialId,
        row.workspaceId,
        agent.hash,
        agent.prefix,
        input.agentLabel,
        JSON.stringify(scopes),
      ),
      env.DIRECTORY.prepare(`
        INSERT INTO claim_tokens (id, workspace_id, token_hash, expires_at)
        VALUES (?, ?, ?, ?)
      `).bind(row.claimId, row.workspaceId, claim.hash, row.claimExpiresAt),
      env.DIRECTORY.prepare(`
        UPDATE bootstrap_idempotency
        SET status = 'completed', completed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE key_hash = ? AND owner_nonce = ? AND status = 'pending'
      `).bind(keyHash, ownerNonce),
    ]);
    if (created[3]!.meta.changes !== 1) {
      throw new HttpError(409, "Bootstrap request ownership changed; retry shortly");
    }
    return result;
  } catch (error) {
    if (row.ownerNonce === ownerNonce && quota) {
      const removed = await env.DIRECTORY.prepare(
        "DELETE FROM bootstrap_idempotency WHERE key_hash = ? AND owner_nonce = ? AND status = 'pending'",
      )
        .bind(keyHash, ownerNonce)
        .run();
      if (removed.meta.changes === 1) await releaseQuotaSlots(env, quota.buckets);
    }
    // A taken-over row with quota_reserved=1 is itself the durable ownership
    // record. Keep it retryable when the original bucket list is unavailable;
    // hourly reconciliation repairs the counters without admitting a new key.
    throw error;
  }
}

function normalizeEmail(email: string): string {
  const normalizedEmail = email.trim().toLowerCase();
  if (
    normalizedEmail.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)
  ) {
    throw new HttpError(400, "A valid email is required");
  }
  return normalizedEmail;
}

export async function requestClaimVerification(
  env: Env,
  claimToken: string,
  email: string,
  origin: string,
  deliver: EmailDelivery = cloudflareEmailDelivery(env),
): Promise<void> {
  const normalizedEmail = normalizeEmail(email);
  const claimHash = await hashToken(claimToken);

  const claim = await env.DIRECTORY.prepare(`
    SELECT ct.id, ct.workspace_id AS workspaceId
    FROM claim_tokens ct
    JOIN workspaces w ON w.id = ct.workspace_id
    WHERE ct.token_hash = ?
      AND ct.used_at IS NULL
      AND ct.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      AND (ct.reserved_until IS NULL OR ct.reserved_until <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      AND w.state = 'unclaimed'
    LIMIT 1
  `)
    .bind(claimHash)
    .first<{ id: string; workspaceId: string }>();
  if (!claim) throw new HttpError(410, "Claim link is invalid or expired");

  const emailBudget = await reserveEmailBudget(env, normalizedEmail);
  if (!emailBudget) throw new HttpError(429, "Email delivery rate limit exceeded");

  const reservationId = crypto.randomUUID();
  const authId = newId("auth");
  const attemptId = newId("email");
  const verification = await newOpaqueToken("verify");
  const reservedUntil = new Date(Date.now() + CLAIM_RESERVATION_MS).toISOString();
  const expiresAt = new Date(Date.now() + CLAIM_TTL_MS).toISOString();

  let results: D1Result<unknown>[];
  try {
    results = await env.DIRECTORY.batch([
    env.DIRECTORY.prepare(`
      UPDATE claim_tokens
      SET reservation_id = ?, reserved_until = ?
      WHERE id = ? AND used_at IS NULL
        AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        AND (reserved_until IS NULL OR reserved_until <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        AND EXISTS (
          SELECT 1 FROM workspaces
          WHERE id = claim_tokens.workspace_id AND state = 'unclaimed'
        )
    `).bind(reservationId, reservedUntil, claim.id),
    env.DIRECTORY.prepare(`
      INSERT INTO auth_tokens (
        id, purpose, token_hash, workspace_id, email_normalized, expires_at
      )
      SELECT ?, 'claim', ?, ?, ?, ?
      FROM claim_tokens
      WHERE id = ? AND reservation_id = ? AND used_at IS NULL
        AND EXISTS (
          SELECT 1 FROM workspaces
          WHERE id = claim_tokens.workspace_id AND state = 'unclaimed'
        )
    `).bind(
      authId,
      verification.hash,
      claim.workspaceId,
      normalizedEmail,
      expiresAt,
      claim.id,
      reservationId,
    ),
    env.DIRECTORY.prepare(`
      INSERT INTO email_attempts (id, auth_token_id, purpose, recipient)
      SELECT ?, ?, 'claim', ?
      FROM auth_tokens WHERE id = ?
    `).bind(attemptId, authId, normalizedEmail, authId),
    ]);
  } catch (error) {
    await releaseQuotaSlots(env, emailBudget.buckets);
    throw error;
  }

  if (
    results[0]!.meta.changes !== 1 ||
    results[1]!.meta.changes !== 1 ||
    results[2]!.meta.changes !== 1
  ) {
    await releaseQuotaSlots(env, emailBudget.buckets);
    throw new HttpError(410, "Claim link is invalid or expired");
  }

  try {
    await deliver(
      claimEmail(
        normalizedEmail,
        `${origin}/verify#token=${encodeURIComponent(verification.token)}`,
      ),
    );
  } catch (error) {
    console.error("Claim verification email send failed", error);
    await releaseQuotaSlots(env, emailBudget.buckets);
    await env.DIRECTORY.batch([
      env.DIRECTORY.prepare("DELETE FROM auth_tokens WHERE id = ?").bind(authId),
      env.DIRECTORY.prepare(`
        UPDATE claim_tokens SET reservation_id = NULL, reserved_until = NULL
        WHERE id = ? AND reservation_id = ? AND used_at IS NULL
      `).bind(claim.id, reservationId),
    ]);
    throw new HttpError(503, "Verification email could not be sent");
  }

  await env.DIRECTORY.batch([
    env.DIRECTORY.prepare(`
      UPDATE email_attempts
      SET status = 'sent', delivered_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ? AND status = 'pending'
    `).bind(attemptId),
    env.DIRECTORY.prepare(`
      UPDATE claim_tokens
      SET used_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
          reservation_id = NULL, reserved_until = NULL
      WHERE id = ? AND reservation_id = ? AND used_at IS NULL
    `).bind(claim.id, reservationId),
  ]);
}

async function createSession(
  env: Env,
  userId: string,
): Promise<{ id: string; token: Awaited<ReturnType<typeof newOpaqueToken>>; expiresAt: string }> {
  return {
    id: newId("session"),
    token: await newOpaqueToken("session"),
    expiresAt: new Date(Date.now() + SESSION_TTL_SECONDS * 1000).toISOString(),
  };
}

export async function verifyClaim(
  env: Env,
  verificationToken: string,
): Promise<{ sessionToken: string; session: HumanSession }> {
  const tokenHash = await hashToken(verificationToken);
  const auth = await env.DIRECTORY.prepare(`
    SELECT at.id, at.workspace_id AS workspaceId, at.email_normalized AS email
    FROM auth_tokens at JOIN workspaces w ON w.id = at.workspace_id
    WHERE at.token_hash = ? AND at.purpose = 'claim' AND at.used_at IS NULL
      AND at.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      AND w.state = 'unclaimed'
    LIMIT 1
  `)
    .bind(tokenHash)
    .first<{ id: string; workspaceId: string; email: string }>();
  if (!auth) throw new HttpError(410, "Verification link is invalid or expired");

  const existing = await env.DIRECTORY.prepare(`
    SELECT id FROM users
    WHERE email_normalized = ? AND email_verified_at IS NOT NULL
    LIMIT 1
  `)
    .bind(auth.email)
    .first<{ id: string }>();
  const userId = existing?.id ?? newId("user");
  const session = await createSession(env, userId);
  const statements: D1PreparedStatement[] = [];
  if (!existing) {
    statements.push(
      env.DIRECTORY.prepare(`
        INSERT INTO users (id, email_normalized, email_verified_at)
        SELECT ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        FROM auth_tokens
        WHERE id = ? AND used_at IS NULL
          AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          AND EXISTS (SELECT 1 FROM workspaces WHERE id = ? AND state = 'unclaimed')
      `).bind(userId, auth.email, auth.id, auth.workspaceId),
    );
  }
  const workspaceCeiling = configuredCeiling(
    env,
    "USER_WORKSPACE_CEILING",
    DEFAULT_USER_WORKSPACE_CEILING,
  );
  statements.push(
    env.DIRECTORY.prepare(`
      INSERT INTO workspace_owners (workspace_id, user_id)
      SELECT ?, ? FROM auth_tokens
      WHERE id = ? AND used_at IS NULL
        AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        AND EXISTS (SELECT 1 FROM workspaces WHERE id = ? AND state = 'unclaimed')
        AND (SELECT COUNT(*) FROM workspace_owners WHERE user_id = ?) < ?
    `).bind(auth.workspaceId, userId, auth.id, auth.workspaceId, userId, workspaceCeiling),
    env.DIRECTORY.prepare(`
      INSERT INTO browser_sessions (id, user_id, token_hash, expires_at)
      SELECT ?, ?, ?, ? FROM auth_tokens
      WHERE id = ? AND used_at IS NULL
        AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        AND EXISTS (
          SELECT 1 FROM workspace_owners WHERE workspace_id = ? AND user_id = ?
        )
    `).bind(
      session.id,
      userId,
      session.token.hash,
      session.expiresAt,
      auth.id,
      auth.workspaceId,
      userId,
    ),
    env.DIRECTORY.prepare(`
      UPDATE auth_tokens SET used_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ? AND used_at IS NULL
        AND EXISTS (
          SELECT 1 FROM workspace_owners WHERE workspace_id = ? AND user_id = ?
        )
    `).bind(auth.id, auth.workspaceId, userId),
    env.DIRECTORY.prepare(`
      UPDATE workspaces
      SET state = 'active', claimed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ? AND state = 'unclaimed'
        AND EXISTS (
          SELECT 1 FROM workspace_owners WHERE workspace_id = ? AND user_id = ?
        )
    `).bind(auth.workspaceId, auth.workspaceId, userId),
  );
  let results: D1Result<unknown>[];
  try {
    results = await env.DIRECTORY.batch(statements);
  } catch {
    throw new HttpError(410, "Verification link is invalid or expired");
  }
  if (results.some((result) => result.meta.changes !== 1)) {
    throw new HttpError(410, "Verification link is invalid, expired, or the account workspace limit was reached");
  }

  return {
    sessionToken: session.token.token,
    session: { userId, workspaceId: auth.workspaceId },
  };
}

export async function requestLoginLink(
  env: Env,
  email: string,
  origin: string,
  deliver: EmailDelivery = cloudflareEmailDelivery(env),
): Promise<void> {
  const normalizedEmail = normalizeEmail(email);
  const owner = await env.DIRECTORY.prepare(`
    SELECT u.id AS userId, wo.workspace_id AS workspaceId
    FROM users u JOIN workspace_owners wo ON wo.user_id = u.id
    JOIN workspaces w ON w.id = wo.workspace_id
    WHERE u.email_normalized = ? AND u.email_verified_at IS NOT NULL
      AND w.state = 'active'
    ORDER BY wo.created_at LIMIT 1
  `)
    .bind(normalizedEmail)
    .first<{ userId: string; workspaceId: string }>();
  if (!owner) return;

  // Client/global request limiting happens before this function is called so
  // unknown accounts cost no more than known accounts. Email budgets are shared
  // with the claim flow and store only keyed recipient hashes.
  const emailBudget = await reserveEmailBudget(env, normalizedEmail);
  if (!emailBudget) return;

  const authId = newId("auth");
  const attemptId = newId("email");
  const login = await newOpaqueToken("login");
  const expiresAt = new Date(Date.now() + LOGIN_TTL_MS).toISOString();
  try {
    // Invalidation and insertion share one transactional D1 batch, preserving
    // the one-outstanding-login-token invariant under concurrent requests.
    await env.DIRECTORY.batch([
      env.DIRECTORY.prepare(`
        UPDATE auth_tokens SET used_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE purpose = 'login' AND user_id = ? AND used_at IS NULL
          AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      `).bind(owner.userId),
      env.DIRECTORY.prepare(`
        INSERT INTO auth_tokens (
          id, purpose, token_hash, workspace_id, user_id, email_normalized, expires_at
        ) VALUES (?, 'login', ?, ?, ?, ?, ?)
      `).bind(
        authId,
        login.hash,
        owner.workspaceId,
        owner.userId,
        normalizedEmail,
        expiresAt,
      ),
      env.DIRECTORY.prepare(`
        INSERT INTO email_attempts (id, auth_token_id, purpose, recipient)
        VALUES (?, ?, 'login', ?)
      `).bind(attemptId, authId, normalizedEmail),
    ]);
  } catch (error) {
    await releaseQuotaSlots(env, emailBudget.buckets);
    throw error;
  }

  try {
    await deliver(
      loginEmail(
        normalizedEmail,
        `${origin}/login#token=${encodeURIComponent(login.token)}`,
      ),
    );
  } catch {
    await releaseQuotaSlots(env, emailBudget.buckets);
    await env.DIRECTORY.prepare("DELETE FROM auth_tokens WHERE id = ?").bind(authId).run();
    return;
  }

  // Delivery cost has occurred and the user has the capability. A bookkeeping
  // failure must not uncount that email or invalidate the usable link.
  try {
    await env.DIRECTORY.prepare(`
      UPDATE email_attempts
      SET status = 'sent', delivered_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ?
    `)
      .bind(attemptId)
      .run();
  } catch (error) {
    console.error("Login email delivery bookkeeping failed", error);
  }
}

export async function consumeLoginToken(
  env: Env,
  loginToken: string,
): Promise<{ sessionToken: string; session: HumanSession }> {
  const tokenHash = await hashToken(loginToken);
  const auth = await env.DIRECTORY.prepare(`
    SELECT at.id, at.user_id AS userId, at.workspace_id AS workspaceId
    FROM auth_tokens at JOIN users u ON u.id = at.user_id
    JOIN workspace_owners wo ON wo.user_id = u.id AND wo.workspace_id = at.workspace_id
    JOIN workspaces w ON w.id = wo.workspace_id
    WHERE at.token_hash = ? AND at.purpose = 'login' AND at.used_at IS NULL
      AND at.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      AND u.email_verified_at IS NOT NULL AND w.state = 'active'
    LIMIT 1
  `)
    .bind(tokenHash)
    .first<{ id: string; userId: string; workspaceId: string }>();
  if (!auth) throw new HttpError(410, "Sign-in link is invalid or expired");
  const session = await createSession(env, auth.userId);
  const results = await env.DIRECTORY.batch([
    env.DIRECTORY.prepare(`
      INSERT INTO browser_sessions (id, user_id, token_hash, expires_at)
      SELECT ?, ?, ?, ? FROM auth_tokens
      WHERE id = ? AND used_at IS NULL
    `).bind(session.id, auth.userId, session.token.hash, session.expiresAt, auth.id),
    env.DIRECTORY.prepare(`
      UPDATE auth_tokens SET used_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ? AND used_at IS NULL
    `).bind(auth.id),
  ]);
  if (results[0]!.meta.changes !== 1 || results[1]!.meta.changes !== 1) {
    throw new HttpError(410, "Sign-in link is invalid or expired");
  }
  return {
    sessionToken: session.token.token,
    session: { userId: auth.userId, workspaceId: auth.workspaceId },
  };
}

function bearerToken(request: Request): string {
  const match = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i);
  if (!match?.[1]) throw new HttpError(401, "Unauthorized");
  return match[1];
}

export async function requireAgent(
  env: Env,
  request: Request,
  workspaceId: string,
  scope: "read" | "write",
): Promise<AgentIdentity> {
  const hash = await hashToken(bearerToken(request));
  const row = await env.DIRECTORY.prepare(`
    SELECT ac.id AS credentialId, ac.workspace_id AS workspaceId,
      ac.scopes_json AS scopesJson
    FROM agent_credentials ac
    JOIN workspaces w ON w.id = ac.workspace_id
    WHERE ac.token_hash = ?
      AND ac.workspace_id = ?
      AND ac.status = 'active'
      AND w.state IN ('unclaimed', 'active')
    LIMIT 1
  `)
    .bind(hash, workspaceId)
    .first<{ credentialId: string; workspaceId: string; scopesJson: string }>();
  if (!row) throw new HttpError(401, "Unauthorized");

  const scopes = JSON.parse(row.scopesJson) as string[];
  if (!scopes.includes(scope)) throw new HttpError(403, "Insufficient scope");

  await enforceAgentRequestLimits(env, row.credentialId, row.workspaceId, scope === "write");

  await env.DIRECTORY.prepare(`
    UPDATE agent_credentials
    SET last_used_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = ?
  `)
    .bind(row.credentialId)
    .run();

  return {
    credentialId: row.credentialId,
    workspaceId: row.workspaceId,
    scopes,
  };
}

export async function requireHuman(
  env: Env,
  request: Request,
  workspaceId: string,
): Promise<HumanSession> {
  const sessionToken = parseCookies(request).get("frank_session");
  if (!sessionToken) throw new HttpError(401, "Unauthorized");
  const hash = await hashToken(sessionToken);
  const row = await env.DIRECTORY.prepare(`
    SELECT bs.id AS sessionId, bs.user_id AS userId, wo.workspace_id AS workspaceId
    FROM browser_sessions bs
    JOIN workspace_owners wo ON wo.user_id = bs.user_id
    JOIN workspaces w ON w.id = wo.workspace_id
    WHERE bs.token_hash = ?
      AND wo.workspace_id = ?
      AND bs.revoked_at IS NULL
      AND bs.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      AND w.state = 'active'
    LIMIT 1
  `)
    .bind(hash, workspaceId)
    .first<HumanSession & { sessionId: string }>();
  if (!row) throw new HttpError(401, "Unauthorized");
  const minute = minuteBucket();
  const allowed = await reserveAllOrRelease(env, [
    {
      bucket: `human:${minute}:session:${row.sessionId}`,
      ceiling: configuredCeiling(env, "HUMAN_SESSION_MINUTE_CEILING", DEFAULT_HUMAN_SESSION_MINUTE_CEILING),
    },
    {
      bucket: `workspace:${minute}:${row.workspaceId}`,
      ceiling: configuredCeiling(env, "WORKSPACE_MINUTE_CEILING", DEFAULT_WORKSPACE_MINUTE_CEILING),
    },
  ]);
  if (!allowed) throw new HttpError(429, "Workspace request rate limit exceeded. Try again later.");
  return { userId: row.userId, workspaceId: row.workspaceId };
}

export async function revokeAgentCredential(
  env: Env,
  workspaceId: string,
  credentialId: string,
): Promise<void> {
  const result = await env.DIRECTORY.prepare(`
    UPDATE agent_credentials
    SET status = 'revoked',
        revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = ? AND workspace_id = ? AND status = 'active'
  `)
    .bind(credentialId, workspaceId)
    .run();
  if (result.meta.changes !== 1) {
    throw new HttpError(404, "Agent credential not found");
  }
}

export async function revokeHumanSession(env: Env, request: Request): Promise<void> {
  const token = parseCookies(request).get("frank_session");
  if (!token) return;
  const hash = await hashToken(token);
  await env.DIRECTORY.prepare(`
    UPDATE browser_sessions
    SET revoked_at = COALESCE(revoked_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    WHERE token_hash = ?
  `).bind(hash).run();
}

export function sessionCookie(token: string): string {
  return [
    `frank_session=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    `Max-Age=${SESSION_TTL_SECONDS}`,
  ].join("; ");
}

export function clearSessionCookie(): string {
  return [
    "frank_session=",
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    "Max-Age=0",
  ].join("; ");
}

export interface ShareToken {
  id: string;
  token: string;
  prefix: string;
  expiresAt: string;
}

/**
 * Create a read-only dashboard share token for a workspace. The token is
 * returned once (in plaintext) and stored only as a SHA-256 hash. The owner
 * can revoke it later, which immediately invalidates the share link.
 */
export async function createShareToken(
  env: Env,
  workspaceId: string,
): Promise<ShareToken> {
  const id = newId("share");
  const opaque = await newOpaqueToken("share");
  const expiresAt = new Date(Date.now() + SHARE_TTL_MS).toISOString();
  await env.DIRECTORY.prepare(`
    INSERT INTO share_tokens (id, workspace_id, token_hash, token_prefix, expires_at)
    VALUES (?, ?, ?, ?, ?)
  `)
    .bind(id, workspaceId, opaque.hash, opaque.prefix, expiresAt)
    .run();
  return {
    id,
    token: opaque.token,
    prefix: opaque.prefix,
    expiresAt,
  };
}

/**
 * Resolve a share token to its workspace, or throw 401/410 if it is invalid,
 * expired, or revoked. Read-only by construction: it only ever authorizes
 * dashboard read routes.
 */
export async function requireShareToken(
  env: Env,
  token: string,
): Promise<{ workspaceId: string }> {
  const hash = await hashToken(token);
  const row = await env.DIRECTORY.prepare(`
    SELECT st.workspace_id AS workspaceId
    FROM share_tokens st
    JOIN workspaces w ON w.id = st.workspace_id
    WHERE st.token_hash = ?
      AND st.revoked_at IS NULL
      AND st.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      AND w.state = 'active'
    LIMIT 1
  `)
    .bind(hash)
    .first<{ workspaceId: string }>();
  if (!row) throw new HttpError(401, "Share link is invalid, expired, or revoked");
  return row;
}

/**
 * Revoke a workspace's share token(s). Returns the number revoked. The owner
 * calls this to invalidate a share link after it has been handed out.
 */
export async function revokeShareToken(
  env: Env,
  workspaceId: string,
  shareTokenId: string,
): Promise<number> {
  const result = await env.DIRECTORY.prepare(`
    UPDATE share_tokens
    SET revoked_at = COALESCE(revoked_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    WHERE id = ? AND workspace_id = ? AND revoked_at IS NULL
  `)
    .bind(shareTokenId, workspaceId)
    .run();
  return result.meta.changes;
}

/**
 * List a workspace's active (non-revoked, non-expired) share tokens so the
 * owner can see and revoke them from the dashboard.
 */
export async function listShareTokens(
  env: Env,
  workspaceId: string,
): Promise<Array<{ id: string; prefix: string; createdAt: string; expiresAt: string }>> {
  const rows = await env.DIRECTORY.prepare(`
    SELECT id, token_prefix AS prefix, created_at AS createdAt, expires_at AS expiresAt
    FROM share_tokens
    WHERE workspace_id = ?
      AND revoked_at IS NULL
      AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    ORDER BY created_at DESC
  `)
    .bind(workspaceId)
    .all<{ id: string; prefix: string; createdAt: string; expiresAt: string }>();
  return rows.results;
}

/**
 * Soft-delete workspaces that were bootstrapped but never claimed within the
 * claim window. This prevents abandoned unclaimed workspaces (and their agent
 * credentials
 * / claim tokens) from accumulating indefinitely. Runs on a scheduled trigger.
 * Cleanup revokes every agent credential for the abandoned workspace and
 * decrements the atomic live-workspace counter. Time-scoped rate-limit buckets
 * expire naturally by using a new clock-hour key.
 *
 * @returns the number of workspaces cleaned up.
 */
export async function cleanupAbandonedWorkspaces(env: Env): Promise<number> {
  const cutoff = new Date(Date.now() - CLAIM_TTL_MS).toISOString();
  const batchSize = Math.max(
    1,
    Math.min(100, Math.trunc(configuredCeiling(env, "CLEANUP_BATCH_SIZE", DEFAULT_CLEANUP_BATCH_SIZE))),
  );
  const candidates = await env.DIRECTORY.prepare(`
    SELECT id, state, bootstrap_mode AS bootstrapMode FROM workspaces
    WHERE (state = 'unclaimed' AND created_at < ?) OR state = 'deleting'
    ORDER BY created_at
    LIMIT ?
  `).bind(cutoff, batchSize).all<{
    id: string;
    state: "unclaimed" | "deleting";
    bootstrapMode: "public" | "operator";
  }>();

  let cleaned = 0;
  for (const candidate of candidates.results) {
    try {
      if (candidate.state === "unclaimed") {
        // Claim the row for cleanup first. Once state is deleting, claim and
        // agent authorization queries stop accepting every capability.
        const transition = await env.DIRECTORY.prepare(`
          UPDATE workspaces
          SET state = 'deleting', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          WHERE id = ? AND state = 'unclaimed' AND created_at < ?
        `).bind(candidate.id, cutoff).run();
        if (transition.meta.changes !== 1) continue;
        await env.DIRECTORY.batch([
          env.DIRECTORY.prepare(`
            UPDATE agent_credentials
            SET status = 'revoked', revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
            WHERE workspace_id = ? AND status = 'active'
          `).bind(candidate.id),
          env.DIRECTORY.prepare(`
            UPDATE claim_tokens
            SET used_at = COALESCE(used_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
                reservation_id = NULL, reserved_until = NULL
            WHERE workspace_id = ?
          `).bind(candidate.id),
          env.DIRECTORY.prepare(`
            UPDATE auth_tokens
            SET used_at = COALESCE(used_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
            WHERE workspace_id = ?
          `).bind(candidate.id),
        ]);
      }

      await env.WORKSPACES.getByName(candidate.id).deleteAllData();
      const finalized = await env.DIRECTORY.prepare(`
        UPDATE workspaces
        SET state = 'deleted', deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = ? AND state = 'deleting'
      `).bind(candidate.id).run();
      if (finalized.meta.changes === 1) {
        // Finalization is the authoritative capacity release. If the process
        // stops after marking the row deleted but before these decrements, the
        // counters remain conservatively high rather than admitting overshoot.
        const buckets = candidate.bootstrapMode === "public"
          ? ["live", "live:public"]
          : ["live"];
        await releaseQuotaSlots(env, buckets);
        cleaned += 1;
      }
    } catch (error) {
      // Leave deleting rows retryable and continue housekeeping for unrelated
      // workspaces rather than aborting the entire cron.
      console.error(`Abandoned workspace cleanup failed for ${candidate.id}`, error);
    }
  }

  // Expired pending rows own capacity but can no longer complete. Release their
  // fixed live buckets and delete them in one D1 transaction so the decrements
  // exactly match the rows being purged.
  await env.DIRECTORY.batch([
    env.DIRECTORY.prepare(`
      UPDATE bootstrap_quota
      SET count = MAX(count - (
        SELECT COUNT(*) FROM bootstrap_idempotency bi
        WHERE bi.status = 'pending' AND bi.quota_reserved = 1
          AND bi.expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          AND NOT EXISTS (SELECT 1 FROM workspaces w WHERE w.id = bi.workspace_id)
      ), 0)
      WHERE bucket = 'live'
    `),
    env.DIRECTORY.prepare(`
      UPDATE bootstrap_quota
      SET count = MAX(count - (
        SELECT COUNT(*) FROM bootstrap_idempotency bi
        WHERE bi.status = 'pending' AND bi.quota_reserved = 1
          AND bi.bootstrap_mode = 'public'
          AND bi.expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          AND NOT EXISTS (SELECT 1 FROM workspaces w WHERE w.id = bi.workspace_id)
      ), 0)
      WHERE bucket = 'live:public'
    `),
    env.DIRECTORY.prepare(`
      DELETE FROM bootstrap_idempotency
      WHERE status = 'pending' AND quota_reserved = 1
        AND expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        AND NOT EXISTS (SELECT 1 FROM workspaces w WHERE w.id = bootstrap_idempotency.workspace_id)
    `),
  ]);

  // Reconciliation is deliberately upward-only. An in-flight bootstrap may
  // have incremented live counters just before its durable pending row exists;
  // lowering the counters here would erase that reservation and permit an
  // overshoot. Explicit finalization/expiry paths above perform safe decrements.
  await env.DIRECTORY.batch([
    env.DIRECTORY.prepare(`
      INSERT INTO bootstrap_quota (bucket, count)
      SELECT 'live',
        (SELECT COUNT(*) FROM workspaces WHERE state IN ('unclaimed', 'active')) +
        (SELECT COUNT(*) FROM bootstrap_idempotency bi
         WHERE bi.status = 'pending' AND bi.quota_reserved = 1
           AND bi.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
           AND NOT EXISTS (SELECT 1 FROM workspaces w WHERE w.id = bi.workspace_id))
      ON CONFLICT(bucket) DO UPDATE SET count = MAX(count, excluded.count)
    `),
    env.DIRECTORY.prepare(`
      INSERT INTO bootstrap_quota (bucket, count)
      SELECT 'live:public',
        (SELECT COUNT(*) FROM workspaces
         WHERE state IN ('unclaimed', 'active') AND bootstrap_mode = 'public') +
        (SELECT COUNT(*) FROM bootstrap_idempotency bi
         WHERE bi.status = 'pending' AND bi.quota_reserved = 1
           AND bi.bootstrap_mode = 'public'
           AND bi.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
           AND NOT EXISTS (SELECT 1 FROM workspaces w WHERE w.id = bi.workspace_id))
      ON CONFLICT(bucket) DO UPDATE SET count = MAX(count, excluded.count)
    `),
  ]);

  const currentHour = new Date().toISOString().slice(0, 13);
  const currentMinute = new Date().toISOString().slice(0, 16);
  const retentionDays = Math.max(
    1,
    Math.trunc(configuredCeiling(env, "DELETED_WORKSPACE_RETENTION_DAYS", DEFAULT_DELETED_RETENTION_DAYS)),
  );
  const tombstoneCutoff = new Date(Date.now() - retentionDays * 86400000).toISOString();
  await env.DIRECTORY.batch([
    env.DIRECTORY.prepare(`
      DELETE FROM bootstrap_quota
      WHERE bucket NOT IN ('live', 'live:public')
        AND instr(bucket, ?) = 0
        AND instr(bucket, ?) = 0
    `).bind(currentHour, currentMinute),
    env.DIRECTORY.prepare(
      "DELETE FROM bootstrap_idempotency WHERE expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
    ),
    env.DIRECTORY.prepare(
      "DELETE FROM auth_tokens WHERE expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now') OR used_at IS NOT NULL",
    ),
    env.DIRECTORY.prepare(
      "DELETE FROM browser_sessions WHERE expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now') OR revoked_at IS NOT NULL",
    ),
    env.DIRECTORY.prepare(`
      DELETE FROM email_attempts
      WHERE created_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-30 days')
    `),
    env.DIRECTORY.prepare(`
      DELETE FROM bootstrap_idempotency
      WHERE workspace_id IN (
        SELECT id FROM workspaces WHERE state = 'deleted' AND deleted_at < ?
      )
    `).bind(tombstoneCutoff),
    env.DIRECTORY.prepare(
      "DELETE FROM workspaces WHERE state = 'deleted' AND deleted_at < ?",
    ).bind(tombstoneCutoff),
  ]);
  return cleaned;
}
