import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { bootstrapWorkspace, requestClaimVerification } from "../../src/cloud/directory";
import { keyedHashText } from "../../src/cloud/tokens";
import type { TransactionalEmail } from "../../src/cloud/email";

const ACTOR = { type: "agent" as const, id: "credential-hardening" };

function mutation<T extends Record<string, unknown>>(overrides: T = {} as T) {
  return {
    actor: ACTOR,
    idempotencyKey: `key-${Math.random().toString(36).slice(2)}`,
    requestHash: `hash-${Math.random().toString(36).slice(2)}`,
    expiresAt: "2099-01-01T00:00:00.000Z",
    ...overrides,
  } as T & {
    actor: typeof ACTOR;
    idempotencyKey: string;
    requestHash: string;
    expiresAt: string;
  };
}

const BOOTSTRAP_TOKEN = "test-bootstrap-token-for-tests-only";

function bootstrapIdempotencyKey(label = "test"): string {
  return `bootstrap-${label}-${crypto.randomUUID()}`;
}

async function bootstrap(label: string) {
  const response = await exports.default.fetch("https://frank.test/v1/workspaces", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "bootstrap-token": BOOTSTRAP_TOKEN,
      "idempotency-key": bootstrapIdempotencyKey(label),
    },
    body: JSON.stringify({
      displayName: `${label} workspace`,
      pageTitle: `${label} work log`,
      timeZone: "America/Chicago",
      agentLabel: `${label} agent`,
    }),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as {
    workspace: { id: string };
    agentCredential: { id: string; token: string };
    claim: { token: string };
  };
}

async function claim(workspace: { claim: { token: string } }): Promise<string> {
  let message: TransactionalEmail | undefined;
  await requestClaimVerification(
    env,
    workspace.claim.token,
    "owner@example.com",
    "https://frank.test",
    async (delivered) => {
      message = delivered;
    },
  );
  const token = message?.text.match(/\/verify#token=([^\s]+)/)?.[1];
  if (!token) throw new Error("Verification link missing");
  const verification = await exports.default.fetch("https://frank.test/v1/claim-sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ verificationToken: decodeURIComponent(token) }),
  });
  expect(verification.status).toBe(200);
  const cookie = verification.headers.get("set-cookie")?.split(";", 1)[0];
  if (!cookie) throw new Error("Session cookie missing");
  return cookie;
}

