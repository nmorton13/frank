import { DurableObject } from "cloudflare:workers";

const WORKSPACE_SCHEMA_VERSION = 3;
export const WORKSPACE_ENTRY_TYPES = [
  "status",
  "active",
  "note",
  "todo",
  "blocker",
  "done",
  "decision",
  "session",
] as const;

export type WorkspaceEntryType = (typeof WORKSPACE_ENTRY_TYPES)[number];

export function isWorkspaceEntryType(value: string): value is WorkspaceEntryType {
  return (WORKSPACE_ENTRY_TYPES as readonly string[]).includes(value);
}

export interface WorkspaceSchemaInfo {
  version: number;
  tables: string[];
}

export interface WorkspaceActor {
  type: "agent" | "human";
  id: string;
}

/**
 * A deliberate, client-addressable project lifecycle error. The route layer maps
 * this to a clean 4xx response instead of a generic 500.
 */

export type WorkspaceJsonPrimitive = null | boolean | number | string;
export type WorkspaceJsonValue =
  | WorkspaceJsonPrimitive
  | WorkspaceJsonPrimitive[]
  | { [key: string]: WorkspaceJsonPrimitive | WorkspaceJsonPrimitive[] };

export interface WorkspaceJsonObject {
  [key: string]: WorkspaceJsonValue;
}

export interface WorkspaceEntry {
  id: number;
  type: WorkspaceEntryType;
  text: string;
  structuredJson: WorkspaceJsonObject;
  title: string | null;
  project: string | null;
  projectRaw: string | null;
  tags: string[];
  source: string;
  sessionId: string | null;
  status: "open" | "closed";
  actorType: string;
  actorId: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  closeNote: string | null;
}

export interface WorkspaceProject {
  id: number;
  name: string;
  slug: string;
  status: "active" | "archived";
  aliases: string[];
}

export interface WorkspaceStatusProjection {
  active: WorkspaceEntry | null;
  activeRightNow: WorkspaceEntry[];
  activeProjects: Array<{
    name: string;
    count: number;
    lastType: WorkspaceEntryType;
    lastText: string;
    updatedAt: string;
  }>;
  openLoops: WorkspaceEntry[];
  recent: WorkspaceEntry[];
  truncated?: boolean;
}

export interface WorkspaceEntryPage {
  entries: WorkspaceEntry[];
  truncated: boolean;
}

export interface WorkspaceProjectHistory {
  project: string;
  openLoops: WorkspaceEntry[];
  entries: WorkspaceEntry[];
  truncated?: { openLoops: boolean; entries: boolean };
}

export interface WorkspaceSummary {
  date: string;
  body: string;
  mode: "deterministic";
  entries: WorkspaceEntry[];
  truncated: {
    sourceEntries: boolean;
    responseEntries: boolean;
    body: boolean;
  };
}

export type MutationResult<T> =
  | { kind: "created"; status: 201; value: T }
  | { kind: "replayed"; status: 201; value: T }
  | { kind: "conflict"; status: 409; value: null }
  | { kind: "error"; status: number; message: string; value: null };

/**
 * A client-addressable lifecycle error produced inside a Durable Object. Unlike
 * throwing a `ProjectError` across the RPC boundary (which surfaces as an
 * unhandled promise rejection in callers and test harnesses), these are returned
 * as structured values and mapped to a clean 4xx response by the route layer.
 */
interface LifecycleError {
  ok: false;
  status: number;
  message: string;
}

type LifecycleOutcome<T> = T | LifecycleError;

function lifecycleError(status: number, message: string): LifecycleError {
  return { ok: false, status, message };
}

function isLifecycleError(value: unknown): value is LifecycleError {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as LifecycleError).ok === false &&
    typeof (value as LifecycleError).status === "number" &&
    typeof (value as LifecycleError).message === "string"
  );
}

export type CreateTodoResult =
  | { kind: "created"; status: 201; entry: WorkspaceEntry }
  | { kind: "replayed"; status: 201; entry: WorkspaceEntry }
  | { kind: "conflict" };

interface IdempotentInput {
  actor: WorkspaceActor;
  idempotencyKey: string;
  requestHash: string;
  expiresAt: string;
}

