import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import fixture from "../fixtures/frank-compatibility.json";
import { requestClaimVerification } from "../../src/cloud/directory";
import type { TransactionalEmail } from "../../src/cloud/email";
import { hashText } from "../../src/cloud/tokens";

type Bootstrap = {
  workspace: { id: string };
  agentCredential: { id: string; token: string };
  claim: { token: string };
};

type Entry = {
  id: number;
  type: string;
  text: string;
  structuredJson: Record<string, unknown>;
  project: string | null;
  projectRaw: string | null;
  status: string;
  actorId: string;
  source: string;
  closedAt: string | null;
};

const BOOTSTRAP_TOKEN = "test-bootstrap-token-for-tests-only";

async function bootstrap(): Promise<Bootstrap> {
  const response = await exports.default.fetch("https://frank.test/v1/workspaces", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "bootstrap-token": BOOTSTRAP_TOKEN,
      "idempotency-key": `bootstrap-compatibility-${crypto.randomUUID()}`,
    },
    body: JSON.stringify({
      displayName: "Compatibility",
      pageTitle: "Compatibility work log",
      timeZone: "America/Chicago",
      agentLabel: "fixture agent",
    }),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as Bootstrap;
}

function agentHeaders(workspace: Bootstrap, key?: string): Record<string, string> {
  return {
    authorization: `Bearer ${workspace.agentCredential.token}`,
    ...(key ? { "content-type": "application/json", "idempotency-key": key } : {}),
  };
}

