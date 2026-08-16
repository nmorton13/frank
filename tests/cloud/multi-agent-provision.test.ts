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

async function ownerSession(workspace: BootstrapBody): Promise<string> {
  const email = await claimEmailFor(workspace, `owner-${crypto.randomUUID()}@example.com`);
  return (await consumeLink(linkFrom(email, "verify"))).cookie;
}

interface ProvisionBody {
  provision: {
    credential: { id: string; label: string };
    setup: { id: string; token: string; url: string; expiresAt: string };
  };
}

async function mintAgent(workspace: BootstrapBody, cookie: string, label: string): Promise<ProvisionBody> {
  const response = await exports.default.fetch(
    `https://frank.test/v1/workspaces/${workspace.workspace.id}/agent-credentials`,
    {
      method: "POST",
      headers: { cookie, origin: "https://frank.test", "content-type": "application/json" },
      body: JSON.stringify({ label }),
    },
  );
  expect(response.status).toBe(201);
  return (await response.json()) as ProvisionBody;
}

describe("Frank Cloud multi-agent provisioning", () => {
  it("lets an owner mint a credential and an agent redeem the setup link once", async () => {
    const workspace = await bootstrap("multi-agent-mint");
    const cookie = await ownerSession(workspace);

    const minted = await mintAgent(workspace, cookie, "claude");
    expect(minted.provision.credential.label).toBe("claude");
    expect(minted.provision.setup.url).toMatch(/^https:\/\/frank\.test\/a\/frank_setup_/);

    // An agent (no session) redeems the link once.
    const redeem = await exports.default.fetch(minted.provision.setup.url, {
      headers: { Accept: "application/json" },
    });
    expect(redeem.status).toBe(200);
    const body = (await redeem.json()) as {
      base: string;
      workspaceId: string;
      token: string;
      prefix: string;
      label: string;
      scopes: string[];
    };
    expect(body.base).toBe("https://frank.test");
    expect(body.workspaceId).toBe(workspace.workspace.id);
    expect(body.label).toBe("claude");
    expect(body.token).toMatch(/^frank_agent_/);
    expect(body.scopes).toEqual(["read", "write"]);

    // The redeemed token is a working write credential (not a placeholder).
    const write = await exports.default.fetch(
      `https://frank.test/v1/workspaces/${workspace.workspace.id}/entries`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${body.token}`,
          "content-type": "application/json",
          "idempotency-key": `redeemed-${crypto.randomUUID()}`,
        },
        body: JSON.stringify({ type: "note", text: "written by claude", source: "test" }),
      },
    );
    expect(write.status).toBe(201);

    // A second redeem of the same setup link fails (single-use).
    const second = await exports.default.fetch(minted.provision.setup.url, {
      headers: { Accept: "application/json" },
    });
    expect(second.status).toBe(410);
  });

  it("lists credentials (without tokens) and lets the owner revoke one", async () => {
    const workspace = await bootstrap("multi-agent-list");
    const cookie = await ownerSession(workspace);

    const a = await mintAgent(workspace, cookie, "alpha");
    const b = await mintAgent(workspace, cookie, "beta");

    const list = await exports.default.fetch(
      `https://frank.test/v1/workspaces/${workspace.workspace.id}/agent-credentials`,
      { headers: { cookie } },
    );
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as {
      credentials: Array<{ id: string; label: string; status: string; prefix: string; scopes: string[] }>;
    };
    expect(listBody.credentials).toHaveLength(3); // bootstrap cred + alpha + beta
    expect(listBody.credentials.map((c) => c.label).sort()).toEqual(["alpha", "beta", "multi-agent-list agent"]);
    // The list never returns a token.
    for (const c of listBody.credentials) {
      expect("token" in c).toBe(false);
      expect(c.scopes).toEqual(["read", "write"]);
    }

    // Revoke beta.
    const revoke = await exports.default.fetch(
      `https://frank.test/v1/workspaces/${workspace.workspace.id}/agent-credentials/${b.provision.credential.id}/revoke`,
      { method: "POST", headers: { cookie, origin: "https://frank.test" } },
    );
    expect(revoke.status).toBe(200);

    const after = await exports.default.fetch(
      `https://frank.test/v1/workspaces/${workspace.workspace.id}/agent-credentials`,
      { headers: { cookie } },
    );
    const afterBody = (await after.json()) as { credentials: Array<{ label: string; status: string }> };
    const beta = afterBody.credentials.find((c) => c.label === "beta");
    expect(beta?.status).toBe("revoked");
    const alpha = afterBody.credentials.find((c) => c.label === "alpha");
    expect(alpha?.status).toBe("active");

    // A revoked credential's setup link can no longer be redeemed.
    const revokedRedeem = await exports.default.fetch(b.provision.setup.url, {
      headers: { Accept: "application/json" },
    });
    expect(revokedRedeem.status).toBe(410);
  });

  it("requires an owner session to mint or list, and rejects duplicate labels", async () => {
    const workspace = await bootstrap("multi-agent-guard");

    // No session -> 403 (same-origin check runs first, matching share routes).
    const noSession = await exports.default.fetch(
      `https://frank.test/v1/workspaces/${workspace.workspace.id}/agent-credentials`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ label: "x" }) },
    );
    expect(noSession.status).toBe(403);

    const cookie = await ownerSession(workspace);
    await mintAgent(workspace, cookie, "dup");

    // Duplicate active label -> 409.
    const dup = await exports.default.fetch(
      `https://frank.test/v1/workspaces/${workspace.workspace.id}/agent-credentials`,
      {
        method: "POST",
        headers: { cookie, origin: "https://frank.test", "content-type": "application/json" },
        body: JSON.stringify({ label: "dup" }),
      },
    );
    expect(dup.status).toBe(409);

    // Invalid label -> 400.
    const bad = await exports.default.fetch(
      `https://frank.test/v1/workspaces/${workspace.workspace.id}/agent-credentials`,
      {
        method: "POST",
        headers: { cookie, origin: "https://frank.test", "content-type": "application/json" },
        body: JSON.stringify({ label: "Bad Label/with slash" }),
      },
    );
    expect(bad.status).toBe(400);
  });
});