export class Workspace extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    this.ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        PRAGMA foreign_keys = ON;

        CREATE TABLE IF NOT EXISTS workspace_meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS projects (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL COLLATE NOCASE UNIQUE,
          slug TEXT NOT NULL COLLATE NOCASE UNIQUE,
          status TEXT NOT NULL DEFAULT 'active'
            CHECK (status IN ('active', 'archived')),
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
          updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        );

        CREATE TABLE IF NOT EXISTS project_aliases (
          alias TEXT PRIMARY KEY COLLATE NOCASE,
          normalized_alias TEXT,
          project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        );

        CREATE INDEX IF NOT EXISTS project_aliases_project_idx
          ON project_aliases(project_id);

        CREATE TABLE IF NOT EXISTS project_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          action TEXT NOT NULL CHECK (
            action IN ('rename', 'merge', 'archive', 'inactive', 'reactivate')
          ),
          detail_json TEXT NOT NULL DEFAULT '{}',
          actor_type TEXT NOT NULL CHECK (actor_type IN ('agent', 'human', 'system')),
          actor_id TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        );

        CREATE INDEX IF NOT EXISTS project_events_project_idx
          ON project_events(project_id, created_at);

        CREATE TABLE IF NOT EXISTS entries (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          type TEXT NOT NULL CHECK (
            type IN ('status', 'active', 'note', 'todo', 'blocker', 'done', 'decision', 'session')
          ),
          raw_text TEXT NOT NULL,
          structured_json TEXT NOT NULL DEFAULT '{}',
          project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
          project_raw TEXT,
          title TEXT,
          tags_json TEXT NOT NULL DEFAULT '[]',
          source TEXT NOT NULL,
          session_id TEXT,
          status TEXT NOT NULL DEFAULT 'open'
            CHECK (status IN ('open', 'closed')),
          actor_type TEXT NOT NULL CHECK (actor_type IN ('agent', 'human', 'system')),
          actor_id TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
          updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
          closed_at TEXT,
          close_note TEXT
        );

        CREATE INDEX IF NOT EXISTS entries_created_idx
          ON entries(created_at DESC, id DESC);

        CREATE INDEX IF NOT EXISTS entries_open_idx
          ON entries(status, type, created_at DESC);

        CREATE INDEX IF NOT EXISTS entries_project_idx
          ON entries(project_id, created_at DESC);

        CREATE TABLE IF NOT EXISTS daily_summaries (
          summary_date TEXT PRIMARY KEY,
          body TEXT NOT NULL,
          mode TEXT NOT NULL DEFAULT 'deterministic',
          generated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
          emailed_at TEXT
        );

        CREATE TABLE IF NOT EXISTS idempotency_keys (
          actor_id TEXT NOT NULL,
          idempotency_key TEXT NOT NULL,
          request_hash TEXT NOT NULL,
          response_status INTEGER NOT NULL,
          response_json TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
          expires_at TEXT NOT NULL,
          PRIMARY KEY (actor_id, idempotency_key)
        );

        CREATE INDEX IF NOT EXISTS idempotency_expiry_idx
          ON idempotency_keys(expires_at);
      `);

      const aliasColumns = this.ctx.storage.sql
        .exec<{ name: string }>("PRAGMA table_info(project_aliases)")
        .toArray()
        .map((column) => column.name);
      const needsNormalizedAliasColumn = !aliasColumns.includes("normalized_alias");
      const version = Number(
        this.ctx.storage.sql
          .exec<{ value: string }>(
            "SELECT value FROM workspace_meta WHERE key = 'schema_version'",
          )
          .toArray()[0]?.value ?? 0,
      );
      if (version < 2) {
        this.migrateToVersion2(needsNormalizedAliasColumn);
      } else {
        this.ctx.storage.sql.exec(
          "CREATE UNIQUE INDEX IF NOT EXISTS project_aliases_normalized_idx ON project_aliases(normalized_alias)",
        );
      }
      if (version < 3) {
        this.migrateToVersion3();
      }
    });
  }

  getSchemaInfo(): WorkspaceSchemaInfo {
    const versionRow = this.ctx.storage.sql
      .exec<{ value: string }>(
        "SELECT value FROM workspace_meta WHERE key = 'schema_version'",
      )
      .one();
    const tables = this.ctx.storage.sql
      .exec<{ name: string }>(`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table'
          AND name NOT LIKE 'sqlite_%'
          AND name NOT LIKE '_cf_%'
        ORDER BY name
      `)
      .toArray()
      .map((row) => row.name);

    return { version: Number(versionRow.value), tables };
  }

  createTodo(input: {
    text: string;
    title?: string;
    project?: string;
    tags: string[];
    source: string;
    actor: WorkspaceActor;
    idempotencyKey: string;
    requestHash: string;
    expiresAt: string;
  }): CreateTodoResult {
    const result = this.createEntry({ ...input, type: "todo" });
    if (result.kind === "conflict" || result.value === null) return { kind: "conflict" };
    return { kind: result.kind, status: 201, entry: result.value };
  }

  createEntry(input: IdempotentInput & {
    type: WorkspaceEntryType;
    text: string;
    structuredJson?: WorkspaceJsonObject;
    title?: string;
    project?: string;
    tags: string[];
    source: string;
    sessionId?: string;
  }): MutationResult<WorkspaceEntry> {
    return this.idempotentMutation(input, () => {
      const entryCount = Number(
        this.ctx.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM entries").one().count,
      );
      if (entryCount >= this.ceiling("WORKSPACE_ENTRY_CEILING", 10_000)) {
        return lifecycleError(429, "Workspace entry limit reached");
      }
      if (input.project && !this.findProject(input.project) && !this.canCreateProject()) {
        return lifecycleError(429, "Workspace project or alias limit reached");
      }
      const existingProject = input.project ? this.findProject(input.project) : null;
      if (existingProject?.status === "archived" && !this.canRecordProjectEvent()) {
        return lifecycleError(429, "Workspace project event limit reached");
      }
      const project = input.project ? this.ensureProject(input.project) : null;
      // Write-through-archived policy: a new entry reactivates an archived project.
      if (project && project.status === "archived") {
        this.ctx.storage.sql.exec(
          `UPDATE projects SET status = 'active',
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
           WHERE id = ?`,
          project.id,
        );
        this.recordProjectEvent(project.id, "reactivate", {}, input.actor);
      }
      if (input.type === "active" && project) {
        this.ctx.storage.sql.exec(
          `UPDATE entries
           SET status = 'closed',
               updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
           WHERE type = 'active' AND status = 'open' AND project_id = ?`,
          project.id,
        );
      }
      const status = input.type === "done" ? "closed" : "open";
      this.ctx.storage.sql.exec(
        `INSERT INTO entries (
          type, raw_text, structured_json, project_id, project_raw, title,
          tags_json, source, session_id, status, actor_type, actor_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        input.type,
        input.text,
        JSON.stringify(input.structuredJson ?? {}),
        project?.id ?? null,
        input.project ?? null,
        input.title ?? null,
        JSON.stringify(input.tags),
        input.source,
        input.sessionId ?? null,
        status,
        input.actor.type,
        input.actor.id,
      );
      const entryId = Number(
        this.ctx.storage.sql.exec<{ id: number }>("SELECT last_insert_rowid() AS id").one().id,
      );
      const entry = this.entryById(entryId);
      if (!entry) throw new Error("Created entry could not be read");
      return entry;
    });
  }

  createProject(input: IdempotentInput & {
    name: string;
    aliases: string[];
  }): MutationResult<WorkspaceProject> {
    return this.idempotentMutation<WorkspaceProject>(input, () => {
      if (!this.findProject(input.name) && !this.canCreateProject()) {
        return lifecycleError(429, "Workspace project or alias limit reached");
      }
      if (!this.canAddAliases([input.name, ...input.aliases])) {
        return lifecycleError(429, "Workspace alias limit reached");
      }
      const project = this.ensureProject(input.name);
      for (const alias of input.aliases) {
        const conflict = this.addAlias(project.id, alias);
        if (isLifecycleError(conflict)) return conflict;
      }
      return this.projectById(project.id)!;
    });
  }

  renameProject(input: IdempotentInput & {
    nameOrAlias: string;
    newName: string;
  }): MutationResult<WorkspaceProject> {
    return this.idempotentMutation<WorkspaceProject>(input, () => {
      const project = this.requireProject(input.nameOrAlias);
      if (isLifecycleError(project)) return project;
      if (!this.canRecordProjectEvent()) return lifecycleError(429, "Workspace project event limit reached");
      const cleaned = input.newName.trim();
      if (!cleaned) return lifecycleError(400, "New project name is required");
      const existing = this.findProject(cleaned);
      if (existing && existing.id !== project.id) {
        return lifecycleError(409, `Project already exists: ${cleaned}`);
      }
      if (!this.canAddAliases([project.name, cleaned])) {
        return lifecycleError(429, "Workspace alias limit reached");
      }
      const slug = this.uniqueSlug(cleaned, project.id);
      this.ctx.storage.sql.exec(
        `UPDATE projects
         SET name = ?, slug = ?,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ?`,
        cleaned,
        slug,
        project.id,
      );
      // Keep the old name as an alias so history lookups by the old name still work.
      this.addAlias(project.id, project.name);
      this.addAlias(project.id, cleaned);
      this.recordProjectEvent(project.id, "rename", { from: project.name, to: cleaned }, input.actor);
      return this.projectById(project.id)!;
    });
  }

  mergeProjects(input: IdempotentInput & {
    fromNameOrAlias: string;
    toNameOrAlias: string;
  }): MutationResult<WorkspaceProject> {
    return this.idempotentMutation<WorkspaceProject>(input, () => {
      const from = this.requireProject(input.fromNameOrAlias);
      if (isLifecycleError(from)) return from;
      const to = this.requireProject(input.toNameOrAlias);
      if (isLifecycleError(to)) return to;
      if (from.id === to.id) return this.projectById(to.id)!;
      if (!this.canRecordProjectEvent()) return lifecycleError(429, "Workspace project event limit reached");
      if (!this.canAddAliases([from.name])) return lifecycleError(429, "Workspace alias limit reached");

      // Repoint all entries from the source to the target.
      this.ctx.storage.sql.exec(
        "UPDATE entries SET project_id = ? WHERE project_id = ?",
        to.id,
        from.id,
      );
      // Reconcile "active" entries now that both projects share the target:
      // Frank allows only one open active-right-now entry per canonical project,
      // so keep the newest and close any older open ones.
      this.ctx.storage.sql.exec(
        `UPDATE entries
         SET status = 'closed',
             closed_at = COALESCE(closed_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE type = 'active' AND status = 'open' AND project_id = ?
           AND id NOT IN (
             SELECT id FROM entries
             WHERE type = 'active' AND status = 'open' AND project_id = ?
             ORDER BY created_at DESC, id DESC LIMIT 1
           )`,
        to.id,
        to.id,
      );
      // Transfer non-conflicting aliases; conflicting ones stay with their owner.
      // Compute the non-conflicting set BEFORE removing the source rows, since
      // the normalized_alias unique index would otherwise collide with the
      // source's own still-present alias rows on insert.
      const fromAliases = this.ctx.storage.sql
        .exec<{ alias: string; normalized_alias: string }>(
          "SELECT alias, normalized_alias FROM project_aliases WHERE project_id = ?",
          from.id,
        )
        .toArray();
      const transferable = fromAliases.filter((alias) => {
        // An alias conflicts only if some OTHER project (neither source nor
        // target) already owns its normalized form.
        const conflictingOwner = this.ctx.storage.sql
          .exec<{ project_id: number }>(
            `SELECT project_id FROM project_aliases
             WHERE normalized_alias = ? AND project_id NOT IN (?, ?) LIMIT 1`,
            alias.normalized_alias,
            from.id,
            to.id,
          )
          .toArray()[0];
        return !conflictingOwner;
      });
      this.ctx.storage.sql.exec(
        "DELETE FROM project_aliases WHERE project_id = ?",
        from.id,
      );
      for (const alias of transferable) {
        this.ctx.storage.sql.exec(
          `INSERT OR IGNORE INTO project_aliases (alias, normalized_alias, project_id)
           VALUES (?, ?, ?)`,
          alias.alias,
          alias.normalized_alias,
          to.id,
        );
      }
      // Retire the source project and keep its canonical name as an alias of the target.
      this.ctx.storage.sql.exec(
        "DELETE FROM project_aliases WHERE project_id = ?",
        from.id,
      );
      this.ctx.storage.sql.exec(
        `UPDATE projects SET status = 'archived',
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ?`,
        from.id,
      );
      this.addAlias(to.id, from.name);
      this.recordProjectEvent(to.id, "merge", { from: from.name, to: to.name }, input.actor);
      return this.projectById(to.id)!;
    });
  }

  archiveProject(input: IdempotentInput & {
    nameOrAlias: string;
  }): MutationResult<WorkspaceProject> {
    return this.idempotentMutation<WorkspaceProject>(input, () => {
      const project = this.requireProject(input.nameOrAlias);
      if (isLifecycleError(project)) return project;
      if (project.status === "archived") return this.projectById(project.id)!;
      if (!this.canRecordProjectEvent()) return lifecycleError(429, "Workspace project event limit reached");
      this.ctx.storage.sql.exec(
        `UPDATE projects SET status = 'archived',
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ?`,
        project.id,
      );
      this.recordProjectEvent(project.id, "archive", {}, input.actor);
      return this.projectById(project.id)!;
    });
  }

  inactiveProject(input: IdempotentInput & {
    nameOrAlias: string;
  }): MutationResult<WorkspaceProject> {
    return this.idempotentMutation<WorkspaceProject>(input, () => {
      const project = this.requireProject(input.nameOrAlias);
      if (isLifecycleError(project)) return project;
      if (!this.canRecordProjectEvent()) return lifecycleError(429, "Workspace project event limit reached");
      this.ctx.storage.sql.exec(
        `UPDATE entries
         SET status = 'closed',
             closed_at = COALESCE(closed_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE type = 'active' AND status = 'open' AND project_id = ?`,
        project.id,
      );
      this.recordProjectEvent(project.id, "inactive", {}, input.actor);
      return this.projectById(project.id)!;
    });
  }

  listProjects(includeArchived = false, limit = 100, offset = 0): WorkspaceProject[] {
    const safeLimit = clampLimit(limit, 100, 200);
    const safeOffset = Number.isFinite(offset) ? Math.min(Math.max(Math.trunc(offset), 0), 10_000) : 0;
    const rows = this.ctx.storage.sql
      .exec<ProjectRow>(`
        SELECT id, name, slug, status
        FROM projects
        ${includeArchived ? "" : "WHERE status = 'active'"}
        ORDER BY lower(name), id
        LIMIT ? OFFSET ?
      `, safeLimit, safeOffset)
      .toArray();
    if (!rows.length) return [];
    const projectIds = rows.map((row) => row.id);
    const aliases = this.ctx.storage.sql
      .exec<{ alias: string; project_id: number }>(
        `SELECT alias, project_id FROM project_aliases
         WHERE project_id IN (${projectIds.map(() => "?").join(",")})
         ORDER BY lower(alias)`,
        ...projectIds,
      )
      .toArray();
    const byProject = new Map<number, string[]>();
    for (const alias of aliases) {
      if (!byProject.has(alias.project_id)) byProject.set(alias.project_id, []);
      byProject.get(alias.project_id)!.push(alias.alias);
    }
    return rows.map((row) => ({ ...row, aliases: byProject.get(row.id) ?? [] }));
  }

  listEntries(filters: {
    type?: WorkspaceEntryType;
    project?: string;
    status?: "open" | "closed";
    limit?: number;
  } = {}): WorkspaceEntry[] {
    return this.listEntriesPage(filters).entries;
  }

  listEntriesPage(filters: {
    type?: WorkspaceEntryType;
    project?: string;
    status?: "open" | "closed";
    limit?: number;
  } = {}): WorkspaceEntryPage {
    const where: string[] = [];
    const bindings: SqlStorageValue[] = [];
    if (filters.type) {
      where.push("e.type = ?");
      bindings.push(filters.type);
    }
    if (filters.status) {
      where.push("e.status = ?");
      bindings.push(filters.status);
    }
    if (filters.project) {
      const project = this.findProject(filters.project);
      if (project) {
        where.push("e.project_id = ?");
        bindings.push(project.id);
      } else {
        where.push("(p.name = ? COLLATE NOCASE OR e.project_raw = ? COLLATE NOCASE)");
        bindings.push(filters.project, filters.project);
      }
    }
    const limit = clampLimit(filters.limit, 100, 100);
    const rows = this.ctx.storage.sql
      .exec<EntryRow>(`
        ${ENTRY_SELECT}
        ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY e.created_at DESC, e.id DESC
        LIMIT ?
      `, ...bindings, limit + 1)
      .toArray();
    const bounded = takeJsonWithinBytes(
      rows.slice(0, limit).map(toEntry),
      this.ceiling("COLLECTION_RESPONSE_BYTE_CEILING", 512 * 1024),
    );
    return {
      entries: bounded.values,
      truncated: rows.length > limit || bounded.truncated,
    };
  }

  listOpenLoops(limit = 100): WorkspaceEntry[] {
    return this.listOpenLoopsPage(limit).entries;
  }

  listOpenLoopsPage(limit = 100): WorkspaceEntryPage {
    const safeLimit = clampLimit(limit, 100, 100);
    const rows = this.ctx.storage.sql
      .exec<EntryRow>(`
        ${ENTRY_SELECT}
        WHERE e.status = 'open' AND e.type IN ('todo', 'blocker')
        ORDER BY e.created_at DESC, e.id DESC
        LIMIT ?
      `, safeLimit + 1)
      .toArray();
    const bounded = takeJsonWithinBytes(
      rows.slice(0, safeLimit).map(toEntry),
      this.ceiling("COLLECTION_RESPONSE_BYTE_CEILING", 512 * 1024),
    );
    return {
      entries: bounded.values,
      truncated: rows.length > safeLimit || bounded.truncated,
    };
  }

  getStatusProjection(options: { allOpenLoops?: boolean } = {}): WorkspaceStatusProjection {
    const recentForty = this.listEntries({ limit: 40 });
    // The headline status is a single, manually-set `status` entry. It must not
    // fall back to recent non-status entries, so open loops or active work never
    // drift into the headline.
    const active = recentForty.find((entry) => entry.type === "status") ?? null;
    const activeRightNow = this.listEntries({ type: "active", status: "open", limit: 12 });
    // "Active projects" must reflect current project status, so exclude any
    // project that has since been archived — even if it has recent entries.
    const archivedNames = new Set(
      this.ctx.storage.sql
        .exec<{ name: string }>("SELECT name FROM projects WHERE status = 'archived'")
        .toArray()
        .map((row) => row.name),
    );
    const projectMap = new Map<string, WorkspaceStatusProjection["activeProjects"][number]>();
    for (const entry of recentForty) {
      if (!entry.project || archivedNames.has(entry.project)) continue;
      const existing = projectMap.get(entry.project);
      if (existing) {
        existing.count += 1;
      } else {
        projectMap.set(entry.project, {
          name: entry.project,
          count: 1,
          lastType: entry.type,
          lastText: entry.text,
          updatedAt: entry.createdAt,
        });
      }
    }
    const openPage = this.listOpenLoopsPage(options.allOpenLoops ? 100 : 8);
    const projection: WorkspaceStatusProjection = {
      active,
      activeRightNow,
      activeProjects: Array.from(projectMap.values()).slice(0, 8),
      openLoops: openPage.entries,
      recent: recentForty.slice(0, 12),
      truncated: openPage.truncated,
    };
    const bounded = boundStatusProjection(
      projection,
      this.ceiling("COLLECTION_RESPONSE_BYTE_CEILING", 512 * 1024),
    );
    return bounded;
  }

  getProjectHistory(projectNameOrAlias: string, limit = 50): WorkspaceProjectHistory {
    const safeLimit = clampLimit(limit, 50, 100);
    const project = this.findProject(projectNameOrAlias);
    const canonicalName = project?.name ?? projectNameOrAlias;
    const openPage = this.listEntriesPage({
      project: projectNameOrAlias,
      status: "open",
      limit: 100,
    });
    const entryPage = this.listEntriesPage({ project: projectNameOrAlias, limit: safeLimit });
    const openLoops = openPage.entries.filter((entry) =>
      ["todo", "blocker"].includes(entry.type),
    );
    const budget = this.ceiling("COLLECTION_RESPONSE_BYTE_CEILING", 512 * 1024);
    const boundedOpen = takeJsonWithinBytes(openLoops, Math.floor(budget / 2));
    const remaining = Math.max(0, budget - boundedOpen.bytes - 1024);
    const boundedEntries = takeJsonWithinBytes(entryPage.entries, remaining);
    return {
      project: canonicalName,
      openLoops: boundedOpen.values,
      entries: boundedEntries.values,
      truncated: {
        openLoops: openPage.truncated || boundedOpen.truncated,
        entries: entryPage.truncated || boundedEntries.truncated,
      },
    };
  }

  buildDailySummary(date: string, timeZone: string): WorkspaceSummary {
    // Query a bounded 3-day window wide enough to capture any timezone offset,
    // then filter precisely in JS using the workspace timezone.
    const targetDate = new Date(`${date}T12:00:00Z`);
    const windowStart = new Date(targetDate.getTime() - 86400000).toISOString();
    const windowEnd = new Date(targetDate.getTime() + 86400000).toISOString();
    // Summary scans omit structured_json, the largest caller-controlled field.
    // A conservative hard maximum also bounds text materialization.
    const summaryEntryCeiling = Math.min(
      this.ceiling("SUMMARY_ENTRY_CEILING", 200),
      200,
    );
    const scanCeiling = Math.max(summaryEntryCeiling, summaryEntryCeiling * 3);
    const sourceRows = this.ctx.storage.sql
      .exec<EntryRow>(
        `${SUMMARY_ENTRY_SELECT} WHERE e.created_at >= ? AND e.created_at < ? ORDER BY e.created_at ASC, e.id ASC LIMIT ?`,
        windowStart,
        windowEnd,
        scanCeiling + 1,
      )
      .toArray();
    const sourceEntriesTruncated = sourceRows.length > scanCeiling;
    const filteredEntries = sourceRows
      .slice(0, scanCeiling)
      .map(toEntry)
      .filter((entry) => calendarDate(entry.createdAt, timeZone) === date);
    const sourceDateTruncated = sourceEntriesTruncated || filteredEntries.length > summaryEntryCeiling;
    const entries = filteredEntries.slice(0, summaryEntryCeiling);
    const openRows = this.ctx.storage.sql
      .exec<EntryRow>(`
        ${SUMMARY_ENTRY_SELECT}
        WHERE e.status = 'open' AND e.type IN ('todo', 'blocker')
        ORDER BY e.created_at DESC, e.id DESC LIMIT 51
      `)
      .toArray();
    const open = openRows.slice(0, 50).map(toEntry);
    const byType = (type: WorkspaceEntryType) => entries.filter((entry) => entry.type === type);
    const lines = [`# Frank Daily Work Summary - ${date}`, ""];
    if (!entries.length) {
      lines.push("No Frank entries were captured for this date.");
    } else {
      const sections: Array<[string, WorkspaceEntry[]]> = [
        ["Current status updates", byType("status")],
        ["Active work updates", byType("active")],
        ["Done", byType("done")],
        ["Decisions", byType("decision")],
        ["Blockers", byType("blocker")],
        ["Todos added", byType("todo")],
        ["Session summaries", byType("session")],
        ["Notes", byType("note")],
      ];
      for (const [heading, rows] of sections) {
        if (!rows.length) continue;
        lines.push(`## ${heading}`, summaryBullets(rows), "");
      }
    }
    if (open.length) lines.push("## Open loops", summaryBullets(open.slice(0, 50)), "");
    let body = `${lines.join("\n").trim()}\n`;
    const responseCeiling = this.ceiling("SUMMARY_RESPONSE_BYTE_CEILING", 512 * 1024);
    const bodyCeiling = Math.min(
      this.ceiling("SUMMARY_OUTPUT_BYTE_CEILING", 256 * 1024),
      Math.max(0, responseCeiling - 2048),
    );
    const boundedBody = truncateUtf8(body, bodyCeiling, "\n\n[Summary truncated at configured output limit.]\n");
    body = boundedBody.value;

    const entryBudget = Math.max(0, responseCeiling - utf8Bytes(body) - 1024);
    const boundedEntries = takeJsonWithinBytes(entries, entryBudget);
    return {
      date,
      body,
      mode: "deterministic",
      entries: boundedEntries.values,
      truncated: {
        sourceEntries: sourceDateTruncated,
        responseEntries: boundedEntries.truncated,
        body: boundedBody.truncated,
      },
    };
  }

  closeEntry(entryId: number, actor: WorkspaceActor): WorkspaceEntry | null {
    return this.ctx.storage.transactionSync(() => {
      const before = this.entryById(entryId);
      if (!before || !["todo", "blocker"].includes(before.type)) return null;
      if (before.status === "closed") return before;

      this.ctx.storage.sql.exec(
        `UPDATE entries
         SET status = 'closed',
             closed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ? AND status = 'open'`,
        entryId,
      );
      const entryCount = Number(
        this.ctx.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM entries").one().count,
      );
      // Closing must remain available at capacity. Only the convenience audit
      // row is omitted when inserting it would exceed the retained-entry cap.
      if (entryCount < this.ceiling("WORKSPACE_ENTRY_CEILING", 10_000)) {
        this.ctx.storage.sql.exec(
          `INSERT INTO entries (
            type, raw_text, structured_json, project_id, project_raw, title,
            tags_json, source, status, actor_type, actor_id
          )
          SELECT 'done', raw_text, json_object('closed_entry_id', id), project_id,
                 project_raw, title, tags_json, 'human:open-loop-completion', 'closed', ?, ?
          FROM entries WHERE id = ?`,
          actor.type,
          actor.id,
          entryId,
        );
      }
      return this.entryById(entryId);
    });
  }

  async deleteAllData(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }

  exportData(): string {
    const responseCeiling = this.ceiling("EXPORT_RESPONSE_BYTE_CEILING", 1024 * 1024);
    let remaining = Math.max(0, responseCeiling - 2048);
    const take = <T>(values: T[]): { values: T[]; truncated: boolean } => {
      const bounded = takeJsonWithinBytes(values, remaining);
      remaining = Math.max(0, remaining - bounded.bytes);
      return bounded;
    };

    const entryCeiling = Math.min(this.ceiling("EXPORT_ENTRY_CEILING", 100), 100);
    const rawEntries = this.ctx.storage.sql
      .exec<EntryRow>(`${ENTRY_SELECT} ORDER BY e.created_at, e.id LIMIT ?`, entryCeiling + 1)
      .toArray();
    const entries = take(rawEntries.slice(0, entryCeiling).map(toEntry));
    const projectCeiling = this.ceiling("WORKSPACE_PROJECT_CEILING", 1_000);
    const rawProjects = this.ctx.storage.sql
      .exec("SELECT * FROM projects ORDER BY id LIMIT ?", projectCeiling + 1)
      .toArray();
    const projects = take(rawProjects.slice(0, projectCeiling));
    const aliasCeiling = this.ceiling("WORKSPACE_ALIAS_CEILING", 20_000);
    const rawAliases = this.ctx.storage.sql
      .exec("SELECT * FROM project_aliases ORDER BY normalized_alias LIMIT ?", aliasCeiling + 1)
      .toArray();
    const aliases = take(rawAliases.slice(0, aliasCeiling));
    const summaryCeiling = 30;
    const rawSummaries = this.ctx.storage.sql
      .exec("SELECT * FROM daily_summaries ORDER BY summary_date LIMIT ?", summaryCeiling + 1)
      .toArray();
    const summaries = take(rawSummaries.slice(0, summaryCeiling));
    return JSON.stringify({
      projects: projects.values,
      aliases: aliases.values,
      entries: entries.values,
      summaries: summaries.values,
      truncated: {
        projects: rawProjects.length > projectCeiling || projects.truncated,
        aliases: rawAliases.length > aliasCeiling || aliases.truncated,
        entries: rawEntries.length > entryCeiling || entries.truncated,
        summaries: rawSummaries.length > summaryCeiling || summaries.truncated,
      },
    });
  }

  private allEntries(): WorkspaceEntry[] {
    return this.ctx.storage.sql
      .exec<EntryRow>(`${ENTRY_SELECT} ORDER BY e.created_at DESC, e.id DESC`)
      .toArray()
      .map(toEntry);
  }

  private migrateToVersion2(addNormalizedAliasColumn: boolean): void {
    this.ctx.storage.transactionSync(() => {
      if (addNormalizedAliasColumn) {
        this.ctx.storage.sql.exec(
          "ALTER TABLE project_aliases ADD COLUMN normalized_alias TEXT",
        );
      }
      const projects = this.ctx.storage.sql
        .exec<MigrationProjectRow>(
          "SELECT id, name, slug, status, created_at FROM projects ORDER BY id",
        )
        .toArray();
      const existingAliases = this.ctx.storage.sql
        .exec<MigrationAliasRow>(`
          SELECT alias, project_id, created_at
          FROM project_aliases
          ORDER BY datetime(created_at), lower(alias), alias, project_id
        `)
        .toArray();
      const canonicalOwner = new Map<string, number>();
      const replacement = new Map<number, number>();

      for (const project of projects) {
        const normalized = normalizeProjectAlias(project.name);
        const ownerId = canonicalOwner.get(normalized);
        if (ownerId === undefined) {
          canonicalOwner.set(normalized, project.id);
          replacement.set(project.id, project.id);
        } else {
          replacement.set(project.id, ownerId);
          this.ctx.storage.sql.exec(
            "UPDATE entries SET project_id = ? WHERE project_id = ?",
            ownerId,
            project.id,
          );
        }
      }

      this.ctx.storage.sql.exec("DELETE FROM project_aliases");
      for (const project of projects) {
        const ownerId = replacement.get(project.id)!;
        if (ownerId !== project.id) {
          this.ctx.storage.sql.exec("DELETE FROM projects WHERE id = ?", project.id);
        }
      }

      const candidates: MigrationAliasCandidate[] = [
        ...existingAliases.map((row) => ({
          alias: row.alias,
          projectId: replacement.get(row.project_id) ?? row.project_id,
          createdAt: row.created_at,
        })),
        ...projects
          .filter((project) => replacement.get(project.id) === project.id)
          .map((project) => ({
            alias: project.name,
            projectId: project.id,
            createdAt: project.created_at,
          })),
      ];
      const inserted = new Map<string, number>();
      for (const candidate of candidates) {
        const normalized = normalizeProjectAlias(candidate.alias);
        if (!normalized) continue;
        const existingOwner = inserted.get(normalized);
        if (existingOwner !== undefined) {
          if (existingOwner !== candidate.projectId) {
            throw new Error(
              `Cannot migrate normalized project alias collision: ${candidate.alias}`,
            );
          }
          continue;
        }
        this.ctx.storage.sql.exec(
          `INSERT INTO project_aliases (
             alias, normalized_alias, project_id, created_at
           ) VALUES (?, ?, ?, ?)`,
          candidate.alias,
          normalized,
          candidate.projectId,
          candidate.createdAt,
        );
        inserted.set(normalized, candidate.projectId);
      }
      this.ctx.storage.sql.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS project_aliases_normalized_idx ON project_aliases(normalized_alias)",
      );
      this.ctx.storage.sql.exec(
        `INSERT INTO workspace_meta (key, value) VALUES ('schema_version', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value;`,
        String(WORKSPACE_SCHEMA_VERSION),
      );
    });
  }

  private migrateToVersion3(): void {
    this.ctx.storage.transactionSync(() => {
      // project_events is created idempotently in the constructor schema block.
      // This migration only stamps the schema version so the audit table is
      // guaranteed present for existing v2 workspaces.
      this.ctx.storage.sql.exec(
        `INSERT INTO workspace_meta (key, value) VALUES ('schema_version', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value;`,
        String(WORKSPACE_SCHEMA_VERSION),
      );
    });
  }

  private idempotentMutation<T>(
    input: IdempotentInput,
    mutate: () => LifecycleOutcome<T>,
  ): MutationResult<T> {
    return this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        "DELETE FROM idempotency_keys WHERE expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
      );
      const existing = this.ctx.storage.sql
        .exec<{ request_hash: string; response_json: string }>(
          `SELECT request_hash, response_json FROM idempotency_keys
           WHERE actor_id = ? AND idempotency_key = ?`,
          input.actor.id,
          input.idempotencyKey,
        )
        .toArray()[0];
      if (existing) {
        if (existing.request_hash !== input.requestHash) {
          return { kind: "conflict", status: 409, value: null };
        }
        return {
          kind: "replayed",
          status: 201,
          value: JSON.parse(existing.response_json) as T,
        };
      }
      const value = mutate();
      if (isLifecycleError(value)) {
        return { kind: "error", status: value.status, message: value.message, value: null };
      }
      this.ctx.storage.sql.exec(
        `INSERT INTO idempotency_keys (
          actor_id, idempotency_key, request_hash, response_status,
          response_json, expires_at
        ) VALUES (?, ?, ?, 201, ?, ?)`,
        input.actor.id,
        input.idempotencyKey,
        input.requestHash,
        JSON.stringify(value),
        input.expiresAt,
      );
      return { kind: "created", status: 201, value };
    });
  }

  private ceiling(name: keyof Env, fallback: number): number {
    const raw = Number(this.env[name]);
    return Number.isFinite(raw) && raw >= 0 ? Math.trunc(raw) : fallback;
  }

  private canCreateProject(): boolean {
    const count = Number(
      this.ctx.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM projects").one().count,
    );
    const aliasCount = Number(
      this.ctx.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM project_aliases").one().count,
    );
    return count < this.ceiling("WORKSPACE_PROJECT_CEILING", 1_000)
      && aliasCount < this.ceiling("WORKSPACE_ALIAS_CEILING", 20_000);
  }

  private canAddAliases(aliases: string[]): boolean {
    const normalized = new Set(
      aliases.map(normalizeProjectAlias).filter(Boolean),
    );
    let additions = 0;
    for (const alias of normalized) {
      const exists = this.ctx.storage.sql
        .exec<{ present: number }>(
          "SELECT 1 AS present FROM project_aliases WHERE normalized_alias = ? LIMIT 1",
          alias,
        )
        .toArray()[0];
      if (!exists) additions += 1;
    }
    const count = Number(
      this.ctx.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM project_aliases").one().count,
    );
    return count + additions <= this.ceiling("WORKSPACE_ALIAS_CEILING", 20_000);
  }

  private canRecordProjectEvent(): boolean {
    const count = Number(
      this.ctx.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM project_events").one().count,
    );
    return count < this.ceiling("WORKSPACE_PROJECT_EVENT_CEILING", 10_000);
  }

  private ensureProject(rawName: string): ProjectRow {
    const existing = this.findProject(rawName);
    if (existing) return existing;
    const name = rawName.trim();
    const slugBase = slugifyProject(name);
    let slug = slugBase;
    let suffix = 2;
    while (
      this.ctx.storage.sql
        .exec<{ id: number }>("SELECT id FROM projects WHERE slug = ? COLLATE NOCASE", slug)
        .toArray().length
    ) {
      if (suffix > 999) {
        slug = `${slugBase}-${crypto.randomUUID().slice(0, 8)}`;
        break;
      }
      slug = `${slugBase}-${suffix++}`;
    }
    this.ctx.storage.sql.exec("INSERT INTO projects (name, slug) VALUES (?, ?)", name, slug);
    const id = Number(
      this.ctx.storage.sql.exec<{ id: number }>("SELECT last_insert_rowid() AS id").one().id,
    );
    this.addAlias(id, name);
    return this.projectRowById(id)!;
  }

  private addAlias(projectId: number, alias: string): LifecycleOutcome<void> {
    const cleaned = alias.trim();
    const normalized = normalizeProjectAlias(cleaned);
    if (!normalized) return;
    const owner = this.ctx.storage.sql
      .exec<{ project_id: number }>(
        "SELECT project_id FROM project_aliases WHERE normalized_alias = ? LIMIT 1",
        normalized,
      )
      .toArray()[0];
    if (owner && owner.project_id !== projectId) {
      return lifecycleError(
        409,
        `Project alias already belongs to another project: ${cleaned}`,
      );
    }
    if (!owner && !this.canAddAliases([cleaned])) {
      return lifecycleError(429, "Workspace alias limit reached");
    }
    this.ctx.storage.sql.exec(
      `INSERT OR IGNORE INTO project_aliases (alias, normalized_alias, project_id)
       VALUES (?, ?, ?)`,
      cleaned,
      normalized,
      projectId,
    );
  }

  private findProject(nameOrAlias: string): ProjectRow | null {
    const normalized = normalizeProjectAlias(nameOrAlias);
    const alias = this.ctx.storage.sql
      .exec<ProjectRow>(`
        SELECT p.id, p.name, p.slug, p.status
        FROM project_aliases a JOIN projects p ON p.id = a.project_id
        WHERE a.normalized_alias = ? LIMIT 1
      `, normalized)
      .toArray()[0];
    if (alias) return alias;
    return (
      this.ctx.storage.sql
        .exec<ProjectRow>(
          "SELECT id, name, slug, status FROM projects WHERE name = ? COLLATE NOCASE LIMIT 1",
          nameOrAlias,
        )
        .toArray()[0] ?? null
    );
  }

  private projectRowById(projectId: number): ProjectRow | null {
    return (
      this.ctx.storage.sql
        .exec<ProjectRow>(
          "SELECT id, name, slug, status FROM projects WHERE id = ? LIMIT 1",
          projectId,
        )
        .toArray()[0] ?? null
    );
  }

  private requireProject(nameOrAlias: string): LifecycleOutcome<ProjectRow> {
    const project = this.findProject(nameOrAlias);
    if (!project) return lifecycleError(404, `Project not found: ${nameOrAlias}`);
    return project;
  }

  private uniqueSlug(base: string, excludeProjectId: number): string {
    const slugBase = slugifyProject(base);
    let slug = slugBase;
    let suffix = 2;
    while (
      this.ctx.storage.sql
        .exec<{ id: number }>(
          "SELECT id FROM projects WHERE slug = ? COLLATE NOCASE AND id != ?",
          slug,
          excludeProjectId,
        )
        .toArray().length
    ) {
      if (suffix > 999) {
        slug = `${slugBase}-${crypto.randomUUID().slice(0, 8)}`;
        break;
      }
      slug = `${slugBase}-${suffix++}`;
    }
    return slug;
  }

  private recordProjectEvent(
    projectId: number,
    action: "rename" | "merge" | "archive" | "inactive" | "reactivate",
    detail: Record<string, unknown>,
    actor: WorkspaceActor,
  ): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO project_events (project_id, action, detail_json, actor_type, actor_id)
       VALUES (?, ?, ?, ?, ?)`,
      projectId,
      action,
      JSON.stringify(detail),
      actor.type,
      actor.id,
    );
  }

  private projectById(projectId: number): WorkspaceProject | null {
    const row = this.projectRowById(projectId);
    return row ? this.toProject(row) : null;
  }

  private toProject(row: ProjectRow): WorkspaceProject {
    const aliases = this.ctx.storage.sql
      .exec<{ alias: string }>(
        "SELECT alias FROM project_aliases WHERE project_id = ? ORDER BY lower(alias)",
        row.id,
      )
      .toArray()
      .map((alias) => alias.alias);
    return { ...row, aliases };
  }

  private entryById(entryId: number): WorkspaceEntry | null {
    const row = this.ctx.storage.sql
      .exec<EntryRow>(`${ENTRY_SELECT} WHERE e.id = ? LIMIT 1`, entryId)
      .toArray()[0];
    return row ? toEntry(row) : null;
  }
}

const ENTRY_SELECT = `
  SELECT e.id, e.type, e.raw_text, e.structured_json, e.title,
         p.name AS project, e.project_raw, e.tags_json, e.source,
         e.session_id, e.status, e.actor_type, e.actor_id, e.created_at,
         e.updated_at, e.closed_at, e.close_note
  FROM entries e LEFT JOIN projects p ON p.id = e.project_id`;

// Preserve the entry response shape without materializing structured payloads
// that daily summary generation neither renders nor needs.
const SUMMARY_ENTRY_SELECT = `
  SELECT e.id, e.type, e.raw_text, '{}' AS structured_json, e.title,
         p.name AS project, e.project_raw, e.tags_json, e.source,
         e.session_id, e.status, e.actor_type, e.actor_id, e.created_at,
         e.updated_at, e.closed_at, e.close_note
  FROM entries e LEFT JOIN projects p ON p.id = e.project_id`;

interface ProjectRow extends Record<string, SqlStorageValue> {
  id: number;
  name: string;
  slug: string;
  status: "active" | "archived";
}

interface MigrationProjectRow extends ProjectRow {
  created_at: string;
}

interface MigrationAliasRow extends Record<string, SqlStorageValue> {
  alias: string;
  project_id: number;
  created_at: string;
}

interface MigrationAliasCandidate {
  alias: string;
  projectId: number;
  createdAt: string;
}

interface EntryRow extends Record<string, SqlStorageValue> {
  id: number;
  type: WorkspaceEntryType;
  raw_text: string;
  structured_json: string;
  title: string | null;
  project: string | null;
  project_raw: string | null;
  tags_json: string;
  source: string;
  session_id: string | null;
  status: "open" | "closed";
  actor_type: string;
  actor_id: string;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  close_note: string | null;
}

function toEntry(row: EntryRow): WorkspaceEntry {
  return {
    id: row.id,
    type: row.type,
    text: row.raw_text,
    structuredJson: parseObject(row.structured_json),
    title: row.title,
    project: row.project,
    projectRaw: row.project_raw,
    tags: parseTags(row.tags_json),
    source: row.source,
    sessionId: row.session_id,
    status: row.status,
    actorType: row.actor_type,
    actorId: row.actor_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    closedAt: row.closed_at,
    closeNote: row.close_note,
  };
}

function parseObject(value: string): WorkspaceJsonObject {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as WorkspaceJsonObject)
      : {};
  } catch {
    return {};
  }
}

function parseTags(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((tag): tag is string => typeof tag === "string") : [];
  } catch {
    return [];
  }
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function truncateUtf8(
  value: string,
  ceiling: number,
  marker: string,
): { value: string; truncated: boolean } {
  const encoded = new TextEncoder().encode(value);
  if (encoded.byteLength <= ceiling) return { value, truncated: false };
  const markerBytes = new TextEncoder().encode(marker);
  const slice = encoded.slice(0, Math.max(0, ceiling - markerBytes.byteLength));
  return {
    value: `${new TextDecoder().decode(slice)}${marker}`,
    truncated: true,
  };
}

function takeJsonWithinBytes<T>(
  values: T[],
  ceiling: number,
): { values: T[]; truncated: boolean; bytes: number } {
  const selected: T[] = [];
  let bytes = 2;
  for (const value of values) {
    const itemBytes = utf8Bytes(JSON.stringify(value)) + (selected.length ? 1 : 0);
    if (bytes + itemBytes > ceiling) {
      return { values: selected, truncated: true, bytes };
    }
    selected.push(value);
    bytes += itemBytes;
  }
  return { values: selected, truncated: false, bytes };
}

function boundStatusProjection(
  projection: WorkspaceStatusProjection,
  ceiling: number,
): WorkspaceStatusProjection {
  const bounded: WorkspaceStatusProjection = {
    ...projection,
    activeRightNow: [],
    activeProjects: [],
    openLoops: [],
    recent: [],
  };
  let remaining = Math.max(0, ceiling - utf8Bytes(JSON.stringify(bounded)) - 256);
  const take = <T>(values: T[]): T[] => {
    const result = takeJsonWithinBytes(values, remaining);
    remaining = Math.max(0, remaining - result.bytes);
    if (result.truncated) bounded.truncated = true;
    return result.values;
  };
  bounded.activeRightNow = take(projection.activeRightNow);
  bounded.openLoops = take(projection.openLoops);
  bounded.recent = take(projection.recent);
  bounded.activeProjects = take(projection.activeProjects);
  return bounded;
}

function clampLimit(value: number | undefined, fallback: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value!), 1), max);
}

function normalizeProjectAlias(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_-]+/g, " ").replace(/\s+/g, " ");
}

function slugifyProject(value: string): string {
  return (
    normalizeProjectAlias(value)
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "project"
  );
}

function calendarDate(timestamp: string, timeZone: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date(timestamp));
    const value = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find((part) => part.type === type)?.value ?? "";
    return `${value("year")}-${value("month")}-${value("day")}`;
  } catch {
    return timestamp.slice(0, 10);
  }
}

function summaryBullets(entries: WorkspaceEntry[]): string {
  return entries
    .map((entry) => {
      const bits: string[] = [];
      if (entry.project) bits.push(`Project: ${entry.project} —`);
      if (entry.title) bits.push(`${entry.title}:`);
      bits.push(entry.text);
      if (entry.tags.length) bits.push(`(${entry.tags.map((tag) => `#${tag}`).join(" ")})`);
      return `- ${bits.join(" ")}`;
    })
    .join("\n");
}