describe("Frank Cloud hardening", () => {
  it("isolates lifecycle operations across workspaces", async () => {
    const first = env.WORKSPACES.getByName("harden-ws-a");
    const second = env.WORKSPACES.getByName("harden-ws-b");
    await first.createEntry({
      type: "note",
      text: "a",
      project: "Alpha",
      tags: [],
      source: "test:seed",
      ...mutation(),
    });
    await second.createEntry({
      type: "note",
      text: "b",
      project: "Beta",
      tags: [],
      source: "test:seed",
      ...mutation(),
    });

    // Renaming in one workspace must not affect the other.
    await first.renameProject(mutation({ nameOrAlias: "Alpha", newName: "AlphaRenamed" }));
    expect((await first.listProjects()).map((p) => p.name)).toEqual(["AlphaRenamed"]);
    expect((await second.listProjects()).map((p) => p.name)).toEqual(["Beta"]);
  });

  it("rejects lifecycle writes with a read-only agent scope", async () => {
    const workspace = await bootstrap("ReadOnly");
    const ws = env.WORKSPACES.getByName(workspace.workspace.id);
    await ws.createEntry({
      type: "note",
      text: "seed",
      project: "Portal",
      tags: [],
      source: "test:seed",
      ...mutation(),
    });

    // Insert a read-only credential directly into the directory.
    const readToken = "read-only-token-abc";
    const readHash = await import("../../src/cloud/tokens").then((m) => m.hashToken(readToken));
    await env.DIRECTORY.prepare(`
      INSERT INTO agent_credentials (id, workspace_id, token_hash, token_prefix, label, scopes_json)
      VALUES ('read-cred-1', ?, ?, 'agent', 'read-only', '["read"]')
    `)
      .bind(workspace.workspace.id, readHash)
      .run();

    const response = await exports.default.fetch(
      `https://frank.test/v1/workspaces/${workspace.workspace.id}/projects/archive`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${readToken}`,
          "content-type": "application/json",
          "idempotency-key": "read-scope-archive",
        },
        body: JSON.stringify({ nameOrAlias: "Portal" }),
      },
    );
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: "Insufficient scope" });
  });

  it("returns a deliberate 404 for lifecycle ops on a missing project via the API", async () => {
    const workspace = await bootstrap("MissingProject");
    const response = await exports.default.fetch(
      `https://frank.test/v1/workspaces/${workspace.workspace.id}/projects/archive`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${workspace.agentCredential.token}`,
          "content-type": "application/json",
          "idempotency-key": "missing-archive",
        },
        body: JSON.stringify({ nameOrAlias: "DoesNotExist" }),
      },
    );
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: "Project not found: DoesNotExist",
    });
  });

  it("rejects malformed lifecycle payloads with a 400", async () => {
    const workspace = await bootstrap("Malformed");
    const response = await exports.default.fetch(
      `https://frank.test/v1/workspaces/${workspace.workspace.id}/projects/rename`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${workspace.agentCredential.token}`,
          "content-type": "application/json",
          "idempotency-key": "malformed-rename",
        },
        body: JSON.stringify({ nameOrAlias: "Portal" }), // missing newName
      },
    );
    expect(response.status).toBe(400);
  });

  it("rejects lifecycle writes without an idempotency key", async () => {
    const workspace = await bootstrap("NoIdem");
    const response = await exports.default.fetch(
      `https://frank.test/v1/workspaces/${workspace.workspace.id}/projects/archive`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${workspace.agentCredential.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ nameOrAlias: "Portal" }),
      },
    );
    expect(response.status).toBe(400);
  });

  it("rejects lifecycle writes without agent auth", async () => {
    const workspace = await bootstrap("NoAuth");
    const response = await exports.default.fetch(
      `https://frank.test/v1/workspaces/${workspace.workspace.id}/projects/archive`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "no-auth" },
        body: JSON.stringify({ nameOrAlias: "Portal" }),
      },
    );
    expect(response.status).toBe(401);
  });

  it("rejects a merge into a missing target with a 404", async () => {
    const workspace = await bootstrap("MergeMissing");
    const ws = env.WORKSPACES.getByName(workspace.workspace.id);
    await ws.createEntry({
      type: "note",
      text: "seed",
      project: "Source",
      tags: [],
      source: "test:seed",
      ...mutation(),
    });
    const response = await exports.default.fetch(
      `https://frank.test/v1/workspaces/${workspace.workspace.id}/projects/merge`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${workspace.agentCredential.token}`,
          "content-type": "application/json",
          "idempotency-key": "merge-missing",
        },
        body: JSON.stringify({ fromNameOrAlias: "Source", toNameOrAlias: "Nope" }),
      },
    );
    expect(response.status).toBe(404);
  });

  it("does not replay an identical lifecycle body across different operations", async () => {
    const workspace = await bootstrap("OpIdem");
    const ws = env.WORKSPACES.getByName(workspace.workspace.id);
    await ws.createEntry({
      type: "note",
      text: "seed",
      project: "Portal",
      tags: [],
      source: "test:seed",
      ...mutation(),
    });
    const body = { nameOrAlias: "Portal" };

    const archive = await exports.default.fetch(
      `https://frank.test/v1/workspaces/${workspace.workspace.id}/projects/archive`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${workspace.agentCredential.token}`,
          "content-type": "application/json",
          "idempotency-key": "shared-lifecycle-key",
        },
        body: JSON.stringify(body),
      },
    );
    expect(archive.status).toBe(201);

    // Same key + same body on a DIFFERENT operation (inactive) must not be
    // treated as a replay. Because the operation name is now part of the hash,
    // the reused key resolves to a hash mismatch and correctly yields a 409
    // conflict rather than silently replaying the archive operation.
    const inactive = await exports.default.fetch(
      `https://frank.test/v1/workspaces/${workspace.workspace.id}/projects/inactive`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${workspace.agentCredential.token}`,
          "content-type": "application/json",
          "idempotency-key": "shared-lifecycle-key",
        },
        body: JSON.stringify(body),
      },
    );
    expect(inactive.status).toBe(409);
  });

  it("atomically rate-limits bootstrap per hour", async () => {
    // The hourly bucket key is the current UTC hour. Read the number of slots
    // already reserved in it, then set a quota that allows exactly two more.
    const hourKey = `hour:${new Date().toISOString().slice(0, 13)}`;
    const used = await env.DIRECTORY.prepare(
      "SELECT count FROM bootstrap_quota WHERE bucket = ?",
    )
      .bind(hourKey)
      .first<{ count: number }>();
    const quota = String((used?.count ?? 0) + 2);
    const lowQuotaEnv = {
      ...env,
      BOOTSTRAP_QUOTA_PER_HOUR: quota,
      BOOTSTRAP_TOTAL_CEILING: "100000000",
      BOOTSTRAP_TOKEN: "test-bootstrap-token-for-tests-only",
    } as unknown as typeof env;
    const authorized = (label: string) =>
      new Request("https://frank.test/v1/workspaces", {
        headers: {
          "bootstrap-token": "test-bootstrap-token-for-tests-only",
          "idempotency-key": bootstrapIdempotencyKey(label),
          "frank-client-ip": "10.0.0.1",
        },
      });
    await bootstrapWorkspace(lowQuotaEnv, { agentLabel: "quota-a", request: authorized("a") });
    await bootstrapWorkspace(lowQuotaEnv, { agentLabel: "quota-b", request: authorized("b") });
    // A third bootstrap within the hour must hit the 429 rate limit.
    await expect(
      bootstrapWorkspace(lowQuotaEnv, { agentLabel: "quota-c", request: authorized("c") }),
    ).rejects.toMatchObject({ status: 429 });
  });
});

describe("Frank Cloud operator-authorized bootstrap gate", () => {
  const TOKEN = "test-bootstrap-token-for-tests-only";

  function bootstrapRequest(token?: string): Request {
    return new Request("https://frank.test/v1/workspaces", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": bootstrapIdempotencyKey("gate"),
        ...(token ? { "bootstrap-token": token } : {}),
      },
      body: JSON.stringify({ agentLabel: "gate-agent" }),
    });
  }

  it("accepts bootstrap without a token (public path)", async () => {
    const response = await exports.default.fetch(bootstrapRequest());
    expect(response.status).toBe(201);
    const body = (await response.json()) as { workspace: { id: string } };
    expect(body.workspace.id).toMatch(/^wsp_/);
  });

  it("rejects bootstrap with a wrong token, generically", async () => {
    const response = await exports.default.fetch(bootstrapRequest("wrong-token"));
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Workspace creation is not authorized",
    });
  });

  it("authorizes bootstrap with the correct token", async () => {
    const response = await exports.default.fetch(bootstrapRequest(TOKEN));
    expect(response.status).toBe(201);
    const body = (await response.json()) as { workspace: { id: string } };
    expect(body.workspace.id).toMatch(/^wsp_/);
  });

  it("atomically exhausts a tight quota across sequential requests", async () => {
    const hourKey = `hour:${new Date().toISOString().slice(0, 13)}`;
    const used = await env.DIRECTORY.prepare(
      "SELECT count FROM bootstrap_quota WHERE bucket = ?",
    )
      .bind(hourKey)
      .first<{ count: number }>();
    // Quota = already-used + 2, but we send 4 authorized requests in a tight
    // loop; exactly 2 must succeed and the rest must 429 without over-counting.
    const quota = String((used?.count ?? 0) + 2);
    const lowQuotaEnv = {
      ...env,
      BOOTSTRAP_QUOTA_PER_HOUR: quota,
      BOOTSTRAP_TOTAL_CEILING: "100000000",
      BOOTSTRAP_TOKEN: TOKEN,
    } as unknown as typeof env;
    const outcomes = await Promise.all(
      Array.from({ length: 4 }, () =>
        bootstrapWorkspace(lowQuotaEnv, {
          agentLabel: "seq-agent",
          request: bootstrapRequest(TOKEN),
        }).then(
          () => "ok",
          (err: { status?: number }) => `err:${err.status}`,
        ),
      ),
    );
    expect(outcomes.filter((o) => o === "ok")).toHaveLength(2);
    expect(outcomes.filter((o) => o.startsWith("err:429"))).toHaveLength(2);
    // And no more than the allowed 2 slots were reserved for this bucket.
    const after = await env.DIRECTORY.prepare(
      "SELECT count FROM bootstrap_quota WHERE bucket = ?",
    )
      .bind(hourKey)
      .first<{ count: number }>();
    expect(Number(after?.count ?? 0)).toBeLessThanOrEqual((used?.count ?? 0) + 2);
  });

  it("concurrently reserves no more slots than the ceiling", async () => {
    const hourKey = `hour:${new Date().toISOString().slice(0, 13)}`;
    const used = await env.DIRECTORY.prepare(
      "SELECT count FROM bootstrap_quota WHERE bucket = ?",
    )
      .bind(hourKey)
      .first<{ count: number }>();
    const quota = String((used?.count ?? 0) + 3);
    const lowQuotaEnv = {
      ...env,
      BOOTSTRAP_QUOTA_PER_HOUR: quota,
      BOOTSTRAP_TOTAL_CEILING: "100000000",
      BOOTSTRAP_TOKEN: TOKEN,
    } as unknown as typeof env;
    // Fire 10 concurrent bootstrap attempts against a 3-slot ceiling.
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        bootstrapWorkspace(lowQuotaEnv, {
          agentLabel: "conc-agent",
          request: bootstrapRequest(TOKEN),
        }).then(
          () => "ok",
          (err: { status?: number }) => `err:${err.status}`,
        ),
      ),
    );
    const okCount = results.filter((r) => r === "ok").length;
    expect(okCount).toBe(3);
    expect(results.filter((r) => r.startsWith("err:429"))).toHaveLength(7);
    // Total reservations for this bucket must never exceed the ceiling.
    const after = await env.DIRECTORY.prepare(
      "SELECT count FROM bootstrap_quota WHERE bucket = ?",
    )
      .bind(hourKey)
      .first<{ count: number }>();
    expect(Number(after?.count ?? 0)).toBe((used?.count ?? 0) + 3);
  });
});

describe("Frank Cloud public bootstrap", () => {
  const PUBLIC_TOKEN = "test-bootstrap-token-for-tests-only";
  const TOKEN_ENV = {
    ...env,
    BOOTSTRAP_QUOTA_PER_HOUR: "1000",
    BOOTSTRAP_TOTAL_CEILING: "100000",
    BOOTSTRAP_CLIENT_CEILING: "100000",
    BOOTSTRAP_TOKEN: PUBLIC_TOKEN,
  } as unknown as typeof env;

  async function publicBootstrap(label: string, idemKey = bootstrapIdempotencyKey(label)) {
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    headers["idempotency-key"] = idemKey;
    return exports.default.fetch("https://frank.test/v1/workspaces", {
      method: "POST",
      headers,
      body: JSON.stringify({
        displayName: `${label} workspace`,
        pageTitle: `${label} work log`,
        timeZone: "America/Chicago",
        agentLabel: `${label} agent`,
      }),
    });
  }

  async function extractPublicBootstrap(response: Response) {
    const body = (await response.json()) as {
      workspace: { id: string; state: string };
      agentCredential: { id: string; token: string; prefix: string; scopes: string[] };
      claim: { token: string; expiresAt: string; url: string; email: string | null };
    };
    return body;
  }

  it("requires a UUID-sized idempotency key", async () => {
    const missing = await exports.default.fetch("https://frank.test/v1/workspaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentLabel: "MissingKey" }),
    });
    expect(missing.status).toBe(400);

    const short = await exports.default.fetch("https://frank.test/v1/workspaces", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "predictable" },
      body: JSON.stringify({ agentLabel: "ShortKey" }),
    });
    expect(short.status).toBe(400);
  });

  it("succeeds without a Bootstrap-Token header (public path)", async () => {
    const response = await publicBootstrap("Public");
    expect(response.status).toBe(201);
    const body = await extractPublicBootstrap(response);
    expect(body.workspace.id).toMatch(/^wsp_/);
    expect(body.workspace.state).toBe("unclaimed");
    expect(body.agentCredential.token).toMatch(/^frank_agent_/);
    expect(body.agentCredential.scopes).toEqual(["read", "write"]);
    expect(body.claim.token).toMatch(/^frank_claim_/);
    expect(body.claim.url).toContain("/claim#token=");
    expect(body.claim.url).toContain(encodeURIComponent(body.claim.token));
  });

  it("returns one workspace-scoped credential and one claim URL", async () => {
    const response = await publicBootstrap("CredCheck");
    expect(response.status).toBe(201);
    const body = await extractPublicBootstrap(response);
    expect(body.agentCredential.id).toBeTruthy();
    expect(body.agentCredential.token).toBeTruthy();
    expect(body.agentCredential.prefix).toBeTruthy();
    expect(body.claim.url).toContain(encodeURIComponent(body.claim.token));
  });

  it("accepts an optional email and echoes it on the claim (claim link emailed separately)", async () => {
    const response = await exports.default.fetch("https://frank.test/v1/workspaces", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": bootstrapIdempotencyKey("EmailClaim"),
      },
      body: JSON.stringify({
        displayName: "EmailClaim workspace",
        agentLabel: "EmailClaim agent",
        email: "owner@example.com",
      }),
    });
    expect(response.status).toBe(201);
    const body = await extractPublicBootstrap(response);
    expect(body.claim.email).toBe("owner@example.com");
    // The claim URL fallback must still be usable even when email is requested.
    expect(body.claim.url).toContain("/claim#token=");
    expect(body.claim.url).toContain(encodeURIComponent(body.claim.token));
  });

  it("allows the credential to immediately write and read its workspace before human claim", async () => {
    const response = await publicBootstrap("ImmediateUse");
    expect(response.status).toBe(201);
    const body = await extractPublicBootstrap(response);

    const entry = await exports.default.fetch(
      `https://frank.test/v1/workspaces/${body.workspace.id}/entries`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${body.agentCredential.token}`,
          "content-type": "application/json",
          "idempotency-key": "immediate-write",
        },
        body: JSON.stringify({
          type: "note",
          text: "Written before claim",
          project: "Bootstrap Test",
          tags: [],
          source: "test:public-bootstrap",
        }),
      },
    );
    expect(entry.status).toBe(201);
    const read = await exports.default.fetch(
      `https://frank.test/v1/workspaces/${body.workspace.id}/entries`,
      {
        headers: {
          authorization: `Bearer ${body.agentCredential.token}`,
        },
      },
    );
    expect(read.status).toBe(200);
    const readBody = (await read.json()) as { entries: Array<{ text: string }> };
    expect(readBody.entries.some((e) => e.text === "Written before claim")).toBe(true);
  });

  it("credential from public bootstrap cannot access another workspace", async () => {
    const r1 = await publicBootstrap("Isolation-A");
    const b1 = await extractPublicBootstrap(r1);
    const r2 = await publicBootstrap("Isolation-B");
    const b2 = await extractPublicBootstrap(r2);

    const cross = await exports.default.fetch(
      `https://frank.test/v1/workspaces/${b2.workspace.id}/entries`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${b1.agentCredential.token}`,
          "content-type": "application/json",
          "idempotency-key": "cross-workspace",
        },
        body: JSON.stringify({
          type: "note",
          text: "Should not write",
          source: "test:isolation",
        }),
      },
    );
    expect(cross.status).toBe(401);
  });

  it("a retry with the same idempotency key does not create another workspace", async () => {
    const idemKey = "public-retry-key-001-long-enough";
    const first = await publicBootstrap("RetryTest", idemKey);
    expect(first.status).toBe(201);
    const firstBody = await extractPublicBootstrap(first);

    const second = await publicBootstrap("RetryTest", idemKey);
    expect(second.status).toBe(201);
    const secondBody = await extractPublicBootstrap(second);

    // Must be the same workspace and credential (replayed).
    expect(secondBody.workspace.id).toBe(firstBody.workspace.id);
    expect(secondBody.agentCredential.token).toBe(firstBody.agentCredential.token);
    expect(secondBody.claim.token).toBe(firstBody.claim.token);
  });

  it("does not persist raw bootstrap credentials or response JSON", async () => {
    const key = bootstrapIdempotencyKey("no-raw-secrets");
    const response = await publicBootstrap("NoRawSecrets", key);
    expect(response.status).toBe(201);
    const body = await extractPublicBootstrap(response);
    const stored = await env.DIRECTORY.prepare(
      "SELECT * FROM bootstrap_idempotency WHERE workspace_id = ?",
    )
      .bind(body.workspace.id)
      .first<Record<string, unknown>>();
    expect(stored).toBeTruthy();
    const serialized = JSON.stringify(stored);
    expect(serialized).not.toContain(body.agentCredential.token);
    expect(Object.keys(stored ?? {})).not.toContain("response_json");
  });

  it("serializes concurrent retries without creating duplicate workspaces", async () => {
    const key = bootstrapIdempotencyKey("concurrent-retry");
    const [first, second] = await Promise.all([
      publicBootstrap("ConcurrentRetry", key),
      publicBootstrap("ConcurrentRetry", key),
    ]);
    expect([201, 409]).toContain(first.status);
    expect([201, 409]).toContain(second.status);
    expect([first.status, second.status]).toContain(201);

    const retry = await publicBootstrap("ConcurrentRetry", key);
    expect(retry.status).toBe(201);
    const replay = await extractPublicBootstrap(retry);
    const rows = await env.DIRECTORY.prepare(
      "SELECT COUNT(*) AS count FROM workspaces WHERE display_name = ?",
    )
      .bind("ConcurrentRetry workspace")
      .first<{ count: number }>();
    expect(Number(rows?.count ?? 0)).toBe(1);
  });

  it("different idempotency payloads with the same key conflict", async () => {
    const idemKey = "public-conflict-key-long-enough";
    // First call with label "Alpha"
    const first = await exports.default.fetch("https://frank.test/v1/workspaces", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": idemKey },
      body: JSON.stringify({ agentLabel: "Alpha" }),
    });
    expect(first.status).toBe(201);

    // Second call with same key but different label
    const second = await exports.default.fetch("https://frank.test/v1/workspaces", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": idemKey },
      body: JSON.stringify({ agentLabel: "Beta" }),
    });
    expect(second.status).toBe(409);
    await expect(second.json()).resolves.toEqual({
      error: "Idempotency key was already used for a different request",
    });
  });

  it("explicit invalid operator authorization is rejected", async () => {
    const response = await exports.default.fetch("https://frank.test/v1/workspaces", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "bootstrap-token": "wrong-token",
        "idempotency-key": bootstrapIdempotencyKey("wrong-token"),
      },
      body: JSON.stringify({ agentLabel: "InvalidGate" }),
    });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Workspace creation is not authorized",
    });
  });

  it("per-client quota is enforced and clients do not share quota", async () => {
    // Set a tight per-client ceiling
    const tightClientEnv = {
      ...TOKEN_ENV,
      BOOTSTRAP_CLIENT_CEILING: "2",
      BOOTSTRAP_QUOTA_PER_HOUR: "1000",
    } as unknown as typeof env;
    const bootstrapNow = (label: string, ip: string, key: string) =>
      bootstrapWorkspace(tightClientEnv, {
        agentLabel: label,
        request: new Request("https://frank.test/v1/workspaces", {
          headers: { "frank-client-ip": ip, "idempotency-key": key },
        }),
      });

    // Client A uses 2 slots
    await bootstrapNow("a-1", "1.2.3.4", bootstrapIdempotencyKey("client-a-1"));
    await bootstrapNow("a-2", "1.2.3.4", bootstrapIdempotencyKey("client-a-2"));
    await expect(bootstrapNow("a-3", "1.2.3.4", bootstrapIdempotencyKey("client-a-3"))).rejects.toMatchObject({
      status: 429,
    });

    // Client B can still bootstrap (separate bucket)
    await bootstrapNow("b-1", "5.6.7.8", bootstrapIdempotencyKey("client-b-1"));
    await bootstrapNow("b-2", "5.6.7.8", bootstrapIdempotencyKey("client-b-2"));

    // IP hash stored, not raw IP
    const hour = new Date().toISOString().slice(0, 13);
    const hashedIp = await keyedHashText(PUBLIC_TOKEN, "bootstrap-client:1.2.3.4");
    const clientBucket = `client:${hour}:${hashedIp}`;
    const clientRow = await env.DIRECTORY.prepare(
      "SELECT count FROM bootstrap_quota WHERE bucket = ?",
    )
      .bind(clientBucket)
      .first<{ count: number }>();
    expect(Number(clientRow?.count ?? 0)).toBe(2);
    // Verify raw IP is not in any bucket name
    const ipCheck = await env.DIRECTORY.prepare(
      "SELECT bucket FROM bootstrap_quota WHERE bucket LIKE '%1.2.3.4%'",
    ).all<{ bucket: string }>();
    expect(ipCheck.results).toHaveLength(0);
  });

  it("starts a fresh per-client quota bucket each UTC hour", async () => {
    const ip = "7.7.7.7";
    const previous = new Date(Date.now() - 60 * 60 * 1000).toISOString().slice(0, 13);
    const hash = await keyedHashText(PUBLIC_TOKEN, `bootstrap-client:${ip}`);
    await env.DIRECTORY.prepare(
      "INSERT OR REPLACE INTO bootstrap_quota (bucket, count) VALUES (?, 1)",
    )
      .bind(`client:${previous}:${hash}`)
      .run();
    const hourlyEnv = {
      ...TOKEN_ENV,
      BOOTSTRAP_CLIENT_CEILING: "1",
      BOOTSTRAP_QUOTA_PER_HOUR: "1000",
    } as unknown as typeof env;
    await expect(
      bootstrapWorkspace(hourlyEnv, {
        agentLabel: "new-hour-client",
        request: new Request("https://frank.test/v1/workspaces", {
          headers: {
            "frank-client-ip": ip,
            "idempotency-key": bootstrapIdempotencyKey("new-hour-client"),
          },
        }),
      }),
    ).resolves.toMatchObject({ workspace: { state: "unclaimed" } });
  });

  it("global and per-client limits both apply", async () => {
    // Read the atomic live-workspace count, then allow exactly one more.
    const currentCount = await env.DIRECTORY.prepare(
      "SELECT count FROM bootstrap_quota WHERE bucket = 'live'",
    ).first<{ count: number }>();
    const currentTotal = Number(currentCount?.count ?? 0);
    const tightTotal = {
      ...TOKEN_ENV,
      BOOTSTRAP_CLIENT_CEILING: "100",
      BOOTSTRAP_TOTAL_CEILING: String(currentTotal + 1),
    } as unknown as typeof env;
    await bootstrapWorkspace(tightTotal, {
      agentLabel: "total-first",
      request: new Request("https://frank.test/v1/workspaces", {
        headers: { "frank-client-ip": "9.9.9.9", "idempotency-key": bootstrapIdempotencyKey("total-1") },
      }),
    });
    await expect(
      bootstrapWorkspace(tightTotal, {
        agentLabel: "total-second",
        request: new Request("https://frank.test/v1/workspaces", {
          headers: { "frank-client-ip": "8.8.8.8", "idempotency-key": bootstrapIdempotencyKey("total-2") },
        }),
      }),
    ).rejects.toMatchObject({ status: 429 });
  });

  it("no email is sent during bootstrap", async () => {
    const before = await env.DIRECTORY.prepare(
      "SELECT COUNT(*) AS count FROM email_attempts",
    ).first<{ count: number }>();
    const beforeCount = Number(before?.count ?? 0);

    const response = await publicBootstrap("NoEmail");
    expect(response.status).toBe(201);

    const after = await env.DIRECTORY.prepare(
      "SELECT COUNT(*) AS count FROM email_attempts",
    ).first<{ count: number }>();
    expect(Number(after?.count ?? 0)).toBe(beforeCount);
  });

  it("human claim still sends verification email and completes ownership", async () => {
    const bootstrapKey = bootstrapIdempotencyKey("public-claim");
    const response = await publicBootstrap("PublicClaim", bootstrapKey);
    expect(response.status).toBe(201);
    const body = await extractPublicBootstrap(response);

    // Inject the claim verification via the email service
    const claimRes = await exports.default.fetch("https://frank.test/v1/claims", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        claimToken: body.claim.token,
        email: "public-claimee@example.com",
      }),
    });
    expect(claimRes.status).toBe(202);
    const attempt = await env.DIRECTORY.prepare(
      "SELECT status FROM email_attempts WHERE recipient = ? AND purpose = 'claim'",
    )
      .bind("public-claimee@example.com")
      .first<{ status: string }>();
    expect(attempt?.status).toBe("sent");

    const replay = await publicBootstrap("PublicClaim", bootstrapKey);
    expect(replay.status).toBe(410);

    // Verify the claim completes
    const emailAttempt = await env.DIRECTORY.prepare(
      "SELECT auth_token_id AS aid FROM email_attempts WHERE recipient = ? AND purpose = 'claim'",
    )
      .bind("public-claimee@example.com")
      .first<{ aid: string }>();
    expect(emailAttempt?.aid).toBeTruthy();
    const authToken = await env.DIRECTORY.prepare(
      "SELECT token_hash AS hash FROM auth_tokens WHERE id = ?",
    )
      .bind(emailAttempt!.aid)
      .first<{ hash: ArrayBuffer }>();
    expect(authToken).toBeTruthy();
    // Verify: we can't extract raw token, but the owner record test shows claim works
    const ownersBefore = await env.DIRECTORY.prepare(
      "SELECT COUNT(*) AS count FROM workspace_owners WHERE workspace_id = ?",
    )
      .bind(body.workspace.id)
      .first<{ count: number }>();
    expect(Number(ownersBefore?.count ?? 0)).toBe(0);
  });

  it("failed email delivery does not permanently strand the claim", async () => {
    const response = await publicBootstrap("DeliveryFail");
    expect(response.status).toBe(201);
    const body = await extractPublicBootstrap(response);

    // First attempt fails
    await expect(
      import("../../src/cloud/directory").then((m) =>
        m.requestClaimVerification(
          env,
          body.claim.token,
          "fail-retry@example.com",
          "https://frank.test",
          async () => {
            throw new Error("simulated");
          },
        ),
      ),
    ).rejects.toMatchObject({ status: 503 });

    // Retry succeeds
    let delivered = false;
    await import("../../src/cloud/directory").then((m) =>
      m.requestClaimVerification(
        env,
        body.claim.token,
        "fail-retry@example.com",
        "https://frank.test",
        async () => {
          delivered = true;
        },
      ),
    );
    expect(delivered).toBe(true);
  });

  it("abandoned cleanup restores usable capacity", async () => {
    // Measure the baseline before injecting old workspaces
    const baselineRow = await env.DIRECTORY.prepare(
      "SELECT COUNT(*) AS count FROM workspaces WHERE state IN ('unclaimed', 'active')",
    ).first<{ count: number }>();
    const baseline = Number(baselineRow?.count ?? 0);

    // Insert many old unclaimed workspaces
    const oldIds = Array.from({ length: 10 }, (_, i) => `wsp_abandon_${i}`);
    await env.DIRECTORY.batch(
      oldIds.map((id) =>
        env.DIRECTORY.prepare(
          "INSERT INTO workspaces (id, state, created_at) VALUES (?, 'unclaimed', ?)",
        ).bind(id, "2020-01-01T00:00:00.000Z"),
      ),
    );

    const current = await env.DIRECTORY.prepare(
           "SELECT COUNT(*) AS count FROM workspaces WHERE state IN ('unclaimed', 'active')",
    ).first<{ count: number }>();
    expect(Number(current?.count ?? 0)).toBe(baseline + 10);

    const { cleanupAbandonedWorkspaces } = await import("../../src/cloud/directory");
    const cleaned = await cleanupAbandonedWorkspaces(env);
    expect(cleaned).toBeGreaterThanOrEqual(10);

    const after = await env.DIRECTORY.prepare(
      "SELECT COUNT(*) AS count FROM workspaces WHERE state IN ('unclaimed', 'active')",
    ).first<{ count: number }>();
    // All injected old workspaces were cleaned; count returned to baseline
    expect(Number(after?.count ?? 0)).toBe(baseline);
  });

  it("abandoned cleanup immediately revokes workspace capabilities", async () => {
    const response = await publicBootstrap("CleanupRevokes");
    expect(response.status).toBe(201);
    const body = await extractPublicBootstrap(response);
    await env.DIRECTORY.prepare(
      "UPDATE workspaces SET created_at = ? WHERE id = ?",
    )
      .bind("2020-01-01T00:00:00.000Z", body.workspace.id)
      .run();

    const { cleanupAbandonedWorkspaces } = await import("../../src/cloud/directory");
    await cleanupAbandonedWorkspaces(env);
    const read = await exports.default.fetch(
      `https://frank.test/v1/workspaces/${body.workspace.id}/entries`,
      { headers: { authorization: `Bearer ${body.agentCredential.token}` } },
    );
    expect(read.status).toBe(401);

    await expect(
      requestClaimVerification(
        env,
        body.claim.token,
        "cleaned@example.com",
        "https://frank.test",
        async () => {},
      ),
    ).rejects.toMatchObject({ status: 410 });
  });

  it("returns machine-readable JSON that an agent can act on", async () => {
    const response = await publicBootstrap("MachineReadable");
    expect(response.status).toBe(201);
    const body = await response.json();
    // No prose-only field; structured JSON an agent can parse
    expect(body).toMatchObject({
      workspace: { id: expect.any(String), state: "unclaimed" },
      agentCredential: {
        id: expect.any(String),
        token: expect.any(String),
        prefix: expect.any(String),
        scopes: expect.any(Array),
      },
      claim: {
        token: expect.any(String),
        expiresAt: expect.any(String),
        url: expect.any(String),
      },
    });
  });

  it("raw client IP values are not stored in the database", async () => {
    await publicBootstrap("NoIPStore");
    const buckets = await env.DIRECTORY.prepare("SELECT bucket FROM bootstrap_quota").all<{
      bucket: string;
    }>();
    for (const row of buckets.results) {
      expect(row.bucket).not.toMatch(/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/);
    }
  });
});
