import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  requestClaimVerification,
  requestLoginLink,
} from "../../src/cloud/directory";
import type { TransactionalEmail } from "../../src/cloud/email";

interface BootstrapBody {
  workspace: { id: string; state: string };
  agentCredential: { id: string; token: string };
  claim: { token: string; url: string };
}

const BOOTSTRAP_TOKEN = "test-bootstrap-token-for-tests-only";

async function bootstrap(label: string): Promise<BootstrapBody> {
  const response = await exports.default.fetch("https://frank.test/v1/workspaces", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "bootstrap-token": BOOTSTRAP_TOKEN,
      "idempotency-key": `bootstrap-${label}-${crypto.randomUUID()}`,
    },
    body: JSON.stringify({
      displayName: `${label} workspace`,
      pageTitle: `${label} work log`,
      timeZone: "America/Chicago",
      agentLabel: `${label} agent`,
    }),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as BootstrapBody;
}

async function claimEmailFor(
  workspace: BootstrapBody,
  email: string,
): Promise<TransactionalEmail> {
  let delivered: TransactionalEmail | undefined;
  await requestClaimVerification(
    env,
    workspace.claim.token,
    email,
    "https://frank.test",
    async (message) => {
      delivered = message;
    },
  );
  if (!delivered) throw new Error("Claim email was not delivered");
  return delivered;
}

function linkFrom(message: TransactionalEmail, route: "verify" | "login"): string {
  const match = message.text.match(new RegExp(`https://frank\\.test/${route}#token=[^\\s]+`));
  if (!match) throw new Error(`${route} link was not present in email`);
  return match[0];
}

async function consumeLink(url: string): Promise<{ response: Response; cookie: string }> {
  const parsed = new URL(url);
  const token = new URLSearchParams(parsed.hash.slice(1)).get("token");
  const isClaim = parsed.pathname === "/verify";
  const response = await exports.default.fetch(
    isClaim ? "https://frank.test/v1/claim-sessions" : "https://frank.test/v1/login-sessions",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(isClaim ? { verificationToken: token } : { loginToken: token }),
    },
  );
  expect(response.status).toBe(200);
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  expect(cookie).toMatch(/^frank_session=/);
  return { response, cookie: cookie! };
}

