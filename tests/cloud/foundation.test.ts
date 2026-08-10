import { env, exports } from "cloudflare:workers";
import { evictAllDurableObjects, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("Frank Cloud foundation", () => {
  it("serves a no-store health response", async () => {
    const response = await exports.default.fetch("https://frank.test/health");

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      ok: true,
      service: "frank-cloud",
    });
  });

  it("returns structured JSON for unknown routes", async () => {
    const response = await exports.default.fetch("https://frank.test/missing");

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Not found" });
  });

  it("serves a landing page at the root", async () => {
    const response = await exports.default.fetch("https://frank.test/");
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("A work log for you and your agents");
    expect(html).toContain("Tell your agent");
    expect(html).toContain("/login");
  });

  it("serves an agent-setup page", async () => {
    const response = await exports.default.fetch("https://frank.test/agent-setup");
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Connect an agent to Frank");
    expect(html).toContain("/skills/frank-cloud/SKILL.md");
    expect(html).toContain("FRANK_CLOUD_TOKEN");
  });

  it("hosts the portable skill and helper for direct download", async () => {
    const skill = await exports.default.fetch("https://frank.test/skills/frank-cloud/SKILL.md");
    expect(skill.status).toBe(200);
    expect(skill.headers.get("content-type")).toContain("markdown");
    const skillBody = await skill.text();
    expect(skillBody).toContain("Frank Cloud Work Log Skill");

    const helper = await exports.default.fetch(
      "https://frank.test/skills/frank-cloud/frank-cloud-post.sh",
    );
    expect(helper.status).toBe(200);
    const helperBody = await helper.text();
    expect(helperBody).toContain("frank-cloud-post.sh");
    expect(helperBody).toContain("FRANK_CLOUD_BASE");
  });

  it("applies the D1 directory migration", async () => {
    const rows = await env.DIRECTORY.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table'
        AND name IN (
          'users',
          'workspaces',
          'workspace_owners',
          'agent_credentials',
          'claim_tokens',
          'browser_sessions',
          'email_preferences'
        )
      ORDER BY name
    `).all<{ name: string }>();

    expect(rows.results.map((row) => row.name)).toEqual([
      "agent_credentials",
      "browser_sessions",
      "claim_tokens",
      "email_preferences",
      "users",
      "workspace_owners",
      "workspaces",
    ]);
  });

  it("transactionally migrates populated v1 project aliases and collisions", async () => {
    const workspaceName = "populated-v1-migration";
    const initial = env.WORKSPACES.getByName(workspaceName);
    await initial.getSchemaInfo();
    await runInDurableObject(initial, (_instance, state) => {
      state.storage.sql.exec(`
        DELETE FROM idempotency_keys;
        DELETE FROM entries;
        DELETE FROM project_aliases;
        DELETE FROM projects;
        DROP INDEX IF EXISTS project_aliases_normalized_idx;
        DROP TABLE project_aliases;
        CREATE TABLE project_aliases (
          alias TEXT PRIMARY KEY COLLATE NOCASE,
          project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        );
        CREATE INDEX project_aliases_project_idx ON project_aliases(project_id);
        INSERT INTO projects (id, name, slug) VALUES
          (100, 'Example Portal', 'example-portal-old'),
          (200, 'example-portal', 'example-portal-new');
        INSERT INTO project_aliases (alias, project_id, created_at) VALUES
          ('Portal Alias', 200, '2025-01-02T03:04:05.000Z'),
          ('portal_alias', 100, '2025-02-03T04:05:06.000Z'),
          ('legacy-dashboard', 200, '2025-03-04T05:06:07.000Z');
        INSERT INTO entries (
          type, raw_text, project_id, project_raw, source, actor_type, actor_id
        ) VALUES (
          'note', 'Seeded before migration', 200, 'example_portal',
          'test:v1', 'agent', 'credential-v1'
        );
        UPDATE workspace_meta SET value = '1' WHERE key = 'schema_version';
      `);
    });

    await evictAllDurableObjects();
    const migrated = env.WORKSPACES.getByName(workspaceName);
    await expect(migrated.getSchemaInfo()).resolves.toMatchObject({ version: 3 });
    const projects = await migrated.listProjects(true);
    expect(projects).toHaveLength(1);
    expect(projects[0]).toMatchObject({ id: 100, name: "Example Portal" });
    const seeded = await migrated.listEntries({ project: "example-portal", limit: 10 });
    expect(seeded).toHaveLength(1);
    expect(seeded[0]).toMatchObject({
      project: "Example Portal",
      projectRaw: "example_portal",
    });
    const migratedAliases = await runInDurableObject(migrated, (_instance, state) =>
      state.storage.sql
        .exec<{
          alias: string;
          normalized_alias: string;
          project_id: number;
          created_at: string;
        }>(`
          SELECT alias, normalized_alias, project_id, created_at
          FROM project_aliases ORDER BY normalized_alias
        `)
        .toArray(),
    );
    expect(migratedAliases).toEqual([
      {
        alias: "Example Portal",
        normalized_alias: "example portal",
        project_id: 100,
        created_at: expect.any(String),
      },
      {
        alias: "legacy-dashboard",
        normalized_alias: "legacy dashboard",
        project_id: 100,
        created_at: "2025-03-04T05:06:07.000Z",
      },
      {
        alias: "Portal Alias",
        normalized_alias: "portal alias",
        project_id: 100,
        created_at: "2025-01-02T03:04:05.000Z",
      },
    ]);
    expect(
      migratedAliases.every((alias) => alias.normalized_alias.length > 0),
    ).toBe(true);

    const created = await migrated.createEntry({
      type: "note",
      text: "Created after migration",
      project: "EXAMPLE_portal",
      tags: [],
      source: "test:v2",
      actor: { type: "agent", id: "credential-v2" },
      idempotencyKey: "post-migration-entry",
      requestHash: "post-migration-hash",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    expect(created).toMatchObject({
      kind: "created",
      value: { project: "Example Portal", projectRaw: "EXAMPLE_portal" },
    });
    await expect(migrated.listProjects(true)).resolves.toHaveLength(1);
  });

  it("initializes isolated SQLite storage for each workspace", async () => {
    const first = env.WORKSPACES.getByName("workspace-one");
    const second = env.WORKSPACES.getByName("workspace-two");

    const [firstSchema, secondSchema] = await Promise.all([
      first.getSchemaInfo(),
      second.getSchemaInfo(),
    ]);

    expect(firstSchema).toEqual(secondSchema);
    expect(firstSchema.version).toBe(3);
    expect(firstSchema.tables).toEqual([
      "daily_summaries",
      "entries",
      "idempotency_keys",
      "project_aliases",
      "project_events",
      "projects",
      "workspace_meta",
    ]);

    await runInDurableObject(first, (_instance, state) => {
      state.storage.sql.exec(
        "INSERT INTO workspace_meta (key, value) VALUES ('marker', 'first')",
      );
    });

    const [firstMarkers, secondMarkers] = await Promise.all([
      runInDurableObject(first, (_instance, state) =>
        state.storage.sql
          .exec<{ value: string }>(
            "SELECT value FROM workspace_meta WHERE key = 'marker'",
          )
          .toArray(),
      ),
      runInDurableObject(second, (_instance, state) =>
        state.storage.sql
          .exec<{ value: string }>(
            "SELECT value FROM workspace_meta WHERE key = 'marker'",
          )
          .toArray(),
      ),
    ]);

    expect(firstMarkers).toEqual([{ value: "first" }]);
    expect(secondMarkers).toEqual([]);
  });

  it("cleans up abandoned unclaimed workspaces older than the claim window", async () => {
    const { cleanupAbandonedWorkspaces } = await import("../../src/cloud/directory");
    // Insert an old unclaimed workspace and a fresh one.
    const oldId = "wsp_cleanup_old";
    const freshId = "wsp_cleanup_fresh";
    await env.DIRECTORY.batch([
      env.DIRECTORY.prepare(
        `INSERT INTO workspaces (id, state, created_at) VALUES (?, 'unclaimed', ?)`,
      ).bind(oldId, "2020-01-01T00:00:00.000Z"),
      env.DIRECTORY.prepare(
        `INSERT INTO workspaces (id, state, created_at) VALUES (?, 'unclaimed', ?)`,
      ).bind(freshId, new Date().toISOString()),
    ]);

    const cleaned = await cleanupAbandonedWorkspaces(env);
    expect(cleaned).toBeGreaterThanOrEqual(1);

    const oldRow = await env.DIRECTORY.prepare(
      "SELECT state FROM workspaces WHERE id = ?",
    )
      .bind(oldId)
      .first<{ state: string }>();
    const freshRow = await env.DIRECTORY.prepare(
      "SELECT state FROM workspaces WHERE id = ?",
    )
      .bind(freshId)
      .first<{ state: string }>();
    expect(oldRow?.state).toBe("deleted");
    expect(freshRow?.state).toBe("unclaimed");
  });
});