async function claim(workspace: { claim: { token: string } }): Promise<string> {
  let message: TransactionalEmail | undefined;
  await requestClaimVerification(
    env,
    workspace.claim.token,
    "compatibility@example.com",
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

async function getJson<T>(workspace: Bootstrap, route: string): Promise<T> {
  const response = await exports.default.fetch(
    `https://frank.test/v1/workspaces/${workspace.workspace.id}${route}`,
    { headers: agentHeaders(workspace) },
  );
  expect(response.status).toBe(200);
  return (await response.json()) as T;
}

describe("Frank Cloud portable compatibility fixtures", () => {
  it("requires idempotency keys before entry or project mutation", async () => {
    const workspace = await bootstrap();
    const entryUrl = `https://frank.test/v1/workspaces/${workspace.workspace.id}/entries`;
    const projectUrl = `https://frank.test/v1/workspaces/${workspace.workspace.id}/projects`;
    const authorization = `Bearer ${workspace.agentCredential.token}`;

    for (const idempotencyValue of [undefined, "   "]) {
      const headers = {
        authorization,
        "content-type": "application/json",
        ...(idempotencyValue === undefined ? {} : { "idempotency-key": idempotencyValue }),
      };
      const entry = await exports.default.fetch(entryUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({
          type: "note",
          text: "Must not be created",
          source: "agent:idempotency-test",
        }),
      });
      expect(entry.status).toBe(400);
      const project = await exports.default.fetch(projectUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({ name: "Must Not Exist" }),
      });
      expect(project.status).toBe(400);
    }

    await expect(getJson<{ entries: Entry[]; truncated: boolean }>(workspace, "/entries")).resolves.toEqual({
      entries: [],
      truncated: false,
    });
    await expect(
      getJson<{ projects: unknown[] }>(workspace, "/projects"),
    ).resolves.toEqual({ projects: [] });
  });

  it("replays a Phase 1 todo idempotency record without creating a new entry", async () => {
    const workspace = await bootstrap();
    const stub = env.WORKSPACES.getByName(workspace.workspace.id);
    const requestBody = {
      type: "todo",
      text: "Pending Phase 1 retry",
      tags: [],
      source: "agent:phase-1",
    };
    const requestHash = await hashText(JSON.stringify(requestBody));
    const createdAt = "2026-01-10T12:00:00.000Z";
    const oldResponse = await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO entries (
           type, raw_text, tags_json, source, actor_type, actor_id,
           created_at, updated_at
         ) VALUES ('todo', ?, '[]', ?, 'agent', ?, ?, ?)`,
        requestBody.text,
        requestBody.source,
        workspace.agentCredential.id,
        createdAt,
        createdAt,
      );
      const id = Number(
        state.storage.sql.exec<{ id: number }>("SELECT last_insert_rowid() AS id").one().id,
      );
      const response = {
        id,
        type: "todo",
        text: requestBody.text,
        title: null,
        project: null,
        projectRaw: null,
        tags: [],
        source: requestBody.source,
        status: "open",
        actorType: "agent",
        actorId: workspace.agentCredential.id,
        createdAt,
        closedAt: null,
      };
      state.storage.sql.exec(
        `INSERT INTO idempotency_keys (
           actor_id, idempotency_key, request_hash, response_status,
           response_json, expires_at
         ) VALUES (?, 'phase-1-pending-retry', ?, 201, ?, '2099-01-01T00:00:00.000Z')`,
        workspace.agentCredential.id,
        requestHash,
        JSON.stringify(response),
      );
      return response;
    });

    const replay = await exports.default.fetch(
      `https://frank.test/v1/workspaces/${workspace.workspace.id}/entries`,
      {
        method: "POST",
        headers: agentHeaders(workspace, "phase-1-pending-retry"),
        body: JSON.stringify(requestBody),
      },
    );
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toEqual({
      entry: oldResponse,
      replayed: true,
    });
    await expect(getJson<{ entries: Entry[] }>(workspace, "/entries")).resolves.toMatchObject({
      entries: [{ id: oldResponse.id, text: requestBody.text }],
    });
  });

  it("uses the workspace calendar date for historical summaries beyond 1000 newer entries", async () => {
    const workspace = await bootstrap();
    const stub = env.WORKSPACES.getByName(workspace.workspace.id);
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.transactionSync(() => {
        state.storage.sql.exec(`
          INSERT INTO entries (
            type, raw_text, source, actor_type, actor_id, created_at, updated_at
          ) VALUES (
            'note', 'Chicago boundary entry', 'test:summary', 'system', 'summary-test',
            '2026-01-15T05:30:00.000Z', '2026-01-15T05:30:00.000Z'
          )
        `);
        state.storage.sql.exec(`
          WITH RECURSIVE seq(n) AS (
            VALUES(1) UNION ALL SELECT n + 1 FROM seq WHERE n < 1001
          )
          INSERT INTO entries (
            type, raw_text, source, actor_type, actor_id, created_at, updated_at
          )
          SELECT 'note', 'newer entry ' || n, 'test:summary', 'system', 'summary-test',
                 '2026-01-16T12:00:00.000Z', '2026-01-16T12:00:00.000Z'
          FROM seq
        `);
      });
    });

    const januaryFourteenth = await getJson<{ body: string }>(
      workspace,
      "/summary?date=2026-01-14",
    );
    expect(januaryFourteenth.body).toContain("Chicago boundary entry");
    expect(januaryFourteenth.body).not.toContain("newer entry");
    const januaryFifteenth = await getJson<{ body: string }>(
      workspace,
      "/summary?date=2026-01-15",
    );
    expect(januaryFifteenth.body).toContain(
      "No Frank entries were captured for this date.",
    );
    const summaryCount = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<{ count: number }>("SELECT COUNT(*) AS count FROM daily_summaries")
        .one().count,
    );
    expect(summaryCount).toBe(0);
  });

  it("matches local entry, project, projection, completion, history, and summary semantics", async () => {
    const workspace = await bootstrap();
    const projectRequest = { name: fixture.project.name, aliases: fixture.project.aliases };
    const projectResponse = await exports.default.fetch(
      `https://frank.test/v1/workspaces/${workspace.workspace.id}/projects`,
      {
        method: "POST",
        headers: agentHeaders(workspace, "fixture-project"),
        body: JSON.stringify(projectRequest),
      },
    );
    expect(projectResponse.status).toBe(201);
    const createdProject = (await projectResponse.json()) as {
      replayed: boolean;
      project: { name: string; aliases: string[] };
    };
    expect(createdProject).toMatchObject({
      replayed: false,
      project: { name: fixture.project.name },
    });
    expect(createdProject.project.aliases).toEqual(
      expect.arrayContaining(fixture.project.aliases),
    );
    const projectReplay = await exports.default.fetch(
      `https://frank.test/v1/workspaces/${workspace.workspace.id}/projects`,
      {
        method: "POST",
        headers: agentHeaders(workspace, "fixture-project"),
        body: JSON.stringify(projectRequest),
      },
    );
    expect(projectReplay.status).toBe(200);
    await expect(projectReplay.json()).resolves.toMatchObject({
      replayed: true,
      project: { name: fixture.project.name },
    });

    const entries = new Map<string, Entry>();
    for (const item of fixture.entries) {
      const response = await exports.default.fetch(
        `https://frank.test/v1/workspaces/${workspace.workspace.id}/entries`,
        {
          method: "POST",
          headers: agentHeaders(workspace, `fixture-entry-${item.key}`),
          body: JSON.stringify({
            type: item.type,
            text: item.text,
            title: "title" in item ? item.title : undefined,
            project: item.project,
            tags: "tags" in item ? item.tags : [],
            structuredJson: "structuredJson" in item ? item.structuredJson : {},
            source: "agent:compatibility-fixture",
          }),
        },
      );
      expect(response.status).toBe(201);
      const body = (await response.json()) as { entry: Entry };
      entries.set(item.key, body.entry);
      expect(body.entry.actorId).toBeTruthy();
      expect(body.entry.source).toBe("agent:compatibility-fixture");
      if (item.project === "AcmeBackup") {
        expect(body.entry.project).toBe("AcmeBackup");
      } else {
        expect(body.entry.project).toBe(fixture.project.name);
      }
      expect(body.entry.projectRaw).toBe(item.project);
    }

    const legacyTodo = fixture.entries.find((entry) => entry.key === "todo")!;
    const expectedLegacyHash = await hashText(
      JSON.stringify({
        type: "todo",
        text: legacyTodo.text,
        title: legacyTodo.title,
        project: legacyTodo.project,
        tags: legacyTodo.tags,
        source: "agent:compatibility-fixture",
      }),
    );
    const storedTodoHash = await runInDurableObject(
      env.WORKSPACES.getByName(workspace.workspace.id),
      (_instance, state) =>
        state.storage.sql
          .exec<{ request_hash: string }>(
            `SELECT request_hash FROM idempotency_keys
             WHERE idempotency_key = 'fixture-entry-todo'`,
          )
          .one().request_hash,
    );
    expect(storedTodoHash).toBe(expectedLegacyHash);

    expect(new Set(Array.from(entries.values(), (entry) => entry.type))).toEqual(
      new Set(fixture.expected.entryTypes),
    );
    expect(entries.get("done")?.status).toBe("closed");
    expect(entries.get("todo")?.status).toBe("open");
    expect(entries.get("blocker")?.status).toBe("open");
    expect(entries.get("session")?.structuredJson).toEqual(
      fixture.entries.find((entry) => entry.key === "session")?.structuredJson,
    );
    const activeEntries = await getJson<{ entries: Entry[] }>(
      workspace,
      "/entries?type=active&limit=100",
    );
    const replacedActive = activeEntries.entries.find(
      (entry) => entry.id === entries.get("activeFirst")?.id,
    );
    expect(replacedActive?.status).toBe("closed");
    expect(replacedActive?.closedAt).toBe(fixture.expected.replacedActiveClosedAt);
    expect(activeEntries.entries.find((entry) => entry.id === entries.get("activeReplacement")?.id)?.status).toBe("open");

    const status = await getJson<{
      active: Entry;
      activeRightNow: Entry[];
      activeProjects: Array<{
        name: string;
        count: number;
        lastType: string;
        lastText: string;
      }>;
      openLoops: Entry[];
      recent: Entry[];
    }>(workspace, "/status");
    expect(status.active.id).toBe(entries.get(fixture.expected.currentStatusKey)?.id);
    expect(status.activeRightNow.map((entry) => entry.id)).toEqual(
      fixture.expected.openActiveKeys.map((key) => entries.get(key)?.id),
    );
    expect(
      status.activeProjects.map(({ name, count, lastType, lastText }) => ({
        name,
        count,
        lastType,
        lastText,
      })),
    ).toEqual(fixture.expected.activeProjects);
    expect(status.openLoops.map((entry) => entry.id)).toEqual(
      fixture.expected.openLoopKeys.map((key) => entries.get(key)?.id),
    );
    expect(status.recent.map((entry) => entry.id)).toEqual(
      fixture.expected.recentKeys.map((key) => entries.get(key)?.id),
    );

    const open = await getJson<{ entries: Entry[] }>(workspace, "/open");
    expect(open.entries.map((entry) => entry.id)).toEqual(
      fixture.expected.openLoopKeys.map((key) => entries.get(key)?.id),
    );

    const history = await getJson<{ project: string; openLoops: Entry[]; entries: Entry[] }>(
      workspace,
      `/projects/${encodeURIComponent(fixture.project.rawAlias)}/entries`,
    );
    expect(history.project).toBe(fixture.project.name);
    expect(history.entries.map((entry) => entry.id)).toEqual(
      fixture.expected.projectHistoryKeys.map((key) => entries.get(key)?.id),
    );
    expect(history.openLoops.map((entry) => entry.id)).toEqual(
      fixture.expected.openLoopKeys.map((key) => entries.get(key)?.id),
    );

    const cookie = await claim(workspace);
    for (const key of fixture.expected.openLoopKeys) {
      const response = await exports.default.fetch(
        `https://frank.test/v1/workspaces/${workspace.workspace.id}/entries/${entries.get(key)!.id}/close`,
        {
          method: "PATCH",
          headers: { cookie, origin: "https://frank.test" },
        },
      );
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ entry: { status: "closed" } });
    }
    const repeatedClose = await exports.default.fetch(
      `https://frank.test/v1/workspaces/${workspace.workspace.id}/entries/${entries.get("todo")!.id}/close`,
      { method: "PATCH", headers: { cookie, origin: "https://frank.test" } },
    );
    expect(repeatedClose.status).toBe(200);

    const allEntries = await getJson<{ entries: Entry[] }>(workspace, "/entries?limit=100");
    expect(allEntries.entries.filter((entry) => entry.type === "done")).toHaveLength(
      fixture.expected.doneCountAfterCompletion,
    );
    expect(allEntries.entries.filter((entry) => ["todo", "blocker"].includes(entry.type))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: entries.get("todo")!.id, status: "closed" }),
        expect.objectContaining({ id: entries.get("blocker")!.id, status: "closed" }),
      ]),
    );

    const summary = await getJson<{ date: string; body: string; mode: string }>(
      workspace,
      "/summary?date=today",
    );
    expect(summary.mode).toBe("deterministic");
    for (const heading of fixture.expected.summarySectionHeadings) {
      expect(summary.body).toContain(heading);
    }
    for (const fragment of fixture.expected.summaryFragments) {
      expect(summary.body).toContain(fragment);
    }
    const headingOffsets = fixture.expected.summarySectionHeadings.map((heading) =>
      summary.body.indexOf(heading),
    );
    expect(headingOffsets).toEqual([...headingOffsets].sort((a, b) => a - b));
    expect(summary.body).toBe(fixture.expected.summaryBody.replace("{{date}}", summary.date));
    const yesterday = await getJson<{ body: string }>(workspace, "/summary?date=yesterday");
    expect(yesterday.body).toContain("No Frank entries were captured for this date.");

    const isolated = await bootstrap();
    const crossWorkspaceRead = await exports.default.fetch(
      `https://frank.test/v1/workspaces/${isolated.workspace.id}/status`,
      { headers: agentHeaders(workspace) },
    );
    expect(crossWorkspaceRead.status).toBe(401);

    const exportResponse = await exports.default.fetch(
      `https://frank.test/v1/workspaces/${workspace.workspace.id}/export`,
      { headers: { cookie } },
    );
    const exported = (await exportResponse.json()) as {
      projects: Array<{ created_at: string; updated_at: string }>;
      aliases: Array<{ created_at: string }>;
      summaries: unknown[];
    };
    expect(exported.projects[0]).toMatchObject({
      created_at: expect.any(String),
      updated_at: expect.any(String),
    });
    expect(exported.aliases[0]).toMatchObject({ created_at: expect.any(String) });
    expect(exported.summaries).toEqual([]);
  });
});
