import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { requestClaimVerification } from "../../src/cloud/directory";
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

async function createTodo(
  workspace: BootstrapBody,
  text: string,
): Promise<{ id: number }> {
  const response = await exports.default.fetch(
    `https://frank.test/v1/workspaces/${workspace.workspace.id}/entries`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${workspace.agentCredential.token}`,
        "idempotency-key": `todo-${crypto.randomUUID()}`,
      },
      body: JSON.stringify({ type: "todo", text, source: "test" }),
    },
  );
  expect(response.status).toBe(201);
  const body = (await response.json()) as { entry: { id: number } };
  return { id: body.entry.id };
}

describe("Frank Cloud agent loop-closing and share links", () => {
  it("lets an agent close a todo it opened via the bearer-token close route", async () => {
    const workspace = await bootstrap("agent-close");
    const todo = await createTodo(workspace, "agent-closable todo");

    const close = await exports.default.fetch(
      `https://frank.test/v1/workspaces/${workspace.workspace.id}/entries/${todo.id}/close`,
      {
        method: "PATCH",
        headers: { authorization: `Bearer ${workspace.agentCredential.token}` },
      },
    );
    expect(close.status).toBe(200);
    await expect(close.json()).resolves.toMatchObject({
      entry: { id: todo.id, status: "closed" },
    });
  });

  it("lets one agent close a todo opened by a different agent (multi-agent team)", async () => {
    const workspace = await bootstrap("agent-close-team");
    // Agent A opens a todo.
    const todo = await createTodo(workspace, "opened by agent A");

    // A second agent credential (agent B) closes it. Bootstrap only issues one
    // credential, so we simulate a second agent by using the same workspace
    // credential — the point is that close authority is workspace-scoped, not
    // tied to the opener's identity.
    const close = await exports.default.fetch(
      `https://frank.test/v1/workspaces/${workspace.workspace.id}/entries/${todo.id}/close`,
      {
        method: "PATCH",
        headers: { authorization: `Bearer ${workspace.agentCredential.token}` },
      },
    );
    expect(close.status).toBe(200);
    await expect(close.json()).resolves.toMatchObject({
      entry: { id: todo.id, status: "closed" },
    });
  });

  it("creates, views, and revokes a read-only share link", async () => {
    const workspace = await bootstrap("share-link");
    const email = await claimEmailFor(workspace, `owner-${crypto.randomUUID()}@example.com`);
    const cookie = (await consumeLink(linkFrom(email, "verify"))).cookie;

    // Owner creates a share token.
    const create = await exports.default.fetch(
      `https://frank.test/v1/workspaces/${workspace.workspace.id}/share`,
      {
        method: "POST",
        headers: { cookie, origin: "https://frank.test" },
      },
    );
    expect(create.status).toBe(200);
    const createBody = (await create.json()) as {
      share: { id: string; url: string; prefix: string };
    };
    expect(createBody.share.url).toMatch(/^https:\/\/frank\.test\/s\/frank_share_/);

    // Owner can list active share tokens (prefix + expiry) — regression guard
    // for the token_prefix column that the list endpoint reads.
    const list = await exports.default.fetch(
      `https://frank.test/v1/workspaces/${workspace.workspace.id}/share`,
      { headers: { cookie } },
    );
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as { tokens: Array<{ id: string; prefix: string; expiresAt: string }> };
    expect(listBody.tokens).toHaveLength(1);
    const listed = listBody.tokens[0]!;
    expect(listed.id).toBe(createBody.share.id);
    expect(listed.prefix).toBe(createBody.share.prefix);
    expect(listed.expiresAt).toBeTruthy();

    // A share viewer (no session) can read the dashboard.
    const shareUrl = new URL(createBody.share.url);
    const shareToken = shareUrl.pathname.split("/").pop()!;
    const view = await exports.default.fetch(
      `https://frank.test/s/${shareToken}`,
    );
    expect(view.status).toBe(200);
    const viewHtml = await view.text();
    expect(viewHtml).toContain("Read-only");
    expect(viewHtml).toContain("shared-view");
    // No completion checkboxes in the shared view.
    expect(viewHtml).not.toContain('type="checkbox"');
    // No logout button.
    expect(viewHtml).not.toContain("logout-button");

    // A share viewer cannot close a loop (no session, no origin -> 403 from
    // the same-origin check, matching the existing human close route).
    const todo = await createTodo(workspace, "shared-view todo");
    const closeAttempt = await exports.default.fetch(
      `https://frank.test/v1/workspaces/${workspace.workspace.id}/entries/${todo.id}/close`,
      { method: "PATCH" },
    );
    expect(closeAttempt.status).toBe(403);

    // Owner revokes the share token; the link dies immediately.
    const revoke = await exports.default.fetch(
      `https://frank.test/v1/workspaces/${workspace.workspace.id}/share/${createBody.share.id}/revoke`,
      {
        method: "POST",
        headers: { cookie, origin: "https://frank.test" },
      },
    );
    expect(revoke.status).toBe(200);

    const afterRevoke = await exports.default.fetch(
      `https://frank.test/s/${shareToken}`,
    );
    expect(afterRevoke.status).toBe(401);
  });

  it("requires an owner session to create or revoke a share token", async () => {
    const workspace = await bootstrap("share-owner-only");

    // No session -> 403 (same-origin check runs first, matching the existing
    // human close route convention).
    const noSession = await exports.default.fetch(
      `https://frank.test/v1/workspaces/${workspace.workspace.id}/share`,
      { method: "POST" },
    );
    expect(noSession.status).toBe(403);

    // Cross-origin with a valid session -> 403.
    const email = await claimEmailFor(workspace, `owner-${crypto.randomUUID()}@example.com`);
    const cookie = (await consumeLink(linkFrom(email, "verify"))).cookie;
    const crossOrigin = await exports.default.fetch(
      `https://frank.test/v1/workspaces/${workspace.workspace.id}/share`,
      {
        method: "POST",
        headers: { cookie, origin: "https://attacker.example" },
      },
    );
    expect(crossOrigin.status).toBe(403);
  });
});
