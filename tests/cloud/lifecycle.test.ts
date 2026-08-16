import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { requestClaimVerification } from "../../src/cloud/directory";
import type { TransactionalEmail } from "../../src/cloud/email";

const ACTOR = { type: "agent" as const, id: "credential-lifecycle" };

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

async function seedProject(workspaceName: string, name: string, text: string) {
  const ws = env.WORKSPACES.getByName(workspaceName);
  await ws.createEntry({
    type: "note",
    text,
    project: name,
    tags: [],
    source: "test:seed",
    ...mutation(),
  });
  return ws;
}

describe("Frank Cloud project lifecycle", () => {
  it("renames a project, keeps the old name as an alias, and preserves projectRaw", async () => {
    const ws = await seedProject("lifecycle-rename", "Old Name", "seed note");

    const result = await ws.renameProject(
      mutation({ nameOrAlias: "Old Name", newName: "New Name" }),
    );
    expect(result.kind).toBe("created");
    expect(result.value).toMatchObject({ name: "New Name", status: "active" });
    const projects = await ws.listProjects();
    expect(projects).toHaveLength(1);
    expect(projects[0]!.name).toBe("New Name");
    expect(projects[0]!.aliases).toContain("Old Name");

    // Entries display the new canonical name but keep raw project text.
    const entries = await ws.listEntries({ project: "New Name", limit: 10 });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ project: "New Name", projectRaw: "Old Name" });

    // Old name still resolves via alias.
    const byOld = await ws.listEntries({ project: "Old Name", limit: 10 });
    expect(byOld).toHaveLength(1);
  });

  it("rejects a rename to an existing project name with a 409", async () => {
    const ws = await seedProject("lifecycle-rename-conflict", "Alpha", "a");
    await ws.createEntry({
      type: "note",
      text: "b",
      project: "Beta",
      tags: [],
      source: "test:seed",
      ...mutation(),
    });

    const first = await ws.renameProject(mutation({ nameOrAlias: "Alpha", newName: "Beta" }));
    expect(first.kind).toBe("error");
    expect(first.status).toBe(409);
    // The error must be returned as a structured result, not thrown over RPC.
    const second = await ws.renameProject(mutation({ nameOrAlias: "Alpha", newName: "Beta" }));
    expect(second.kind).toBe("error");
    expect(second.status).toBe(409);
  });

  it("merges a source project into a target, archiving the source", async () => {
    const ws = await seedProject("lifecycle-merge", "Source", "source note");
    await ws.createEntry({
      type: "note",
      text: "target note",
      project: "Target",
      tags: [],
      source: "test:seed",
      ...mutation(),
    });

    const result = await ws.mergeProjects(
      mutation({ fromNameOrAlias: "Source", toNameOrAlias: "Target" }),
    );
    expect(result.kind).toBe("created");
    expect(result.value).toMatchObject({ name: "Target" });

    // Source is archived; target keeps all entries.
    const all = await ws.listProjects(true);
    const source = all.find((p) => p.name === "Source");
    const target = all.find((p) => p.name === "Target");
    expect(source?.status).toBe("archived");
    expect(target?.status).toBe("active");
    expect(target?.aliases).toContain("Source");

    const targetEntries = await ws.listEntries({ project: "Target", limit: 20 });
    expect(targetEntries).toHaveLength(2);
    // Default list hides the archived source.
    const active = await ws.listProjects();
    expect(active.map((p) => p.name)).toEqual(["Target"]);
  });

  it("transfers the source project's aliases to the target on merge", async () => {
    const ws = await seedProject("lifecycle-merge-aliases", "Source", "source note");
    await ws.createEntry({
      type: "note",
      text: "target note",
      project: "Target",
      tags: [],
      source: "test:seed",
      ...mutation(),
    });
    // Give the source project two aliases.
    await ws.createProject(
      mutation({ name: "Example Portal", aliases: ["portal", "example_dashboard"] }),
    );
    await ws.mergeProjects(
      mutation({ fromNameOrAlias: "Example Portal", toNameOrAlias: "Target" }),
    );

    const all = await ws.listProjects(true);
    const target = all.find((p) => p.name === "Target");
    expect(target).toBeTruthy();
    // Source aliases must survive the merge on the target.
    expect(target!.aliases).toEqual(
      expect.arrayContaining(["portal", "example_dashboard", "Example Portal"]),
    );
    // A future agent entry using a transferred alias resolves to the target.
    const byAlias = await ws.listEntries({ project: "example_dashboard", limit: 20 });
    expect(byAlias).toHaveLength(1);
    expect(byAlias[0]!.project).toBe("Target");
  });

  it("keeps only the newest open active entry when merging two active projects", async () => {
    const ws = await seedProject("lifecycle-merge-active", "Source", "source seed");
    await ws.createEntry({
      type: "note",
      text: "target seed",
      project: "Target",
      tags: [],
      source: "test:seed",
      ...mutation(),
    });
    // Open an active entry on each project, source one newer than target.
    await ws.createEntry({
      type: "active",
      text: "target active",
      project: "Target",
      tags: [],
      source: "test:seed",
      ...mutation(),
    });
    await ws.createEntry({
      type: "active",
      text: "source active",
      project: "Source",
      tags: [],
      source: "test:seed",
      ...mutation(),
    });

    await ws.mergeProjects(
      mutation({ fromNameOrAlias: "Source", toNameOrAlias: "Target" }),
    );

    const active = await ws.listEntries({ type: "active", project: "Target", limit: 20 });
    const open = active.filter((entry) => entry.status === "open");
    expect(open).toHaveLength(1);
    // The newest (source) active entry is the survivor.
    expect(open[0]!.text).toBe("source active");
    expect(active.filter((entry) => entry.status === "closed")).toHaveLength(1);
  });

  it("returns a deliberate 409 when an alias already belongs to another project", async () => {
    const ws = await seedProject("lifecycle-alias-conflict", "Portal", "portal note");
    await ws.createEntry({
      type: "note",
      text: "target note",
      project: "Frank Portal",
      tags: [],
      source: "test:seed",
      ...mutation(),
    });

    // Trying to give "Frank Portal" an alias already owned by "Portal" must be a
    // structured 409 conflict, not a 500.
    const result = await ws.createProject(
      mutation({ name: "Frank Portal", aliases: ["portal"] }),
    );
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.status).toBe(409);
      expect(result.message).toContain("portal");
    }
  });

  it("archives a project and hides it from default lists while keeping history", async () => {
    const ws = await seedProject("lifecycle-archive", "Doomed", "doomed note");

    const result = await ws.archiveProject(mutation({ nameOrAlias: "Doomed" }));
    expect(result.value).toMatchObject({ status: "archived" });

    expect((await ws.listProjects()).map((p) => p.name)).toEqual([]);
    expect((await ws.listProjects(true)).map((p) => p.name)).toEqual(["Doomed"]);

    // History/export intact.
    const history = await ws.getProjectHistory("Doomed");
    expect(history.entries).toHaveLength(1);
  });

  it("reactivates an archived project when a new entry is written to it", async () => {
    const ws = await seedProject("lifecycle-reactivate", "Sleepy", "old note");
    await ws.archiveProject(mutation({ nameOrAlias: "Sleepy" }));
    expect((await ws.listProjects()).map((p) => p.name)).toEqual([]);

    await ws.createEntry({
      type: "note",
      text: "woke up",
      project: "Sleepy",
      tags: [],
      source: "test:seed",
      ...mutation(),
    });

    expect((await ws.listProjects()).map((p) => p.name)).toEqual(["Sleepy"]);
  });

  it("closes open active entries for a project without archiving or touching other types", async () => {
    const ws = await seedProject("lifecycle-inactive", "ActiveProj", "seed");
    await ws.createEntry({
      type: "active",
      text: "working now",
      project: "ActiveProj",
      tags: [],
      source: "test:seed",
      ...mutation(),
    });
    await ws.createEntry({
      type: "todo",
      text: "open todo",
      project: "ActiveProj",
      tags: [],
      source: "test:seed",
      ...mutation(),
    });

    const result = await ws.inactiveProject(mutation({ nameOrAlias: "ActiveProj" }));
    expect(result.value).toMatchObject({ status: "active" });

    const active = await ws.listEntries({ type: "active", project: "ActiveProj", limit: 10 });
    expect(active).toHaveLength(1);
    expect(active[0]!.status).toBe("closed");

    // Todo stays open; project not archived.
    const todos = await ws.listEntries({ type: "todo", project: "ActiveProj", limit: 10 });
    expect(todos[0]!.status).toBe("open");
    expect((await ws.listProjects()).map((p) => p.name)).toEqual(["ActiveProj"]);
  });

  it("returns 404 for lifecycle operations on a missing project", async () => {
    const ws = env.WORKSPACES.getByName("lifecycle-missing");
    const result = await ws.archiveProject(mutation({ nameOrAlias: "Nope" }));
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.status).toBe(404);
      expect(result.message).toBe("Project not found: Nope");
    }
  });

  it("records provenance events for lifecycle operations", async () => {
    const ws = await seedProject("lifecycle-events", "EventProj", "seed");
    await ws.renameProject(mutation({ nameOrAlias: "EventProj", newName: "Renamed" }));
    await ws.archiveProject(mutation({ nameOrAlias: "Renamed" }));

    const events = await runInDurableObject(ws, (_instance, state) =>
      state.storage.sql
        .exec<{ action: string; actor_id: string }>(
          "SELECT action, actor_id FROM project_events ORDER BY id",
        )
        .toArray(),
    );
    expect(events).toEqual([
      { action: "rename", actor_id: "credential-lifecycle" },
      { action: "archive", actor_id: "credential-lifecycle" },
    ]);
  });

  it("replays an idempotent lifecycle mutation without duplicating effects", async () => {
    const ws = await seedProject("lifecycle-idempotent", "IdemProj", "seed");
    const key = "lifecycle-rename-key";
    const fixedHash = "fixed-rename-hash";
    const first = await ws.renameProject(
      mutation({
        nameOrAlias: "IdemProj",
        newName: "Renamed",
        idempotencyKey: key,
        requestHash: fixedHash,
      }),
    );
    expect(first.kind).toBe("created");

    const replay = await ws.renameProject(
      mutation({
        nameOrAlias: "IdemProj",
        newName: "Renamed",
        idempotencyKey: key,
        requestHash: fixedHash,
      }),
    );
    expect(replay.kind).toBe("replayed");
    expect(replay.value).toMatchObject({ name: "Renamed" });

    // Only one rename event recorded.
    const events = await runInDurableObject(ws, (_instance, state) =>
      state.storage.sql
        .exec<{ action: string }>(
          "SELECT action FROM project_events WHERE action = 'rename'",
        )
        .toArray(),
    );
    expect(events).toHaveLength(1);
  });
});

