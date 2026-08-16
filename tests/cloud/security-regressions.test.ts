import { env, exports } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../../src/cloud/index";
import { describe, expect, it } from "vitest";
import {
  cleanupAbandonedWorkspaces,
  enforcePublicRequestLimit,
  requestClaimVerification,
  requestLoginLink,
  requireAgent,
  requireHuman,
  verifyClaim,
} from "../../src/cloud/directory";
import type { TransactionalEmail } from "../../src/cloud/email";
import { redirectResponse } from "../../src/cloud/http";

const OPERATOR_TOKEN = "test-bootstrap-token-for-tests-only";

type Bootstrap = {
  workspace: { id: string };
  agentCredential: { id: string; token: string };
  claim: { id: string; token: string; url: string };
};

async function bootstrap(label: string, operator = true): Promise<Bootstrap> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "idempotency-key": `security-${label}-${crypto.randomUUID()}`,
  };
  if (operator) headers["bootstrap-token"] = OPERATOR_TOKEN;
  const response = await exports.default.fetch("https://frank.test/v1/workspaces", {
    method: "POST",
    headers,
    body: JSON.stringify({ agentLabel: label }),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as Bootstrap;
}

async function verificationToken(workspace: Bootstrap, email: string): Promise<string> {
  let delivered: TransactionalEmail | undefined;
  await requestClaimVerification(env, workspace.claim.token, email, "https://frank.test", async (message) => {
    delivered = message;
  });
  const encoded = delivered?.text.match(/\/verify#token=([^\s]+)/)?.[1];
  if (!encoded) throw new Error("verification token missing");
  return decodeURIComponent(encoded);
}

async function redeemClaim(workspace: Bootstrap, email: string): Promise<string> {
  const token = await verificationToken(workspace, email);
  const response = await exports.default.fetch("https://frank.test/v1/claim-sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ verificationToken: token }),
  });
  expect(response.status).toBe(200);
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  if (!cookie) throw new Error("session cookie missing");
  return cookie;
}

describe("Frank Cloud security regressions", () => {
  it("redeems only hashed opaque capabilities and rejects database row IDs", async () => {
    const workspace = await bootstrap("hashed-redemption");
    await expect(
      requestClaimVerification(
        env,
        workspace.claim.id,
        "id-rejected@example.com",
        "https://frank.test",
        async () => {},
      ),
    ).rejects.toMatchObject({ status: 410 });

    const token = await verificationToken(workspace, "hashed-redemption@example.com");
    const auth = await env.DIRECTORY.prepare(
      "SELECT id FROM auth_tokens WHERE workspace_id = ? AND purpose = 'claim'",
    ).bind(workspace.workspace.id).first<{ id: string }>();
    const rejected = await exports.default.fetch("https://frank.test/v1/claim-sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ verificationToken: auth!.id }),
    });
    expect(rejected.status).toBe(410);

    const accepted = await exports.default.fetch("https://frank.test/v1/claim-sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ verificationToken: token }),
    });
    expect(accepted.status).toBe(200);
  });

  it("keeps URL capabilities in fragments and serves fragment-clearing scripts", async () => {
    const workspace = await bootstrap("fragment-flow");
    expect(workspace.claim.url).toContain("/claim#token=");
    expect(workspace.claim.url).not.toContain("?token=");
    const claimScript = await exports.default.fetch("https://frank.test/assets/cloud-claim.js");
    const verifyScript = await exports.default.fetch("https://frank.test/assets/cloud-verify.js");
    expect(await claimScript.text()).toContain("history.replaceState");
    expect(await verifyScript.text()).toContain("history.replaceState");
  });

  it("does not leave bootstrap reservations when quota rejects a new key", async () => {
    const before = await env.DIRECTORY.prepare(
      "SELECT COUNT(*) AS count FROM bootstrap_idempotency",
    ).first<{ count: number }>();
    const limited = {
      ...env,
      BOOTSTRAP_QUOTA_PER_HOUR: "1",
      BOOTSTRAP_TOTAL_CEILING: "1000000",
    } as unknown as Env;
    const { bootstrapWorkspace } = await import("../../src/cloud/directory");
    await expect(
      bootstrapWorkspace(limited, {
        agentLabel: "rejected-row",
        request: new Request("https://frank.test/v1/workspaces", {
          headers: {
            "idempotency-key": `rejected-${crypto.randomUUID()}`,
          },
        }),
      }),
    ).rejects.toMatchObject({ status: 429 });
    const after = await env.DIRECTORY.prepare(
      "SELECT COUNT(*) AS count FROM bootstrap_idempotency",
    ).first<{ count: number }>();
    expect(after?.count).toBe(before?.count);
  });

  it("rejects unseen zero-capacity buckets and disables bootstrap", async () => {
    const request = new Request("https://frank.test/v1/login-links", {
      headers: { "cf-connecting-ip": `198.51.100.${Math.floor(Math.random() * 200) + 1}` },
    });
    const zeroLogin = { ...env, LOGIN_GLOBAL_CEILING: "0" } as unknown as Env;
    expect(await enforcePublicRequestLimit(zeroLogin, request, "login")).toBe(false);

    const { bootstrapWorkspace } = await import("../../src/cloud/directory");
    const zeroBootstrap = {
      ...env,
      BOOTSTRAP_QUOTA_PER_HOUR: "0",
      BOOTSTRAP_PUBLIC_QUOTA_PER_HOUR: "0",
    } as unknown as Env;
    await expect(
      bootstrapWorkspace(zeroBootstrap, {
        agentLabel: "disabled",
        request: new Request("https://frank.test/v1/workspaces", {
          headers: {
            "bootstrap-token": OPERATOR_TOKEN,
            "idempotency-key": `disabled-${crypto.randomUUID()}`,
          },
        }),
      }),
    ).rejects.toMatchObject({ status: 429 });
  });

  it("does not create client buckets when fixed bootstrap circuits reject distributed traffic", async () => {
    const hour = new Date().toISOString().slice(0, 13);
    const before = await env.DIRECTORY.prepare(
      "SELECT COUNT(*) AS count FROM bootstrap_quota WHERE bucket LIKE ?",
    ).bind(`client:${hour}:%`).first<{ count: number }>();
    const { bootstrapWorkspace } = await import("../../src/cloud/directory");
    const disabled = {
      ...env,
      BOOTSTRAP_PUBLIC_QUOTA_PER_HOUR: "0",
      BOOTSTRAP_QUOTA_PER_HOUR: "1000000",
      BOOTSTRAP_TOTAL_CEILING: "1000000",
      BOOTSTRAP_PUBLIC_TOTAL_CEILING: "1000000",
      BOOTSTRAP_CLIENT_CEILING: "1000000",
    } as unknown as Env;
    for (let index = 0; index < 20; index += 1) {
      await expect(
        bootstrapWorkspace(disabled, {
          agentLabel: `distributed-${index}`,
          request: new Request("https://frank.test/v1/workspaces", {
            headers: {
              "cf-connecting-ip": `203.0.113.${index + 1}`,
              "idempotency-key": `distributed-${crypto.randomUUID()}`,
            },
          }),
        }),
      ).rejects.toMatchObject({ status: 429 });
    }
    const after = await env.DIRECTORY.prepare(
      "SELECT COUNT(*) AS count FROM bootstrap_quota WHERE bucket LIKE ?",
    ).bind(`client:${hour}:%`).first<{ count: number }>();
    expect(after?.count).toBe(before?.count);
  });

  it("reconciles pending bootstrap reservations into live capacity", async () => {
    const id = `pending-${crypto.randomUUID()}`;
    const workspaceId = `wsp_pending_${crypto.randomUUID()}`;
    const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
    await env.DIRECTORY.prepare(`
      INSERT INTO bootstrap_idempotency (
        key_hash, request_hash, status, owner_nonce, workspace_id,
        credential_id, claim_id, claim_expires_at, quota_reserved,
        bootstrap_mode, reserved_until, expires_at
      ) VALUES (?, 'request', 'pending', 'owner', ?, 'credential', 'claim', ?, 1, 'public', ?, ?)
    `).bind(id, workspaceId, expiresAt, expiresAt, expiresAt).run();

    await cleanupAbandonedWorkspaces(env);
    const liveRows = await env.DIRECTORY.prepare(
      "SELECT COUNT(*) AS count FROM workspaces WHERE state IN ('unclaimed', 'active')",
    ).first<{ count: number }>();
    const publicRows = await env.DIRECTORY.prepare(
      "SELECT COUNT(*) AS count FROM workspaces WHERE state IN ('unclaimed', 'active') AND bootstrap_mode = 'public'",
    ).first<{ count: number }>();
    const live = await env.DIRECTORY.prepare(
      "SELECT count FROM bootstrap_quota WHERE bucket = 'live'",
    ).first<{ count: number }>();
    const publicLive = await env.DIRECTORY.prepare(
      "SELECT count FROM bootstrap_quota WHERE bucket = 'live:public'",
    ).first<{ count: number }>();
    expect(live?.count).toBe(Number(liveRows?.count ?? 0) + 1);
    expect(publicLive?.count).toBe(Number(publicRows?.count ?? 0) + 1);
    await env.DIRECTORY.prepare(
      "UPDATE bootstrap_idempotency SET expires_at = '2000-01-01T00:00:00.000Z' WHERE key_hash = ?",
    ).bind(id).run();
    await cleanupAbandonedWorkspaces(env);
  });

  it("never lowers live counters during upward reconciliation", async () => {
    const originalLive = await env.DIRECTORY.prepare(
      "SELECT count FROM bootstrap_quota WHERE bucket = 'live'",
    ).first<{ count: number }>();
    const originalPublic = await env.DIRECTORY.prepare(
      "SELECT count FROM bootstrap_quota WHERE bucket = 'live:public'",
    ).first<{ count: number }>();
    const guardedLive = Number(originalLive?.count ?? 0) + 17;
    const guardedPublic = Number(originalPublic?.count ?? 0) + 11;
    try {
      await env.DIRECTORY.batch([
        env.DIRECTORY.prepare(
          "INSERT OR REPLACE INTO bootstrap_quota (bucket, count) VALUES ('live', ?)",
        ).bind(guardedLive),
        env.DIRECTORY.prepare(
          "INSERT OR REPLACE INTO bootstrap_quota (bucket, count) VALUES ('live:public', ?)",
        ).bind(guardedPublic),
      ]);

      await cleanupAbandonedWorkspaces(env);
      const live = await env.DIRECTORY.prepare(
        "SELECT count FROM bootstrap_quota WHERE bucket = 'live'",
      ).first<{ count: number }>();
      const publicLive = await env.DIRECTORY.prepare(
        "SELECT count FROM bootstrap_quota WHERE bucket = 'live:public'",
      ).first<{ count: number }>();
      expect(live?.count).toBe(guardedLive);
      expect(publicLive?.count).toBe(guardedPublic);
    } finally {
      await env.DIRECTORY.batch([
        env.DIRECTORY.prepare(
          "INSERT OR REPLACE INTO bootstrap_quota (bucket, count) VALUES ('live', ?)",
        ).bind(Number(originalLive?.count ?? 0)),
        env.DIRECTORY.prepare(
          "INSERT OR REPLACE INTO bootstrap_quota (bucket, count) VALUES ('live:public', ?)",
        ).bind(Number(originalPublic?.count ?? 0)),
      ]);
    }
  });

  it("decrements fixed live counters when abandoned public workspaces are deleted", async () => {
    const workspace = await bootstrap(`delete-count-${crypto.randomUUID()}`, false);
    const beforeLive = await env.DIRECTORY.prepare(
      "SELECT count FROM bootstrap_quota WHERE bucket = 'live'",
    ).first<{ count: number }>();
    const beforePublic = await env.DIRECTORY.prepare(
      "SELECT count FROM bootstrap_quota WHERE bucket = 'live:public'",
    ).first<{ count: number }>();
    await env.DIRECTORY.prepare(
      "UPDATE workspaces SET created_at = '2000-01-01T00:00:00.000Z' WHERE id = ?",
    ).bind(workspace.workspace.id).run();

    expect(await cleanupAbandonedWorkspaces(env)).toBeGreaterThanOrEqual(1);
    const live = await env.DIRECTORY.prepare(
      "SELECT count FROM bootstrap_quota WHERE bucket = 'live'",
    ).first<{ count: number }>();
    const publicLive = await env.DIRECTORY.prepare(
      "SELECT count FROM bootstrap_quota WHERE bucket = 'live:public'",
    ).first<{ count: number }>();
    expect(live?.count).toBe(Number(beforeLive?.count ?? 0) - 1);
    expect(publicLive?.count).toBe(Number(beforePublic?.count ?? 0) - 1);
  });

  it("decrements fixed live counters when expired pending reservations are purged", async () => {
    const keyHash = `expired-pending-${crypto.randomUUID()}`;
    const workspaceId = `wsp_expired_pending_${crypto.randomUUID()}`;
    const future = new Date(Date.now() + 60_000).toISOString();
    await env.DIRECTORY.batch([
      env.DIRECTORY.prepare(`
        INSERT INTO bootstrap_idempotency (
          key_hash, request_hash, status, owner_nonce, workspace_id,
          credential_id, claim_id, claim_expires_at, quota_reserved,
          bootstrap_mode, reserved_until, expires_at
        ) VALUES (?, 'request', 'pending', 'owner', ?, 'credential', 'claim', ?, 1, 'public', ?, '2000-01-01T00:00:00.000Z')
      `).bind(keyHash, workspaceId, future, future),
      env.DIRECTORY.prepare(
        "UPDATE bootstrap_quota SET count = count + 1 WHERE bucket = 'live'",
      ),
      env.DIRECTORY.prepare(
        "UPDATE bootstrap_quota SET count = count + 1 WHERE bucket = 'live:public'",
      ),
    ]);
    const beforeLive = await env.DIRECTORY.prepare(
      "SELECT count FROM bootstrap_quota WHERE bucket = 'live'",
    ).first<{ count: number }>();
    const beforePublic = await env.DIRECTORY.prepare(
      "SELECT count FROM bootstrap_quota WHERE bucket = 'live:public'",
    ).first<{ count: number }>();

    await cleanupAbandonedWorkspaces(env);
    const live = await env.DIRECTORY.prepare(
      "SELECT count FROM bootstrap_quota WHERE bucket = 'live'",
    ).first<{ count: number }>();
    const publicLive = await env.DIRECTORY.prepare(
      "SELECT count FROM bootstrap_quota WHERE bucket = 'live:public'",
    ).first<{ count: number }>();
    expect(live?.count).toBe(Number(beforeLive?.count ?? 0) - 1);
    expect(publicLive?.count).toBe(Number(beforePublic?.count ?? 0) - 1);
    expect(
      await env.DIRECTORY.prepare(
        "SELECT key_hash FROM bootstrap_idempotency WHERE key_hash = ?",
      ).bind(keyHash).first(),
    ).toBeNull();
  });

  it("limits login traffic before account lookup", async () => {
    const hour = new Date().toISOString().slice(0, 13);
    const bucket = `login:request:${hour}:global`;
    const current = await env.DIRECTORY.prepare(
      "SELECT count FROM bootstrap_quota WHERE bucket = ?",
    ).bind(bucket).first<{ count: number }>();
    const limited = {
      ...env,
      LOGIN_GLOBAL_CEILING: String(Number(current?.count ?? 0) + 1),
      LOGIN_CLIENT_CEILING: "1000000",
    } as unknown as Env;
    const request = new Request("https://frank.test/v1/login-links", {
      headers: { "cf-connecting-ip": `192.0.2.${Math.floor(Math.random() * 200) + 1}` },
    });
    expect(await enforcePublicRequestLimit(limited, request, "login")).toBe(true);
    expect(await enforcePublicRequestLimit(limited, request, "login")).toBe(false);
  });

  it("enforces per-credential request limits", async () => {
    const workspace = await bootstrap("credential-limit");
    const limited = {
      ...env,
      AGENT_CREDENTIAL_MINUTE_CEILING: "1",
      WORKSPACE_MINUTE_CEILING: "1000000",
    } as unknown as Env;
    const request = new Request(
      `https://frank.test/v1/workspaces/${workspace.workspace.id}/entries`,
      { headers: { authorization: `Bearer ${workspace.agentCredential.token}` } },
    );
    await expect(requireAgent(limited, request, workspace.workspace.id, "read")).resolves.toBeTruthy();
    await expect(requireAgent(limited, request, workspace.workspace.id, "read")).rejects.toMatchObject({ status: 429 });
  });

  it("shares the aggregate workspace minute ceiling across agent and human traffic", async () => {
    const workspace = await bootstrap("shared-workspace-limit");
    const cookie = await redeemClaim(
      workspace,
      `shared-${crypto.randomUUID()}@example.com`,
    );
    const limited = {
      ...env,
      AGENT_CREDENTIAL_MINUTE_CEILING: "1000000",
      HUMAN_SESSION_MINUTE_CEILING: "1000000",
      WORKSPACE_MINUTE_CEILING: "1",
    } as unknown as Env;
    await requireAgent(
      limited,
      new Request(`https://frank.test/v1/workspaces/${workspace.workspace.id}/entries`, {
        headers: { authorization: `Bearer ${workspace.agentCredential.token}` },
      }),
      workspace.workspace.id,
      "read",
    );
    await expect(
      requireHuman(
        limited,
        new Request(`https://frank.test/w/${workspace.workspace.id}`, {
          headers: { cookie },
        }),
        workspace.workspace.id,
      ),
    ).rejects.toMatchObject({ status: 429 });
  });

  it("bounds workspace entry and project cardinality", async () => {
    const ws = env.WORKSPACES.getByName(`bounded-${crypto.randomUUID()}`);
    for (let index = 0; index < 20; index += 1) {
      const result = await ws.createEntry({
        type: "note",
        text: `entry ${index}`,
        project: `project ${index}`,
        tags: [],
        source: "security-test",
        actor: { type: "agent", id: "bounded-agent" },
        idempotencyKey: `bounded-${index}`,
        requestHash: `hash-${index}`,
        expiresAt: "2099-01-01T00:00:00.000Z",
      });
      expect(result.kind).toBe("created");
    }
    const firstPage = await ws.listProjects(false, 5, 0);
    const secondPage = await ws.listProjects(false, 5, 5);
    expect(firstPage).toHaveLength(5);
    expect(secondPage).toHaveLength(5);
    expect(new Set([...firstPage, ...secondPage].map((project) => project.id)).size).toBe(10);

    const overflow = await ws.createEntry({
      type: "note",
      text: "overflow",
      tags: [],
      source: "security-test",
      actor: { type: "agent", id: "bounded-agent" },
      idempotencyKey: "bounded-overflow",
      requestHash: "hash-overflow",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    expect(overflow).toMatchObject({ kind: "error", status: 429 });
    const projectOverflow = await ws.createProject({
      name: "project overflow",
      aliases: [],
      actor: { type: "agent", id: "bounded-agent" },
      idempotencyKey: "project-overflow",
      requestHash: "project-hash-overflow",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    expect(projectOverflow).toMatchObject({ kind: "error", status: 429 });
  });

  it("isolates human workspaces and revokes the current session on logout", async () => {
    const first = await bootstrap("human-first");
    const second = await bootstrap("human-second");
    const firstCookie = await redeemClaim(first, `first-${crypto.randomUUID()}@example.com`);
    await redeemClaim(second, `second-${crypto.randomUUID()}@example.com`);

    const cross = await exports.default.fetch(`https://frank.test/w/${second.workspace.id}`, {
      headers: { cookie: firstCookie },
    });
    expect(cross.status).toBe(401);

    const malformed = await exports.default.fetch(
      `https://frank.test/v1/workspaces/${first.workspace.id}/entries/1/close`,
      { method: "PATCH", headers: { cookie: firstCookie, origin: "not a valid origin" } },
    );
    expect(malformed.status).toBe(403);

    const logout = await exports.default.fetch("https://frank.test/v1/logout", {
      method: "POST",
      headers: { cookie: firstCookie, origin: "https://frank.test" },
    });
    expect(logout.status).toBe(200);
    expect(logout.headers.get("set-cookie")).toContain("Max-Age=0");
    const after = await exports.default.fetch(`https://frank.test/w/${first.workspace.id}`, {
      headers: { cookie: firstCookie },
    });
    expect(after.status).toBe(401);
  });

  it("shares recipient email budgets across claim requests", async () => {
    const first = await bootstrap("email-budget-first");
    const second = await bootstrap("email-budget-second");
    const recipient = `budget-${crypto.randomUUID()}@example.com`;
    const limited = {
      ...env,
      EMAIL_RECIPIENT_CEILING: "1",
      EMAIL_GLOBAL_CEILING: "1000000",
    } as unknown as Env;
    await expect(
      requestClaimVerification(limited, first.claim.token, recipient, "https://frank.test", async () => {}),
    ).resolves.toBeUndefined();
    await expect(
      requestClaimVerification(limited, second.claim.token, recipient, "https://frank.test", async () => {}),
    ).rejects.toMatchObject({ status: 429 });
  });

  it("caps workspaces per verified user", async () => {
    const first = await bootstrap("user-cap-first");
    const second = await bootstrap("user-cap-second");
    const recipient = `cap-${crypto.randomUUID()}@example.com`;
    const firstToken = await verificationToken(first, recipient);
    const secondToken = await verificationToken(second, recipient);
    const limited = { ...env, USER_WORKSPACE_CEILING: "1" } as unknown as Env;
    await expect(verifyClaim(limited, firstToken)).resolves.toBeTruthy();
    await expect(verifyClaim(limited, secondToken)).rejects.toMatchObject({ status: 410 });
  });

  it("keeps one outstanding login token under concurrent link requests", async () => {
    const workspace = await bootstrap("atomic-login");
    const email = `atomic-${crypto.randomUUID()}@example.com`;
    await redeemClaim(workspace, email);
    await Promise.all([
      requestLoginLink(env, email, "https://frank.test", async () => {}),
      requestLoginLink(env, email, "https://frank.test", async () => {}),
    ]);
    const outstanding = await env.DIRECTORY.prepare(
      "SELECT COUNT(*) AS count FROM auth_tokens WHERE purpose = 'login' AND email_normalized = ? AND used_at IS NULL",
    ).bind(email).first<{ count: number }>();
    expect(outstanding?.count).toBe(1);
  });

  it("schedules the complete login-link workflow in waitUntil", async () => {
    const workspace = await bootstrap("background-login");
    const email = `background-${crypto.randomUUID()}@example.com`;
    await redeemClaim(workspace, email);
    const before = await env.DIRECTORY.prepare(
      "SELECT COUNT(*) AS count FROM auth_tokens WHERE purpose = 'login' AND email_normalized = ? AND used_at IS NULL",
    ).bind(email).first<{ count: number }>();
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request("https://frank.test/v1/login-links", {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": "192.0.2.222" },
        body: JSON.stringify({ email }),
      }),
      env,
      ctx,
    );
    expect(response.status).toBe(202);
    await waitOnExecutionContext(ctx);
    const after = await env.DIRECTORY.prepare(
      "SELECT COUNT(*) AS count FROM auth_tokens WHERE purpose = 'login' AND email_normalized = ? AND used_at IS NULL",
    ).bind(email).first<{ count: number }>();
    expect(after?.count).toBe(Number(before?.count ?? 0) + 1);
  });

  it("reserves live and hourly capacity for operator bootstrap", async () => {
    const publicLive = await env.DIRECTORY.prepare(
      "SELECT COUNT(*) AS count FROM workspaces WHERE state IN ('unclaimed', 'active') AND bootstrap_mode = 'public'",
    ).first<{ count: number }>();
    const allLive = await env.DIRECTORY.prepare(
      "SELECT COUNT(*) AS count FROM workspaces WHERE state IN ('unclaimed', 'active')",
    ).first<{ count: number }>();
    const hour = new Date().toISOString().slice(0, 13);
    const hourly = await env.DIRECTORY.prepare(
      "SELECT count FROM bootstrap_quota WHERE bucket = ?",
    ).bind(`hour:${hour}`).first<{ count: number }>();
    const limited = {
      ...env,
      BOOTSTRAP_PUBLIC_TOTAL_CEILING: String(Number(publicLive?.count ?? 0)),
      BOOTSTRAP_TOTAL_CEILING: String(Number(allLive?.count ?? 0) + 2),
      BOOTSTRAP_QUOTA_PER_HOUR: String(Number(hourly?.count ?? 0) + 2),
      BOOTSTRAP_PUBLIC_QUOTA_PER_HOUR: "0",
      BOOTSTRAP_CLIENT_CEILING: "1000000",
    } as unknown as Env;
    const { bootstrapWorkspace } = await import("../../src/cloud/directory");
    const publicRequest = new Request("https://frank.test/v1/workspaces", {
      headers: { "idempotency-key": `public-reserve-${crypto.randomUUID()}` },
    });
    await expect(
      bootstrapWorkspace(limited, { agentLabel: "public-reserve", request: publicRequest }),
    ).rejects.toMatchObject({ status: 429 });
    const operatorRequest = new Request("https://frank.test/v1/workspaces", {
      headers: {
        "bootstrap-token": OPERATOR_TOKEN,
        "idempotency-key": `operator-reserve-${crypto.randomUUID()}`,
      },
    });
    await expect(
      bootstrapWorkspace(limited, { agentLabel: "operator-reserve", request: operatorRequest }),
    ).resolves.toBeTruthy();
  });

  it("caps aliases, project events, and whole summary/export responses", async () => {
    const ws = env.WORKSPACES.getByName(`whole-response-${crypto.randomUUID()}`);
    const largeStructured = { payload: "x".repeat(60_000) };
    for (let index = 0; index < 20; index += 1) {
      const created = await ws.createEntry({
        type: index % 2 === 0 ? "todo" : "note",
        text: `large ${index} ${"t".repeat(9_980)}`,
        structuredJson: largeStructured,
        project: "bounded-project",
        tags: [],
        source: "security-test",
        actor: { type: "agent", id: "response-agent" },
        idempotencyKey: `large-${index}`,
        requestHash: `large-hash-${index}`,
        expiresAt: "2099-01-01T00:00:00.000Z",
      });
      expect(created.kind).toBe("created");
    }
    const page = await ws.listEntriesPage({ limit: 100 });
    expect(new TextEncoder().encode(JSON.stringify(page)).byteLength).toBeLessThanOrEqual(524_288);
    expect(page.truncated).toBe(true);
    const openPage = await ws.listOpenLoopsPage(100);
    expect(new TextEncoder().encode(JSON.stringify(openPage)).byteLength).toBeLessThanOrEqual(524_288);
    expect(openPage.truncated).toBe(true);
    const status = await ws.getStatusProjection({ allOpenLoops: true });
    expect(new TextEncoder().encode(JSON.stringify(status)).byteLength).toBeLessThanOrEqual(524_288);
    expect(status.truncated).toBe(true);
    const history = await ws.getProjectHistory("bounded-project", 100);
    expect(new TextEncoder().encode(JSON.stringify(history)).byteLength).toBeLessThanOrEqual(524_288);
    expect(history.truncated?.entries || history.truncated?.openLoops).toBe(true);

    const summary = await ws.buildDailySummary(new Date().toISOString().slice(0, 10), "UTC");
    expect(new TextEncoder().encode(JSON.stringify(summary)).byteLength).toBeLessThanOrEqual(1_048_576);
    expect(summary.truncated.responseEntries).toBe(true);
    expect(summary.entries.every((entry) => Object.keys(entry.structuredJson).length === 0)).toBe(true);
    expect(JSON.stringify(summary)).not.toContain("x".repeat(100));
    const exported = await ws.exportData();
    expect(new TextEncoder().encode(exported).byteLength).toBeLessThanOrEqual(1_048_576);
    expect((JSON.parse(exported) as { truncated: { entries: boolean } }).truncated.entries).toBe(true);

    const aliasWs = env.WORKSPACES.getByName(`alias-cap-${crypto.randomUUID()}`);
    const project = await aliasWs.createProject({
      name: "alias project",
      aliases: Array.from({ length: 20 }, (_, index) => `alias-${index}`),
      actor: { type: "agent", id: "alias-agent" },
      idempotencyKey: "alias-base",
      requestHash: "alias-base-hash",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    expect(project.kind).toBe("created");
    const overflow = await aliasWs.createProject({
      name: "second project",
      aliases: Array.from({ length: 10 }, (_, index) => `overflow-alias-${index}`),
      actor: { type: "agent", id: "alias-agent" },
      idempotencyKey: "alias-overflow",
      requestHash: "alias-overflow-hash",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    expect(overflow).toMatchObject({ kind: "error", status: 429 });

    for (let index = 0; index < 5; index += 1) {
      const inactive = await aliasWs.inactiveProject({
        nameOrAlias: "alias project",
        actor: { type: "agent", id: "alias-agent" },
        idempotencyKey: `event-${index}`,
        requestHash: `event-hash-${index}`,
        expiresAt: "2099-01-01T00:00:00.000Z",
      });
      expect(inactive.kind).toBe("created");
    }
    const eventOverflow = await aliasWs.inactiveProject({
      nameOrAlias: "alias project",
      actor: { type: "agent", id: "alias-agent" },
      idempotencyKey: "event-overflow",
      requestHash: "event-overflow-hash",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    expect(eventOverflow).toMatchObject({ kind: "error", status: 429 });
  });

  it("serves a full untruncated export to an agent with read scope", async () => {
    const ws = env.WORKSPACES.getByName(`full-export-${crypto.randomUUID()}`);
    const largeStructured = { payload: "x".repeat(60_000) };
    for (let index = 0; index < 20; index += 1) {
      const created = await ws.createEntry({
        type: index % 2 === 0 ? "note" : "todo",
        text: `full entry ${index}`,
        structuredJson: largeStructured,
        tags: [],
        source: "full-export-test",
        actor: { type: "agent", id: "full-export-agent" },
        idempotencyKey: `full-${index}`,
        requestHash: `full-hash-${index}`,
        expiresAt: "2099-01-01T00:00:00.000Z",
      });
      if (created.kind !== "created") {
        throw new Error(`entry ${index}: ${JSON.stringify(created)}`);
      }
    }
    // The capped export truncates at the 1MB response ceiling (20 × 60KB > 1MB);
    // the full export carries every entry with no truncation flags.
    const capped = await ws.exportData();
    const cappedParsed = JSON.parse(capped) as { truncated: Record<string, boolean> };
    expect(Object.values(cappedParsed.truncated).some(Boolean)).toBe(true);
    const full = await ws.exportDataFull();
    expect(full).not.toContain('"truncated"');
    const parsed = JSON.parse(full) as { entries: { id: number }[] };
    expect(parsed.entries).toHaveLength(20);
  });

  it("closes loops at entry capacity without creating another row", async () => {
    const ws = env.WORKSPACES.getByName(`close-cap-${crypto.randomUUID()}`);
    let todoId = 0;
    for (let index = 0; index < 20; index += 1) {
      const created = await ws.createEntry({
        type: index === 0 ? "todo" : "note",
        text: `entry ${index}`,
        tags: [],
        source: "security-test",
        actor: { type: "agent", id: "close-agent" },
        idempotencyKey: `close-${index}`,
        requestHash: `close-hash-${index}`,
        expiresAt: "2099-01-01T00:00:00.000Z",
      });
      if (index === 0 && created.value) todoId = created.value.id;
    }
    expect(await ws.closeEntry(todoId, { type: "human", id: "owner" })).toMatchObject({ status: "closed" });
    expect(await ws.listEntries({ limit: 100 })).toHaveLength(20);
  });

  it("rejects agent and claim redemption once cleanup owns a workspace", async () => {
    const workspace = await bootstrap("cleanup-race");
    const token = await verificationToken(workspace, `cleanup-${crypto.randomUUID()}@example.com`);
    await env.DIRECTORY.prepare(
      "UPDATE workspaces SET state = 'deleting' WHERE id = ? AND state = 'unclaimed'",
    ).bind(workspace.workspace.id).run();
    await expect(verifyClaim(env, token)).rejects.toMatchObject({ status: 410 });
    await expect(
      requireAgent(
        env,
        new Request(`https://frank.test/v1/workspaces/${workspace.workspace.id}/entries`, {
          headers: { authorization: `Bearer ${workspace.agentCredential.token}` },
        }),
        workspace.workspace.id,
        "read",
      ),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("retries deleting workspaces and removes expired tombstones", async () => {
    const deletingId = `wsp_deleting_${crypto.randomUUID()}`;
    await env.DIRECTORY.prepare(
      "INSERT INTO workspaces (id, state, created_at) VALUES (?, 'deleting', ?)",
    ).bind(deletingId, "2020-01-01T00:00:00.000Z").run();
    await cleanupAbandonedWorkspaces(env);
    const finalized = await env.DIRECTORY.prepare(
      "SELECT state FROM workspaces WHERE id = ?",
    ).bind(deletingId).first<{ state: string }>();
    expect(finalized?.state).toBe("deleted");

    await env.DIRECTORY.prepare(
      "UPDATE workspaces SET deleted_at = '2020-01-01T00:00:00.000Z' WHERE id = ?",
    ).bind(deletingId).run();
    await cleanupAbandonedWorkspaces(env);
    expect(
      await env.DIRECTORY.prepare("SELECT id FROM workspaces WHERE id = ?").bind(deletingId).first(),
    ).toBeNull();
  });

  it("purges expired authentication, session, idempotency, and quota records", async () => {
    const oldQuota = `email:2000-01-01T00:global:${crypto.randomUUID()}`;
    await env.DIRECTORY.prepare(
      "INSERT INTO bootstrap_quota (bucket, count) VALUES (?, 1)",
    ).bind(oldQuota).run();
    await cleanupAbandonedWorkspaces(env);
    const quota = await env.DIRECTORY.prepare(
      "SELECT bucket FROM bootstrap_quota WHERE bucket = ?",
    ).bind(oldQuota).first();
    expect(quota).toBeNull();
    const expiredBootstrap = await env.DIRECTORY.prepare(
      "SELECT COUNT(*) AS count FROM bootstrap_idempotency WHERE expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
    ).first<{ count: number }>();
    const expiredAuth = await env.DIRECTORY.prepare(
      "SELECT COUNT(*) AS count FROM auth_tokens WHERE expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now') OR used_at IS NOT NULL",
    ).first<{ count: number }>();
    const expiredSessions = await env.DIRECTORY.prepare(
      "SELECT COUNT(*) AS count FROM browser_sessions WHERE expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now') OR revoked_at IS NOT NULL",
    ).first<{ count: number }>();
    expect(expiredBootstrap?.count).toBe(0);
    expect(expiredAuth?.count).toBe(0);
    expect(expiredSessions?.count).toBe(0);
  });

  it("gates the agent full export behind bearer auth and returns untruncated data", async () => {
    const workspace = await bootstrap("full-export-route");
    await exports.default.fetch(
      `https://frank.test/v1/workspaces/${workspace.workspace.id}/entries`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": `route-full-${crypto.randomUUID()}`,
          authorization: `Bearer ${workspace.agentCredential.token}`,
        },
        body: JSON.stringify({ type: "note", text: "route full export entry", source: "full-export-test" }),
      },
    );
    const unauthorized = await exports.default.fetch(
      `https://frank.test/v1/workspaces/${workspace.workspace.id}/export?full=1`,
    );
    expect(unauthorized.status).toBe(401);
    const authorized = await exports.default.fetch(
      `https://frank.test/v1/workspaces/${workspace.workspace.id}/export?full=1`,
      { headers: { authorization: `Bearer ${workspace.agentCredential.token}` } },
    );
    expect(authorized.status).toBe(200);
    const body = (await authorized.json()) as { entries: { text: string }[] };
    expect(body.entries.some((entry) => entry.text === "route full export entry")).toBe(true);
  });

  it("applies security headers to HTML, JSON, assets, and redirects", async () => {
    for (const path of ["/", "/health", "/assets/cloud-login.js"]) {
      const response = await exports.default.fetch(`https://frank.test${path}`);
      expect(response.headers.get("strict-transport-security")).toContain("max-age=");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("content-security-policy")).toContain("default-src 'self'");
    }
    const authScript = await exports.default.fetch("https://frank.test/assets/cloud-login.js");
    expect(authScript.headers.get("cache-control")).toBe("no-cache, must-revalidate");
    const redirect = redirectResponse("/login");
    expect(redirect.headers.get("strict-transport-security")).toContain("max-age=");
    expect(redirect.headers.get("referrer-policy")).toBe("no-referrer");
    expect(redirect.headers.get("cache-control")).toBe("no-store");
  });
});