describe("Frank Cloud first vertical slice", () => {
  it("releases a claim reservation when email delivery fails", async () => {
    const workspace = await bootstrap("Delivery retry");
    await expect(
      requestClaimVerification(
        env,
        workspace.claim.token,
        "retry@example.com",
        "https://frank.test",
        async () => {
          throw new Error("simulated delivery failure");
        },
      ),
    ).rejects.toMatchObject({ status: 503 });

    const retryEmail = await claimEmailFor(workspace, "retry@example.com");
    await consumeLink(linkFrom(retryEmail, "verify"));
    const attempts = await env.DIRECTORY.prepare(`
      SELECT COUNT(*) AS count FROM email_attempts WHERE recipient = ?
    `)
      .bind("retry@example.com")
      .first<{ count: number }>();
    expect(attempts?.count).toBe(1);
  });

  it("routes claim email through the local Email Service binding without creating a session", async () => {
    const workspace = await bootstrap("Email binding");
    const response = await exports.default.fetch("https://frank.test/v1/claims", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        claimToken: workspace.claim.token,
        email: "binding-check@example.com",
      }),
    });
    expect(response.status).toBe(202);
    expect(response.headers.get("set-cookie")).toBeNull();
    await expect(response.json()).resolves.toEqual({ checkEmail: true });

    const attempt = await env.DIRECTORY.prepare(`
      SELECT status FROM email_attempts WHERE recipient = ? AND purpose = 'claim'
    `)
      .bind("binding-check@example.com")
      .first<{ status: string }>();
    expect(attempt?.status).toBe("sent");

    const unknownLogin = await exports.default.fetch(
      "https://frank.test/v1/login-links",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "missing-user@example.com" }),
      },
    );
    expect(unknownLogin.status).toBe(202);
    await expect(unknownLogin.json()).resolves.toEqual({ checkEmail: true });
  });

  it("allows only one concurrent use of a claim capability", async () => {
    const workspace = await bootstrap("Concurrent claim");
    const delivered: TransactionalEmail[] = [];
    const claim = (email: string) =>
      requestClaimVerification(
        env,
        workspace.claim.token,
        email,
        "https://frank.test",
        async (message) => {
          delivered.push(message);
        },
      );

    const results = await Promise.allSettled([
      claim("concurrent-a@example.com"),
      claim("concurrent-b@example.com"),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(delivered).toHaveLength(1);

    await consumeLink(linkFrom(delivered[0]!, "verify"));

    const owners = await env.DIRECTORY.prepare(`
      SELECT COUNT(*) AS count
      FROM workspace_owners
      WHERE workspace_id = ?
    `)
      .bind(workspace.workspace.id)
      .first<{ count: number }>();
    const verifiedUsers = await env.DIRECTORY.prepare(`
      SELECT COUNT(*) AS count
      FROM users
      WHERE email_normalized IN ('concurrent-a@example.com', 'concurrent-b@example.com')
        AND email_verified_at IS NOT NULL
    `).first<{ count: number }>();
    expect(owners?.count).toBe(1);
    expect(verifiedUsers?.count).toBe(1);
  });

  it("supports one-time claim, scoped replay-safe todo writes, human completion, export, and revocation", async () => {
    const first = await bootstrap("First");
    expect(first.agentCredential.token).toMatch(/^frank_agent_/);
    expect(first.claim.token).toMatch(/^frank_claim_/);
    expect(first.claim.url).toContain(encodeURIComponent(first.claim.token));

    const claimPage = await exports.default.fetch(first.claim.url);
    expect(claimPage.status).toBe(200);
    const claimHtml = await claimPage.text();
    expect(claimHtml).toContain("Claim workspace");
    expect(claimHtml).toContain("/assets/cloud-claim.js");
    expect(claimHtml).not.toContain(first.agentCredential.token);

    const storedCredential = await env.DIRECTORY.prepare(`
      SELECT token_hash AS tokenHash, token_prefix AS tokenPrefix
      FROM agent_credentials WHERE id = ?
    `)
      .bind(first.agentCredential.id)
      .first<{ tokenHash: number[]; tokenPrefix: string }>();
    expect(storedCredential?.tokenHash).toHaveLength(32);
    expect(storedCredential?.tokenPrefix).not.toBe(first.agentCredential.token);

    const verificationEmail = await claimEmailFor(first, "owner@example.com");
    expect(verificationEmail.subject).toBe("Verify your Frank workspace");
    expect(verificationEmail.html).toContain("Verify and open Frank");
    const verification = await consumeLink(linkFrom(verificationEmail, "verify"));
    await expect(verification.response.clone().json()).resolves.toEqual({ workspaceId: first.workspace.id });
    const cookie = verification.cookie;
    const verificationUrl = new URL(linkFrom(verificationEmail, "verify"));
    const reusedVerification = await exports.default.fetch(
      "https://frank.test/v1/claim-sessions",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          verificationToken: new URLSearchParams(verificationUrl.hash.slice(1)).get("token"),
        }),
      },
    );
    expect(reusedVerification.status).toBe(410);

    const verifiedUser = await env.DIRECTORY.prepare(`
      SELECT email_verified_at AS verifiedAt FROM users WHERE email_normalized = ?
    `)
      .bind("owner@example.com")
      .first<{ verifiedAt: string | null }>();
    expect(verifiedUser?.verifiedAt).toBeTruthy();

    const reusedClaim = await exports.default.fetch("https://frank.test/v1/claims", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        claimToken: first.claim.token,
        email: "other@example.com",
      }),
    });
    expect(reusedClaim.status).toBe(410);

    const todoBody = {
      type: "todo",
      text: "Document the agent setup flow",
      title: "Write setup guide",
      project: "Frank Cloud",
      tags: ["docs", "launch"],
      source: "agent:test-suite",
    };
    const createHeaders = {
      authorization: `Bearer ${first.agentCredential.token}`,
      "content-type": "application/json",
      "idempotency-key": "session-42-todo-1",
    };
    const created = await exports.default.fetch(
      `https://frank.test/v1/workspaces/${first.workspace.id}/entries`,
      { method: "POST", headers: createHeaders, body: JSON.stringify(todoBody) },
    );
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as {
      entry: { id: number; projectRaw: string; actorId: string };
      replayed: boolean;
    };
    expect(createdBody.replayed).toBe(false);
    expect(createdBody.entry.projectRaw).toBe("Frank Cloud");
    expect(createdBody.entry.actorId).toBe(first.agentCredential.id);

    const replayed = await exports.default.fetch(
      `https://frank.test/v1/workspaces/${first.workspace.id}/entries`,
      { method: "POST", headers: createHeaders, body: JSON.stringify(todoBody) },
    );
    expect(replayed.status).toBe(200);
    await expect(replayed.json()).resolves.toMatchObject({
      replayed: true,
      entry: { id: createdBody.entry.id },
    });

    const conflict = await exports.default.fetch(
      `https://frank.test/v1/workspaces/${first.workspace.id}/entries`,
      {
        method: "POST",
        headers: createHeaders,
        body: JSON.stringify({ ...todoBody, text: "A different todo" }),
      },
    );
    expect(conflict.status).toBe(409);

    const second = await bootstrap("Second");
    const crossWorkspace = await exports.default.fetch(
      `https://frank.test/v1/workspaces/${second.workspace.id}/entries`,
      {
        method: "POST",
        headers: { ...createHeaders, "idempotency-key": "cross-workspace" },
        body: JSON.stringify(todoBody),
      },
    );
    expect(crossWorkspace.status).toBe(401);

    const secondVerificationEmail = await claimEmailFor(second, "owner@example.com");
    const secondVerification = await consumeLink(linkFrom(secondVerificationEmail, "verify"));
    const verifiedEmailLinksOwnedWorkspaces = await exports.default.fetch(
      `https://frank.test/w/${first.workspace.id}`,
      { headers: { cookie: secondVerification.cookie } },
    );
    expect(verifiedEmailLinksOwnedWorkspaces.status).toBe(200);

    let loginMessage: TransactionalEmail | undefined;
    await requestLoginLink(
      env,
      "owner@example.com",
      "https://frank.test",
      async (message) => {
        loginMessage = message;
      },
    );
    expect(loginMessage).toBeTruthy();
    const login = await consumeLink(linkFrom(loginMessage!, "login"));
    const loginPageAccess = await exports.default.fetch(
      `https://frank.test/w/${first.workspace.id}`,
      { headers: { cookie: login.cookie } },
    );
    expect(loginPageAccess.status).toBe(200);
    const loginUrl = new URL(linkFrom(loginMessage!, "login"));
    const reusedLogin = await exports.default.fetch("https://frank.test/v1/login-sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        loginToken: new URLSearchParams(loginUrl.hash.slice(1)).get("token"),
      }),
    });
    expect(reusedLogin.status).toBe(410);

    const page = await exports.default.fetch(
      `https://frank.test/w/${first.workspace.id}`,
      { headers: { cookie: cookie! } },
    );
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain("default-src 'self'");
    const pageHtml = await page.text();
    expect(pageHtml).toContain("Write setup guide");
    expect(pageHtml).toContain("/assets/frank.css");
    expect(pageHtml).toContain("data-open-count>1 open");
    expect(pageHtml).not.toContain("<form");
    expect(pageHtml).not.toContain("textarea");

    const crossSiteClose = await exports.default.fetch(
      `https://frank.test/v1/workspaces/${first.workspace.id}/entries/${createdBody.entry.id}/close`,
      {
        method: "PATCH",
        headers: { cookie: cookie!, origin: "https://attacker.example" },
      },
    );
    expect(crossSiteClose.status).toBe(403);

    const closed = await exports.default.fetch(
      `https://frank.test/v1/workspaces/${first.workspace.id}/entries/${createdBody.entry.id}/close`,
      {
        method: "PATCH",
        headers: { cookie: cookie!, origin: "https://frank.test" },
      },
    );
    expect(closed.status).toBe(200);
    await expect(closed.json()).resolves.toMatchObject({
      entry: { id: createdBody.entry.id, status: "closed" },
    });

    const exported = await exports.default.fetch(
      `https://frank.test/v1/workspaces/${first.workspace.id}/export`,
      { headers: { cookie: cookie! } },
    );
    expect(exported.status).toBe(200);
    const exportBody = (await exported.json()) as {
      entries: Array<{ type: string; status: string; text: string }>;
    };
    expect(exportBody.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "todo", status: "closed" }),
        expect.objectContaining({
          type: "done",
          status: "closed",
          text: "Document the agent setup flow",
        }),
      ]),
    );

    const revoke = await exports.default.fetch(
      `https://frank.test/v1/workspaces/${first.workspace.id}/agent-credentials/${first.agentCredential.id}/revoke`,
      {
        method: "POST",
        headers: { cookie: cookie!, origin: "https://frank.test" },
      },
    );
    expect(revoke.status).toBe(200);

    const afterRevocation = await exports.default.fetch(
      `https://frank.test/v1/workspaces/${first.workspace.id}/entries`,
      {
        method: "POST",
        headers: { ...createHeaders, "idempotency-key": "after-revoke" },
        body: JSON.stringify(todoBody),
      },
    );
    expect(afterRevocation.status).toBe(401);
  });
});