describe("Frank Cloud private dashboard", () => {
  const BOOTSTRAP_TOKEN = "test-bootstrap-token-for-tests-only";
  async function bootstrap(label: string) {
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

  it("renders the full review-only dashboard for a claimed workspace", async () => {
    const workspace = await bootstrap("Dashboard");
    const ws = env.WORKSPACES.getByName(workspace.workspace.id);
    await ws.createEntry({
      type: "status",
      text: "Shipping the dashboard",
      project: "Portal",
      tags: [],
      source: "test:agent",
      ...mutation(),
    });
    await ws.createEntry({
      type: "todo",
      text: "Review the drawer",
      project: "Portal",
      tags: [],
      source: "test:agent",
      ...mutation(),
    });
    const cookie = await claim(workspace);

    const page = await exports.default.fetch(`https://frank.test/w/${workspace.workspace.id}`, {
      headers: { cookie },
    });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("Current status");
    expect(html).toContain("Open loops");
    expect(html).toContain("Active projects");
    expect(html).toContain("Recent log");
    expect(html).toContain("Shipping the dashboard");
    expect(html).toContain("Review the drawer");
    expect(html).toContain("project-drawer");
    // Drawer is an accessible modal dialog, hidden by default.
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('aria-label="Project history"');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain("inert");
    // Owner dashboard exposes the full portable export button (share view does not).
    expect(html).toContain('id="export-button"');
  });

  it("serves human-authenticated project history for the drawer", async () => {
    const workspace = await bootstrap("History");
    const ws = env.WORKSPACES.getByName(workspace.workspace.id);
    await ws.createEntry({
      type: "note",
      text: "history note",
      project: "Portal",
      tags: [],
      source: "test:agent",
      ...mutation(),
    });
    const cookie = await claim(workspace);

    const response = await exports.default.fetch(
      `https://frank.test/w/${workspace.workspace.id}/projects/Portal/entries`,
      { headers: { cookie } },
    );
    expect(response.status).toBe(200);
    const data = (await response.json()) as { project: string; entries: unknown[] };
    expect(data.project).toBe("Portal");
    expect(data.entries).toHaveLength(1);
  });

  it("rejects dashboard access without a human session", async () => {
    const workspace = await bootstrap("NoAuth");
    const response = await exports.default.fetch(`https://frank.test/w/${workspace.workspace.id}`);
    expect(response.status).toBe(401);
  });

  it("does not list archived projects under Active projects", async () => {
    const workspace = await bootstrap("ArchivedActive");
    const ws = env.WORKSPACES.getByName(workspace.workspace.id);
    await ws.createEntry({
      type: "status",
      text: "Worked on a retired project",
      project: "Retired",
      tags: [],
      source: "test:agent",
      ...mutation(),
    });
    await ws.createEntry({
      type: "status",
      text: "Now on the live project",
      project: "Live",
      tags: [],
      source: "test:agent",
      ...mutation(),
    });
    // Archive the previously-recent project.
    const archive = await ws.archiveProject(mutation({ nameOrAlias: "Retired" }));
    expect(archive.kind).toBe("created");
    const cookie = await claim(workspace);

    const page = await exports.default.fetch(`https://frank.test/w/${workspace.workspace.id}`, {
      headers: { cookie },
    });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("Active projects");
    expect(html).toContain("Live");
    // The archived project's recent entries still appear in the "Recent log",
    // so the authoritative exclusion lives in the activeProjects projection.
    const status = await exports.default.fetch(
      `https://frank.test/v1/workspaces/${workspace.workspace.id}/status`,
      {
        headers: { authorization: `Bearer ${workspace.agentCredential.token}` },
      },
    );
    const statusJson = (await status.json()) as {
      activeProjects: Array<{ name: string }>;
    };
    expect(statusJson.activeProjects.map((p) => p.name)).toEqual(["Live"]);
  });

  it("shows every open loop to the owner, not just the status cap", async () => {
    const workspace = await bootstrap("AllLoops");
    const ws = env.WORKSPACES.getByName(workspace.workspace.id);
    for (let i = 0; i < 10; i += 1) {
      await ws.createEntry({
        type: "todo",
        text: `open loop ${i}`,
        tags: [],
        source: "test:agent",
        ...mutation(),
      });
    }
    const cookie = await claim(workspace);

    const page = await exports.default.fetch(`https://frank.test/w/${workspace.workspace.id}`, {
      headers: { cookie },
    });
    expect(page.status).toBe(200);
    const html = await page.text();
    for (let i = 0; i < 10; i += 1) {
      expect(html).toContain(`open loop ${i}`);
    }
    expect(html).toContain("10 open");

    // The agent-facing status route still caps open loops at 8.
    const status = await exports.default.fetch(
      `https://frank.test/v1/workspaces/${workspace.workspace.id}/status`,
      {
        headers: { authorization: `Bearer ${workspace.agentCredential.token}` },
      },
    );
    const statusJson = (await status.json()) as { openLoops: unknown[] };
    expect(statusJson.openLoops).toHaveLength(8);
  });
});
