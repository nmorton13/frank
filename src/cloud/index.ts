import {
  bootstrapWorkspace,
  cleanupAbandonedWorkspaces,
  clearSessionCookie,
  consumeLoginToken,
  createShareToken,
  enforcePublicRequestLimit,
  listShareTokens,
  requireAgent,
  requireHuman,
  requireShareToken,
  requestClaimVerification,
  requestLoginLink,
  revokeAgentCredential,
  revokeHumanSession,
  revokeShareToken,
  sessionCookie,
  verifyClaim,
} from "./directory";
import {
  htmlEscape,
  htmlResponse,
  HttpError,
  jsonResponse,
  objectBody,
  readJson,
  requireSameOrigin,
  stringField,
  withSecurityHeaders,
} from "./http";
import { hashText } from "./tokens";
import {
  isWorkspaceEntryType,
  Workspace,
  type MutationResult,
  type WorkspaceEntry,
  type WorkspaceEntryType,
  type WorkspaceJsonObject,
  type WorkspaceStatusProjection,
} from "./workspace";

export { Workspace };

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

interface WorkspaceDirectoryRow {
  displayName: string | null;
  pageTitle: string | null;
  timeZone?: string | null;
}

function stringArrayField(
  body: Record<string, unknown>,
  name: string,
  options: { maxItems: number; maxLength: number },
): string[] {
  if (body[name] === undefined) return [];
  if (!Array.isArray(body[name]) || body[name].length > options.maxItems) {
    throw new HttpError(400, `${name} must be an array with at most ${options.maxItems} items`);
  }
  return body[name].map((item) => {
    if (typeof item !== "string" || !item.trim() || item.trim().length > options.maxLength) {
      throw new HttpError(
        400,
        `Each ${name.slice(0, -1)} must be a non-empty string up to ${options.maxLength} characters`,
      );
    }
    return item.trim();
  });
}

function tagsField(body: Record<string, unknown>): string[] {
  return stringArrayField(body, "tags", { maxItems: 20, maxLength: 64 });
}

function pathMatch(pathname: string, pattern: RegExp): RegExpMatchArray | null {
  return pathname.match(pattern);
}

function queryLimit(url: URL, fallback: number, max: number): number {
  const raw = url.searchParams.get("limit");
  if (raw === null) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new HttpError(400, `limit must be an integer from 1 to ${max}`);
  }
  return value;
}

function queryOffset(url: URL): number {
  const raw = url.searchParams.get("offset");
  if (raw === null) return 0;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 10_000) {
    throw new HttpError(400, "offset must be an integer from 0 to 10000");
  }
  return value;
}

function idempotencyKey(request: Request): string {
  const value = request.headers.get("idempotency-key")?.trim();
  if (!value || value.length > 200) {
    throw new HttpError(400, "A valid Idempotency-Key header is required");
  }
  return value;
}

async function projectMutation(
  env: Env,
  request: Request,
  workspaceId: string,
  operation: "rename" | "merge" | "archive" | "inactive",
  run: (input: {
    actor: { type: "agent"; id: string };
    idempotencyKey: string;
    requestHash: string;
    expiresAt: string;
    body: Record<string, unknown>;
  }) => Promise<MutationResult<unknown>>,
): Promise<Response> {
  const agent = await requireAgent(env, request, workspaceId, "write");
  const key = idempotencyKey(request);
  const body = objectBody(await readJson(request));
  const result = await run({
    actor: { type: "agent", id: agent.credentialId },
    idempotencyKey: key,
    // Include the operation name in the hash so archive and inactive (which can
    // share an identical body) never replay across different endpoints.
    requestHash: await hashText(JSON.stringify({ op: operation, body })),
    expiresAt: new Date(Date.now() + IDEMPOTENCY_TTL_MS).toISOString(),
    body,
  });
  if (result.kind === "error") {
    throw new HttpError(result.status, result.message);
  }
  if (result.kind === "created" && result.value !== null) {
    return jsonResponse({ project: result.value, replayed: false }, 201);
  }
  if (result.kind === "replayed" && result.value !== null) {
    return jsonResponse({ project: result.value, replayed: true }, 200);
  }
  throw new HttpError(409, "Idempotency key was already used for a different request");
}

function structuredJsonField(body: Record<string, unknown>): WorkspaceJsonObject {
  const value = body.structuredJson ?? body.structured_json;
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "structuredJson must be an object");
  }
  return value as WorkspaceJsonObject;
}

function previousDate(date: string): string {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() - 1);
  return value.toISOString().slice(0, 10);
}

function validCalendarDate(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const value = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(value.valueOf()) && value.toISOString().slice(0, 10) === date;
}

function calendarDate(timeZone: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date());
    const value = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find((part) => part.type === type)?.value ?? "";
    return `${value("year")}-${value("month")}-${value("day")}`;
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

async function workspaceTimeZone(env: Env, workspaceId: string): Promise<string> {
  const row = await env.DIRECTORY.prepare(
    "SELECT time_zone AS timeZone FROM workspaces WHERE id = ? AND state IN ('unclaimed', 'active')",
  )
    .bind(workspaceId)
    .first<{ timeZone: string | null }>();
  if (!row) throw new HttpError(404, "Workspace not found");
  return row.timeZone || "UTC";
}

async function handle(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname === "/health") {
    return jsonResponse({ ok: true, service: "frank-cloud" });
  }

  if (request.method === "GET" && (url.pathname === "/" || url.pathname === "")) {
    return htmlResponse(renderLandingPage());
  }

  if (request.method === "GET" && url.pathname === "/agent-setup") {
    return htmlResponse(renderAgentSetupPage());
  }

  // Host the portable agent skill and its helper so an agent can fetch them
  // directly instead of requiring a manual copy from the repository.
  const skillAsset = pathMatch(
    url.pathname,
    /^\/skills\/frank-cloud\/(SKILL\.md|frank-cloud-post\.sh)$/,
  );
  if (request.method === "GET" && skillAsset) {
    const asset = await env.ASSETS.fetch(
      new Request(new URL(`/skills/frank-cloud/${skillAsset[1]!}`, url)),
    );
    return withSecurityHeaders(
      new Response(asset.body, {
        status: asset.status,
        headers: {
          "cache-control": "public, max-age=3600",
          "content-type": skillAsset[1] === "SKILL.md" ? "text/markdown" : "text/x-shellscript",
        },
      }),
    );
  }

  const asset = pathMatch(
    url.pathname,
    /^\/assets\/(frank\.css|cloud-workspace\.js|cloud-claim\.js|cloud-login\.js|cloud-verify\.js)$/,
  );
  if (request.method === "GET" && asset) {
    const response = await env.ASSETS.fetch(new Request(new URL(`/${asset[1]!}`, url), request));
    return withSecurityHeaders(
      new Response(response.body, {
        status: response.status,
        headers: {
          // These scripts participate in authentication and private workspace
          // behavior. Revalidate every use so incompatible flow changes never
          // leave a cached client unable to redeem a current capability.
          "cache-control": "no-cache, must-revalidate",
          "content-type": response.headers.get("content-type") ?? "",
        },
      }),
    );
  }

  if (request.method === "POST" && url.pathname === "/v1/workspaces") {
    const body = objectBody(await readJson(request));
    const result = await bootstrapWorkspace(env, {
      request,
      displayName: stringField(body, "displayName", { max: 120 }),
      pageTitle: stringField(body, "pageTitle", { max: 160 }),
      timeZone: stringField(body, "timeZone", { max: 100 }),
      agentLabel: stringField(body, "agentLabel", { max: 120, required: true })!,
    });

    // Optional: deliver the claim link by email instead of requiring the human
    // to open the claim URL. Reuses the tested claim-verification flow; the
    // emailed link lets the human claim the workspace without visiting a page.
    // If the email send fails, the claim.url fallback below still works (the
    // claim token is only consumed on a successful send).
    const email = stringField(body, "email", { max: 254 });
    if (email) {
      ctx.waitUntil(
        requestClaimVerification(
          env,
          result.claim.token,
          email,
          String(env.APP_ORIGIN),
        ).catch((error) => {
          console.error("Bootstrap claim-email background send failed", error);
        }),
      );
    }

    return jsonResponse(
      {
        ...result,
        claim: {
          ...result.claim,
          url: `${String(env.APP_ORIGIN)}/claim#token=${encodeURIComponent(result.claim.token)}`,
          email: email ?? null,
        },
      },
      201,
    );
  }

  if (request.method === "POST" && url.pathname === "/v1/claims") {
    if (!(await enforcePublicRequestLimit(env, request, "claim"))) {
      throw new HttpError(429, "Claim request rate limit exceeded");
    }
    const body = objectBody(await readJson(request));
    await requestClaimVerification(
      env,
      stringField(body, "claimToken", { max: 256, required: true })!,
      stringField(body, "email", { max: 254, required: true })!,
      String(env.APP_ORIGIN),
    );
    return jsonResponse({ checkEmail: true }, 202);
  }

  if (request.method === "GET" && url.pathname === "/claim") {
    return htmlResponse(renderClaimPage());
  }

  if (request.method === "GET" && url.pathname === "/verify") {
    return htmlResponse(renderVerifyPage());
  }

  if (request.method === "POST" && url.pathname === "/v1/claim-sessions") {
    if (!(await enforcePublicRequestLimit(env, request, "claim"))) {
      throw new HttpError(429, "Claim request rate limit exceeded");
    }
    const body = objectBody(await readJson(request));
    const result = await verifyClaim(
      env,
      stringField(body, "verificationToken", { max: 256, required: true })!,
    );
    const response = jsonResponse({ workspaceId: result.session.workspaceId });
    response.headers.set("set-cookie", sessionCookie(result.sessionToken));
    return response;
  }

  if (request.method === "POST" && url.pathname === "/v1/login-links") {
    if (!(await enforcePublicRequestLimit(env, request, "login"))) {
      return jsonResponse({ checkEmail: true }, 202);
    }
    const body = objectBody(await readJson(request));
    const email = stringField(body, "email", { max: 254, required: true })!;
    ctx.waitUntil(
      requestLoginLink(env, email, String(env.APP_ORIGIN)).catch((error) => {
        console.error("Login-link background workflow failed", error);
      }),
    );
    return jsonResponse({ checkEmail: true }, 202);
  }

  if (request.method === "GET" && url.pathname === "/login") {
    return htmlResponse(renderLoginPage());
  }

  if (request.method === "POST" && url.pathname === "/v1/login-sessions") {
    if (!(await enforcePublicRequestLimit(env, request, "login"))) {
      throw new HttpError(429, "Sign-in request rate limit exceeded");
    }
    const body = objectBody(await readJson(request));
    const result = await consumeLoginToken(
      env,
      stringField(body, "loginToken", { max: 256, required: true })!,
    );
    const response = jsonResponse({ workspaceId: result.session.workspaceId });
    response.headers.set("set-cookie", sessionCookie(result.sessionToken));
    return response;
  }

  if (request.method === "POST" && url.pathname === "/v1/logout") {
    requireSameOrigin(request, String(env.APP_ORIGIN));
    await revokeHumanSession(env, request);
    const response = jsonResponse({ loggedOut: true });
    response.headers.set("set-cookie", clearSessionCookie());
    return response;
  }

  const entryCollection = pathMatch(url.pathname, /^\/v1\/workspaces\/([^/]+)\/entries$/);
  if (entryCollection) {
    const workspaceId = decodeURIComponent(entryCollection[1]!);
    if (request.method === "POST") {
      const agent = await requireAgent(env, request, workspaceId, "write");
      const key = idempotencyKey(request);
      const body = objectBody(await readJson(request));
      const rawType = stringField(body, "type", { max: 20, required: true })!;
      if (!isWorkspaceEntryType(rawType)) {
        throw new HttpError(400, `Invalid entry type: ${rawType}`);
      }
      const type = rawType;
      const entryInput = {
        type,
        text: stringField(body, "text", { max: 10_000, required: true })!,
        structuredJson: structuredJsonField(body),
        title: stringField(body, "title", { max: 240 }),
        project: stringField(body, "project", { max: 160 }),
        tags: tagsField(body),
        source: stringField(body, "source", { max: 240, required: true })!,
        sessionId: stringField(body, "sessionId", { max: 240 }),
      };
      const legacyTodoPayload = {
        type,
        text: entryInput.text,
        title: entryInput.title,
        project: entryInput.project,
        tags: entryInput.tags,
        source: entryInput.source,
      };
      const usesLegacyTodoHash =
        type === "todo" &&
        Object.keys(entryInput.structuredJson).length === 0 &&
        entryInput.sessionId === undefined;
      const requestHash = await hashText(
        JSON.stringify(usesLegacyTodoHash ? legacyTodoPayload : entryInput),
      );
      const result = await env.WORKSPACES.getByName(workspaceId).createEntry({
        ...entryInput,
        actor: { type: "agent", id: agent.credentialId },
        idempotencyKey: key,
        requestHash,
        expiresAt: new Date(Date.now() + IDEMPOTENCY_TTL_MS).toISOString(),
      });
      if (result.kind === "created" && result.value !== null) {
        return jsonResponse({ entry: result.value, replayed: false }, 201);
      }
      if (result.kind === "replayed" && result.value !== null) {
        return jsonResponse({ entry: result.value, replayed: true }, 200);
      }
      if (result.kind === "error") throw new HttpError(result.status, result.message);
      throw new HttpError(409, "Idempotency key was already used for a different request");
    }
    if (request.method === "GET") {
      await requireAgent(env, request, workspaceId, "read");
      const rawType = url.searchParams.get("type") ?? undefined;
      let type: WorkspaceEntryType | undefined;
      if (rawType) {
        if (!isWorkspaceEntryType(rawType)) {
          throw new HttpError(400, `Invalid entry type: ${rawType}`);
        }
        type = rawType;
      }
      const rawStatus = url.searchParams.get("status") ?? undefined;
      if (rawStatus && rawStatus !== "open" && rawStatus !== "closed") {
        throw new HttpError(400, "status must be open or closed");
      }
      const page = await env.WORKSPACES.getByName(workspaceId).listEntriesPage({
        type,
        project: url.searchParams.get("project") ?? undefined,
        status: rawStatus as "open" | "closed" | undefined,
        limit: queryLimit(url, 100, 100),
      });
      return jsonResponse(page);
    }
  }

  const projectCollection = pathMatch(url.pathname, /^\/v1\/workspaces\/([^/]+)\/projects$/);
  if (projectCollection) {
    const workspaceId = decodeURIComponent(projectCollection[1]!);
    if (request.method === "POST") {
      const agent = await requireAgent(env, request, workspaceId, "write");
      const key = idempotencyKey(request);
      const body = objectBody(await readJson(request));
      const projectInput = {
        name: stringField(body, "name", { max: 160, required: true })!,
        aliases: stringArrayField(body, "aliases", { maxItems: 20, maxLength: 160 }),
      };
      const requestHash = await hashText(JSON.stringify(projectInput));
      const result = await env.WORKSPACES.getByName(workspaceId).createProject({
        ...projectInput,
        actor: { type: "agent", id: agent.credentialId },
        idempotencyKey: key,
        requestHash,
        expiresAt: new Date(Date.now() + IDEMPOTENCY_TTL_MS).toISOString(),
      });
      if (result.kind === "created" && result.value !== null) {
        return jsonResponse({ project: result.value, replayed: false }, 201);
      }
      if (result.kind === "replayed" && result.value !== null) {
        return jsonResponse({ project: result.value, replayed: true }, 200);
      }
      if (result.kind === "error") throw new HttpError(result.status, result.message);
      throw new HttpError(409, "Idempotency key was already used for a different request");
    }
    if (request.method === "GET") {
      await requireAgent(env, request, workspaceId, "read");
      const includeArchived = ["1", "true"].includes(url.searchParams.get("all") ?? "");
      const limit = queryLimit(url, 100, 200);
      const offset = queryOffset(url);
      const projects = await env.WORKSPACES.getByName(workspaceId).listProjects(
        includeArchived,
        limit,
        offset,
      );
      return jsonResponse({ projects });
    }
  }

  const projectRenameRoute = pathMatch(
    url.pathname,
    /^\/v1\/workspaces\/([^/]+)\/projects\/rename$/,
  );
  if (request.method === "POST" && projectRenameRoute) {
    const workspaceId = decodeURIComponent(projectRenameRoute[1]!);
    return projectMutation(env, request, workspaceId, "rename", (input) =>
      env.WORKSPACES.getByName(workspaceId).renameProject({
        ...input,
        nameOrAlias: stringField(input.body, "nameOrAlias", { max: 160, required: true })!,
        newName: stringField(input.body, "newName", { max: 160, required: true })!,
      }),
    );
  }

  const projectMergeRoute = pathMatch(
    url.pathname,
    /^\/v1\/workspaces\/([^/]+)\/projects\/merge$/,
  );
  if (request.method === "POST" && projectMergeRoute) {
    const workspaceId = decodeURIComponent(projectMergeRoute[1]!);
    return projectMutation(env, request, workspaceId, "merge", (input) =>
      env.WORKSPACES.getByName(workspaceId).mergeProjects({
        ...input,
        fromNameOrAlias: stringField(input.body, "fromNameOrAlias", { max: 160, required: true })!,
        toNameOrAlias: stringField(input.body, "toNameOrAlias", { max: 160, required: true })!,
      }),
    );
  }

  const projectArchiveRoute = pathMatch(
    url.pathname,
    /^\/v1\/workspaces\/([^/]+)\/projects\/archive$/,
  );
  if (request.method === "POST" && projectArchiveRoute) {
    const workspaceId = decodeURIComponent(projectArchiveRoute[1]!);
    return projectMutation(env, request, workspaceId, "archive", (input) =>
      env.WORKSPACES.getByName(workspaceId).archiveProject({
        ...input,
        nameOrAlias: stringField(input.body, "nameOrAlias", { max: 160, required: true })!,
      }),
    );
  }

  const projectInactiveRoute = pathMatch(
    url.pathname,
    /^\/v1\/workspaces\/([^/]+)\/projects\/inactive$/,
  );
  if (request.method === "POST" && projectInactiveRoute) {
    const workspaceId = decodeURIComponent(projectInactiveRoute[1]!);
    return projectMutation(env, request, workspaceId, "inactive", (input) =>
      env.WORKSPACES.getByName(workspaceId).inactiveProject({
        ...input,
        nameOrAlias: stringField(input.body, "nameOrAlias", { max: 160, required: true })!,
      }),
    );
  }

  const openRoute = pathMatch(url.pathname, /^\/v1\/workspaces\/([^/]+)\/open$/);
  if (request.method === "GET" && openRoute) {
    const workspaceId = decodeURIComponent(openRoute[1]!);
    await requireAgent(env, request, workspaceId, "read");
    return jsonResponse(
      await env.WORKSPACES.getByName(workspaceId).listOpenLoopsPage(100),
    );
  }

  const statusRoute = pathMatch(url.pathname, /^\/v1\/workspaces\/([^/]+)\/status$/);
  if (request.method === "GET" && statusRoute) {
    const workspaceId = decodeURIComponent(statusRoute[1]!);
    await requireAgent(env, request, workspaceId, "read");
    return jsonResponse(await env.WORKSPACES.getByName(workspaceId).getStatusProjection());
  }

  const projectHistoryRoute = pathMatch(
    url.pathname,
    /^\/v1\/workspaces\/([^/]+)\/projects\/([^/]+)\/entries$/,
  );
  if (request.method === "GET" && projectHistoryRoute) {
    const workspaceId = decodeURIComponent(projectHistoryRoute[1]!);
    await requireAgent(env, request, workspaceId, "read");
    const project = decodeURIComponent(projectHistoryRoute[2]!);
    const history = await env.WORKSPACES.getByName(workspaceId).getProjectHistory(
      project,
      queryLimit(url, 50, 100),
    );
    return jsonResponse(history);
  }

  const summaryRoute = pathMatch(url.pathname, /^\/v1\/workspaces\/([^/]+)\/summary$/);
  if (request.method === "GET" && summaryRoute) {
    const workspaceId = decodeURIComponent(summaryRoute[1]!);
    await requireAgent(env, request, workspaceId, "read");
    const timeZone = await workspaceTimeZone(env, workspaceId);
    const requestedDate = url.searchParams.get("date") || "today";
    const today = calendarDate(timeZone);
    const date =
      requestedDate === "today"
        ? today
        : requestedDate === "yesterday"
          ? previousDate(today)
          : requestedDate;
    if (!validCalendarDate(date)) {
      throw new HttpError(400, "date must be today, yesterday, or YYYY-MM-DD");
    }
    return jsonResponse(
      await env.WORKSPACES.getByName(workspaceId).buildDailySummary(date, timeZone),
    );
  }

  const closeEntry = pathMatch(
    url.pathname,
    /^\/v1\/workspaces\/([^/]+)\/entries\/(\d+)\/close$/,
  );
  if (request.method === "PATCH" && closeEntry) {
    const workspaceId = decodeURIComponent(closeEntry[1]!);
    const entryId = Number(closeEntry[2]!);
    const authorization = request.headers.get("authorization");
    // Agents close via a workspace-scoped bearer token (no browser origin).
    // Humans close via a same-origin browser session cookie.
    if (authorization?.toLowerCase().startsWith("bearer ")) {
      const agent = await requireAgent(env, request, workspaceId, "write");
      const entry = await env.WORKSPACES.getByName(workspaceId).closeEntry(entryId, {
        type: "agent",
        id: agent.credentialId,
      });
      if (!entry) throw new HttpError(404, "Open loop not found");
      return jsonResponse({ entry });
    }
    requireSameOrigin(request, String(env.APP_ORIGIN));
    const human = await requireHuman(env, request, workspaceId);
    const entry = await env.WORKSPACES.getByName(workspaceId).closeEntry(entryId, {
      type: "human",
      id: human.userId,
    });
    if (!entry) throw new HttpError(404, "Open loop not found");
    return jsonResponse({ entry });
  }

  const credentialRoute = pathMatch(
    url.pathname,
    /^\/v1\/workspaces\/([^/]+)\/agent-credentials\/([^/]+)\/revoke$/,
  );
  if (request.method === "POST" && credentialRoute) {
    requireSameOrigin(request, String(env.APP_ORIGIN));
    const workspaceId = decodeURIComponent(credentialRoute[1]!);
    await requireHuman(env, request, workspaceId);
    await revokeAgentCredential(env, workspaceId, decodeURIComponent(credentialRoute[2]!));
    return jsonResponse({ revoked: true });
  }

  const exportRoute = pathMatch(url.pathname, /^\/v1\/workspaces\/([^/]+)\/export$/);
  if (request.method === "GET" && exportRoute) {
    const workspaceId = decodeURIComponent(exportRoute[1]!);
    // Full untruncated portable dump. The plain (no ?full=1) export stays the
    // capped human dashboard export; ?full=1 is available to an agent bearer
    // (read scope) or the workspace owner's human session for re-ingest.
    if (url.searchParams.get("full") === "1") {
      // Full portable dump: available to an agent bearer (read scope) or the
      // workspace owner's human session. The dashboard export button uses the
      // human session; agents use their bearer token.
      if (request.headers.get("authorization")) {
        await requireAgent(env, request, workspaceId, "read");
      } else {
        await requireHuman(env, request, workspaceId);
      }
      const data = JSON.parse(
        await env.WORKSPACES.getByName(workspaceId).exportDataFull(),
      ) as Record<string, unknown>;
      return jsonResponse({ workspaceId, ...data });
    }
    await requireHuman(env, request, workspaceId);
    const data = JSON.parse(
      await env.WORKSPACES.getByName(workspaceId).exportData(),
    ) as Record<string, unknown>;
    return jsonResponse({ workspaceId, ...data });
  }

  const workspacePage = pathMatch(url.pathname, /^\/w\/([^/]+)$/);
  if (request.method === "GET" && workspacePage) {
    const workspaceId = decodeURIComponent(workspacePage[1]!);
    await requireHuman(env, request, workspaceId);
    const directory = await env.DIRECTORY.prepare(`
      SELECT display_name AS displayName, page_title AS pageTitle
      FROM workspaces WHERE id = ? AND state = 'active'
    `)
      .bind(workspaceId)
      .first<WorkspaceDirectoryRow>();
    if (!directory) throw new HttpError(404, "Workspace not found");
    // The private owner dashboard is the completion interface, so it must show
    // every open loop — not the 8-loop status cap used by the agent-facing route.
    const projection = await env.WORKSPACES.getByName(workspaceId).getStatusProjection({
      allOpenLoops: true,
    });
    return htmlResponse(renderWorkspace(workspaceId, directory, projection));
  }

  // Human-scoped status JSON for the dashboard's auto-refresh. Same-origin and
  // human-authenticated (read-only), so it is safe to poll from the browser.
  const workspaceStatusJson = pathMatch(url.pathname, /^\/w\/([^/]+)\/status$/);
  if (request.method === "GET" && workspaceStatusJson) {
    const workspaceId = decodeURIComponent(workspaceStatusJson[1]!);
    await requireHuman(env, request, workspaceId);
    const projection = await env.WORKSPACES.getByName(workspaceId).getStatusProjection({
      allOpenLoops: true,
    });
    return jsonResponse(projection);
  }

  const projectHistoryPage = pathMatch(
    url.pathname,
    /^\/w\/([^/]+)\/projects\/([^/]+)\/entries$/,
  );
  if (request.method === "GET" && projectHistoryPage) {
    const workspaceId = decodeURIComponent(projectHistoryPage[1]!);
    await requireHuman(env, request, workspaceId);
    const project = decodeURIComponent(projectHistoryPage[2]!);
    const history = await env.WORKSPACES.getByName(workspaceId).getProjectHistory(
      project,
      queryLimit(url, 50, 100),
    );
    return jsonResponse(history);
  }

  // --- Read-only dashboard share links ---
  // The owner creates a share token (returned once), shares the link, and can
  // revoke it later. A share token authorizes ONLY read-only dashboard routes;
  // it can never close loops, revoke credentials, or export data.

  // Create a share token (owner-only).
  const shareCreate = pathMatch(url.pathname, /^\/v1\/workspaces\/([^/]+)\/share$/);
  if (request.method === "POST" && shareCreate) {
    requireSameOrigin(request, String(env.APP_ORIGIN));
    const workspaceId = decodeURIComponent(shareCreate[1]!);
    await requireHuman(env, request, workspaceId);
    const share = await createShareToken(env, workspaceId);
    return jsonResponse({
      share: {
        id: share.id,
        prefix: share.prefix,
        expiresAt: share.expiresAt,
        url: `${String(env.APP_ORIGIN)}/s/${encodeURIComponent(share.token)}`,
      },
    });
  }

  // List active share tokens (owner-only).
  const shareList = pathMatch(url.pathname, /^\/v1\/workspaces\/([^/]+)\/share$/);
  if (request.method === "GET" && shareList) {
    const workspaceId = decodeURIComponent(shareList[1]!);
    await requireHuman(env, request, workspaceId);
    const tokens = await listShareTokens(env, workspaceId);
    return jsonResponse({ tokens });
  }

  // Revoke a share token (owner-only).
  const shareRevoke = pathMatch(
    url.pathname,
    /^\/v1\/workspaces\/([^/]+)\/share\/([^/]+)\/revoke$/,
  );
  if (request.method === "POST" && shareRevoke) {
    requireSameOrigin(request, String(env.APP_ORIGIN));
    const workspaceId = decodeURIComponent(shareRevoke[1]!);
    await requireHuman(env, request, workspaceId);
    const revoked = await revokeShareToken(
      env,
      workspaceId,
      decodeURIComponent(shareRevoke[2]!),
    );
    if (revoked === 0) throw new HttpError(404, "Share token not found or already revoked");
    return jsonResponse({ revoked: true });
  }

  // Read-only shared dashboard view (share-token authenticated).
  const shareView = pathMatch(url.pathname, /^\/s\/([^/]+)$/);
  if (request.method === "GET" && shareView) {
    const { workspaceId } = await requireShareToken(
      env,
      decodeURIComponent(shareView[1]!),
    );
    const directory = await env.DIRECTORY.prepare(`
      SELECT display_name AS displayName, page_title AS pageTitle
      FROM workspaces WHERE id = ? AND state = 'active'
    `)
      .bind(workspaceId)
      .first<WorkspaceDirectoryRow>();
    if (!directory) throw new HttpError(404, "Workspace not found");
    const projection = await env.WORKSPACES.getByName(workspaceId).getStatusProjection({
      allOpenLoops: true,
    });
    return htmlResponse(renderSharedWorkspace(workspaceId, directory, projection));
  }

  return jsonResponse({ error: "Not found" }, 404);
}

function renderLandingPage(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Frank — a work log for you and your agents</title>
    <link rel="stylesheet" href="/assets/frank.css">
  </head>
  <body class="admin-page cloud-workspace claim-workspace">
    <main class="admin-shell">
      <header class="admin-header">
        <p class="eyebrow">Frank</p>
        <h1>A work log for you and your agents.</h1>
        <p>Frank is a small, agent-first work log. Your agents write notes, todos, blockers, and status updates; you review them on a private dashboard and check off open loops when they are done.</p>
      </header>
      <section class="admin-card">
        <h2>What you get</h2>
        <ul>
          <li><strong>Agents log, you review.</strong> Your coding agent records what it did — notes, todos, blockers, decisions, sessions — as it works.</li>
          <li><strong>One private dashboard.</strong> Every workspace is isolated; your credentials never reach another workspace.</li>
          <li><strong>You close the loops — or your agents do.</strong> Agents can open a todo or flag a blocker, and any agent credential can close an open loop. You can also check off anything from the dashboard.</li>
        </ul>
      </section>
      <section class="admin-card">
        <h2>Get started</h2>
        <p>Tell your agent:</p>
        <pre><code>Read @url:\`https://frankagent.dev/skills/frank-cloud/SKILL.md\` and set up Frank for me.</code></pre>
        <p>The agent reads the hosted skill, bootstraps an unclaimed workspace by calling the public API, and gives you a claim URL. You enter your email to claim the private dashboard.</p>
        <p>Once it is set up, just tell your agent what to log and which project it belongs to:</p>
        <ul>
          <li>Log to Frank under the <strong>dragon-ranch</strong> project: I'm teaching the wyverns to fetch.</li>
          <li>Add a Frank todo to the <strong>pizza-quest</strong> project: find the perfect crust recipe.</li>
          <li>Log a blocker to Frank under <strong>spaceship</strong>: waiting on the warp core before we can test the jump.</li>
          <li>Record a Frank decision in the <strong>garden</strong> project: we're going with heirloom tomatoes over hybrids because they taste better.</li>
          <li>Write a Frank session summary for today's work on the <strong>robot-butler</strong> project.</li>
        </ul>
        <p><a href="/login">Sign in →</a> open your claimed workspace dashboard.</p>
        <p><a href="/health">Health →</a> check service status.</p>
      </section>
    </main>
  </body>
</html>`;
}

function renderAgentSetupPage(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Frank agent setup</title>
    <link rel="stylesheet" href="/assets/frank.css">
  </head>
  <body class="admin-page cloud-workspace claim-workspace">
    <main class="admin-shell">
      <header class="admin-header">
        <p class="eyebrow">Frank / agent setup</p>
        <h1>Connect an agent to Frank.</h1>
        <p>Frank Cloud is an agent-first work log. To let an agent (Claude Code, Codex, Cursor, Hermes, ...) write to your workspace, install the portable skill below.</p>
      </header>
      <section class="admin-card">
        <h2>Tell your agent</h2>
        <pre><code>Read @url:\`https://frankagent.dev/skills/frank-cloud/SKILL.md\` and set up Frank for me.</code></pre>
        <p>The agent reads the hosted skill, bootstraps an unclaimed workspace via the public API, stores its credential, and gives you a claim URL. Then:</p>
        <ol>
          <li>The agent will ask for a workspace label and timezone (defaults are fine).</li>
          <li>The agent stores its credential and gives you a claim URL.</li>
          <li>Open the claim URL, enter your email, and claim the private dashboard.</li>
          <li>Set the three environment variables the skill uses.</li>
          <li>Run <code>/path/to/frank-cloud-post.sh remote-check</code> to confirm connectivity.</li>
        </ol>
        <h2>Manual setup</h2>
        <p>Fetch the guide and helper from this Worker, or copy them from your repository:</p>
        <ul>
          <li><a href="/skills/frank-cloud/SKILL.md">/skills/frank-cloud/SKILL.md</a></li>
          <li><a href="/skills/frank-cloud/frank-cloud-post.sh">/skills/frank-cloud/frank-cloud-post.sh</a></li>
        </ul>
        <h2>Three environment variables</h2>
        <p>The skill needs three values, created when a workspace is bootstrapped:</p>
        <pre><code>FRANK_CLOUD_BASE   # your deployment origin
FRANK_CLOUD_WS     # workspace id (wsp_...)
FRANK_CLOUD_TOKEN  # agent credential (frank_agent_...)</code></pre>
        <p>Store the agent credential securely — it is returned only once at bootstrap.</p>
        <h2>Verify the connection</h2>
        <p>Run the helper’s connectivity check before writing anything:</p>
        <pre><code>/path/to/frank-cloud-post.sh remote-check</code></pre>
      </section>
    </main>
  </body>
</html>`;
}

function renderClaimPage(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Claim your Frank workspace</title>
    <link rel="stylesheet" href="/assets/frank.css">
  </head>
  <body class="admin-page cloud-workspace claim-workspace">
    <main class="admin-shell">
      <header class="admin-header">
        <p class="eyebrow">Frank / workspace claim</p>
        <h1>Make it yours.</h1>
        <p>Your agent created this workspace. Add your email to claim the private human view.</p>
      </header>
      <section class="admin-card">
        <form id="claim-form">
          <label for="claim-email">Email</label>
          <input id="claim-email" name="email" type="email" autocomplete="email" required maxlength="254">
          <button type="submit">Claim workspace</button>
          <p id="claim-error" role="alert" hidden></p>
        </form>
        <p class="security-note">This claim link is single-use and expires after 30 minutes. Use it promptly and do not share it — it grants temporary ownership of this workspace.</p>
      </section>
    </main>
    <script src="/assets/cloud-claim.js" defer></script>
  </body>
</html>`;
}

function renderVerifyPage(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Verify your Frank workspace</title>
    <link rel="stylesheet" href="/assets/frank.css">
  </head>
  <body class="admin-page cloud-workspace claim-workspace">
    <main class="admin-shell">
      <section class="admin-card">
        <h1>Verifying your workspace…</h1>
        <p id="verify-message" role="status">Please wait.</p>
      </section>
    </main>
    <script src="/assets/cloud-verify.js" defer></script>
  </body>
</html>`;
}

function renderLoginPage(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Sign in to Frank</title>
    <link rel="stylesheet" href="/assets/frank.css">
  </head>
  <body class="admin-page cloud-workspace claim-workspace">
    <main class="admin-shell">
      <header class="admin-header">
        <p class="eyebrow">Frank / sign in</p>
        <h1>Come back in.</h1>
        <p>Enter your verified email and Frank will send a one-time link to your private workspace.</p>
      </header>
      <section class="admin-card">
        <form id="login-form">
          <label for="login-email">Email</label>
          <input id="login-email" name="email" type="email" autocomplete="email" required maxlength="254">
          <button type="submit">Send sign-in link</button>
          <p id="login-message" role="status" hidden></p>
        </form>
        <p class="security-note">The emailed link is single-use and expires after 20 minutes. Do not share or forward it — whoever redeems it first gets a browser session for this workspace. Each browser or profile signs in separately.</p>
      </section>
    </main>
    <script src="/assets/cloud-login.js" defer></script>
  </body>
</html>`;
}

function renderWorkspace(
  workspaceId: string,
  directory: WorkspaceDirectoryRow,
  projection: WorkspaceStatusProjection,
): string {
  const title = directory.pageTitle || directory.displayName || "Frank";

  // Group open loops by project, then by type, with collapsible sections —
  // matching the local dashboard. Each loop keeps its completion checkbox.
  function groupOpenLoops(entries: WorkspaceEntry[]): string {
    if (!entries.length) return '<li class="empty-state">No open loops. The page is clear.</li>';
    const byProject = new Map<string, WorkspaceEntry[]>();
    for (const entry of entries) {
      const name = entry.project || "Unassigned";
      if (!byProject.has(name)) byProject.set(name, []);
      byProject.get(name)!.push(entry);
    }
    return Array.from(byProject.entries())
      .map(([project, rows]) => {
        const byType = new Map<string, WorkspaceEntry[]>();
        for (const entry of rows) {
          if (!byType.has(entry.type)) byType.set(entry.type, []);
          byType.get(entry.type)!.push(entry);
        }
        const sections = Array.from(byType.entries())
          .map(
            ([type, typeRows]) => `
              <details class="loop-type" open>
                <summary><span class="check">›</span>${htmlEscape(type)} (${typeRows.length})</summary>
                <ul class="loop-bullets">
                  ${typeRows
                    .map(
                      (entry) => `
                    <li class="loop-item" data-entry-id="${entry.id}">
                      <label class="loop-check">
                        <input type="checkbox" aria-label="Mark ${htmlEscape(entry.type)} complete">
                        <span class="loop-box" aria-hidden="true"></span>
                      </label>
                      <div class="loop-copy">
                        ${entry.title ? `<strong>${htmlEscape(entry.title)}</strong>` : ""}
                        <p>${htmlEscape(entry.text)}</p>
                      </div>
                    </li>`,
                    )
                    .join("")}
                </ul>
              </details>`,
          )
          .join("");
        return `
          <li class="loop-project">
            <div class="item-title"><span class="check">□</span>${htmlEscape(project)}</div>
            ${sections}
          </li>`;
      })
      .join("");
  }

  const openLoops = groupOpenLoops(projection.openLoops);

  // The headline card shows only the single, manually-set `status` entry.
  // Active-right-now work is deliberately not merged into the headline.
  const currentStatus = projection.active
    ? `
        <div class="current-status-item">
          <div class="status-lines"><p class="active">${htmlEscape(
            projection.active.title
              ? `${projection.active.title}: ${projection.active.text}`
              : projection.active.text,
          )}</p></div>
          <div class="meta">
            ${projection.active.project ? `<span>Project: ${htmlEscape(projection.active.project)}</span>` : ""}
            <span class="badge">status</span>
          </div>
        </div>`
    : '<p class="empty">No status set yet.</p>';

  const activeProjects = projection.activeProjects.length
    ? projection.activeProjects
        .map(
          (project) => `
            <li>
              <div class="item-title"><span class="check">✓</span>
                <button class="project-button" data-project="${htmlEscape(project.name)}">${htmlEscape(
                  project.name,
                )}</button>
              </div>
              <div class="item-text">${htmlEscape(
                `${project.count} recent update${project.count === 1 ? "" : "s"} · latest: ${project.lastType}`,
              )}</div>
            </li>`,
        )
        .join("")
    : '<li class="empty">No active projects captured.</li>';

  const recent = projection.recent.length
    ? projection.recent
        .map(
          (entry) => `
            <li>
              <div class="item-title"><span class="check">›</span>${htmlEscape(
                [entry.project ? `Project: ${entry.project}` : "", entry.type]
                  .filter(Boolean)
                  .join(" · "),
              )}</div>
              <div class="item-text">${htmlEscape(
                entry.title ? `${entry.title}: ${entry.text}` : entry.text,
              )}</div>
            </li>`,
        )
        .join("")
    : '<li class="empty">No recent Frank activity.</li>';

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${htmlEscape(title)}</title>
    <link rel="stylesheet" href="/assets/frank.css">
  </head>
  <body class="admin-page cloud-workspace dashboard" data-workspace-id="${htmlEscape(
    workspaceId,
  )}">
    <div class="wrap">
      <header class="header">
        <div class="brand">
          <div class="logo" aria-hidden="true"><svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M14 26h36"/><path d="M22 25c1-8 4-13 10-13s9 5 10 13"/><path d="M18 36c4-3 9-3 14 0 5-3 10-3 14 0"/><circle cx="24" cy="36" r="6"/><circle cx="40" cy="36" r="6"/><path d="M30 36h4"/><path d="M21 49c7 4 15 4 22 0"/></svg></div>
          <div>
            <div class="kicker">Frank / workspace</div>
            <h1>${htmlEscape(title)}</h1>
            <p class="sub">Review what your agents have recorded. Check off a todo or blocker when it is done.</p>
          </div>
        </div>
        <div class="header-actions">
          <div class="pill" id="updated">Loading…</div>
          <button type="button" id="export-button" class="share-button">Export</button>
          <button type="button" id="share-button" class="share-button">Share</button>
          <button type="button" id="logout-button" class="logout-button">Sign out</button>
        </div>
      </header>
      <main class="grid">
        <div class="column">
          <section class="card" aria-labelledby="status-heading">
            <h2 id="status-heading">Current status</h2>
            <div class="current-statuses" id="currentStatuses">${currentStatus}</div>
          </section>
          <section class="card" aria-labelledby="loops-heading">
            <div class="section-heading"><h2 id="loops-heading">Open loops</h2><span data-open-count>${projection.openLoops.length} open</span></div>
            <ul class="open-loop-list" data-open-loop-list>${openLoops}</ul>
          </section>
        </div>
        <div class="column">
          <section class="card" aria-labelledby="projects-heading">
            <h2 id="projects-heading">Active projects</h2>
            <ul id="activeProjects">${activeProjects}</ul>
          </section>
          <section class="card" aria-labelledby="recent-heading">
            <h2 id="recent-heading">Recent log</h2>
            <ul id="recent">${recent}</ul>
          </section>
        </div>
      </main>
      <div class="footer"><span><a href="/skills/frank-cloud/SKILL.md" class="skill-link">Frank agent skill</a> · Auto-refreshes every 30 seconds</span></div>
    </div>
    <div class="drawer-backdrop" id="drawerBackdrop" hidden></div>
    <aside
      class="project-drawer"
      id="projectDrawer"
      role="dialog"
      aria-modal="true"
      aria-label="Project history"
      aria-hidden="true"
      inert
    >
      <div id="drawerContent"></div>
    </aside>
    <div class="drawer-backdrop" id="shareBackdrop" hidden></div>
    <aside
      class="project-drawer share-drawer"
      id="shareDrawer"
      role="dialog"
      aria-modal="true"
      aria-label="Share this workspace"
      aria-hidden="true"
      inert
    >
      <div id="shareContent"></div>
    </aside>
    <script src="/assets/cloud-workspace.js" defer></script>
  </body>
</html>`;
}

/**
 * Read-only shared dashboard view. Rendered for a valid share token. It shows
 * the same status projection as the owner dashboard but deliberately omits all
 * interactive controls: no completion checkboxes, no logout, no auto-refresh,
 * no project drawer. A share link can never close a loop or change data.
 */
function renderSharedWorkspace(
  workspaceId: string,
  directory: WorkspaceDirectoryRow,
  projection: WorkspaceStatusProjection,
): string {
  const title = directory.pageTitle || directory.displayName || "Frank";

  function groupOpenLoops(entries: WorkspaceEntry[]): string {
    if (!entries.length) return '<li class="empty-state">No open loops. The page is clear.</li>';
    const byProject = new Map<string, WorkspaceEntry[]>();
    for (const entry of entries) {
      const name = entry.project || "Unassigned";
      if (!byProject.has(name)) byProject.set(name, []);
      byProject.get(name)!.push(entry);
    }
    return Array.from(byProject.entries())
      .map(([project, rows]) => {
        const byType = new Map<string, WorkspaceEntry[]>();
        for (const entry of rows) {
          if (!byType.has(entry.type)) byType.set(entry.type, []);
          byType.get(entry.type)!.push(entry);
        }
        const sections = Array.from(byType.entries())
          .map(
            ([type, typeRows]) => `
              <details class="loop-type" open>
                <summary><span class="check">›</span>${htmlEscape(type)} (${typeRows.length})</summary>
                <ul class="loop-bullets">
                  ${typeRows
                    .map(
                      (entry) => `
                    <li class="loop-item" data-entry-id="${entry.id}">
                      <div class="loop-copy">
                        ${entry.title ? `<strong>${htmlEscape(entry.title)}</strong>` : ""}
                        <p>${htmlEscape(entry.text)}</p>
                      </div>
                    </li>`,
                    )
                    .join("")}
                </ul>
              </details>`,
          )
          .join("");
        return `
          <li class="loop-project">
            <div class="item-title"><span class="check">□</span>${htmlEscape(project)}</div>
            ${sections}
          </li>`;
      })
      .join("");
  }

  const openLoops = groupOpenLoops(projection.openLoops);

  const currentStatus = projection.active
    ? `
        <div class="current-status-item">
          <div class="status-lines"><p class="active">${htmlEscape(
            projection.active.title
              ? `${projection.active.title}: ${projection.active.text}`
              : projection.active.text,
          )}</p></div>
          <div class="meta">
            ${projection.active.project ? `<span>Project: ${htmlEscape(projection.active.project)}</span>` : ""}
            <span class="badge">status</span>
          </div>
        </div>`
    : '<p class="empty">No status set yet.</p>';

  const activeProjects = projection.activeProjects.length
    ? projection.activeProjects
        .map(
          (project) => `
            <li>
              <div class="item-title"><span class="check">✓</span>${htmlEscape(project.name)}</div>
              <div class="item-text">${htmlEscape(
                `${project.count} recent update${project.count === 1 ? "" : "s"} · latest: ${project.lastType}`,
              )}</div>
            </li>`,
        )
        .join("")
    : '<li class="empty">No active projects captured.</li>';

  const recent = projection.recent.length
    ? projection.recent
        .map(
          (entry) => `
            <li>
              <div class="item-title"><span class="check">›</span>${htmlEscape(
                [entry.project ? `Project: ${entry.project}` : "", entry.type]
                  .filter(Boolean)
                  .join(" · "),
              )}</div>
              <div class="item-text">${htmlEscape(
                entry.title ? `${entry.title}: ${entry.text}` : entry.text,
              )}</div>
            </li>`,
        )
        .join("")
    : '<li class="empty">No recent Frank activity.</li>';

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${htmlEscape(title)}</title>
    <link rel="stylesheet" href="/assets/frank.css">
  </head>
  <body class="admin-page cloud-workspace dashboard shared-view" data-workspace-id="${htmlEscape(
    workspaceId,
  )}">
    <div class="wrap">
      <header class="header">
        <div class="brand">
          <div class="logo" aria-hidden="true"><svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M14 26h36"/><path d="M22 25c1-8 4-13 10-13s9 5 10 13"/><path d="M18 36c4-3 9-3 14 0 5-3 10-3 14 0"/><circle cx="24" cy="36" r="6"/><circle cx="40" cy="36" r="6"/><path d="M30 36h4"/><path d="M21 49c7 4 15 4 22 0"/></svg></div>
          <div>
            <div class="kicker">Frank / shared view</div>
            <h1>${htmlEscape(title)}</h1>
            <p class="sub">Read-only view shared by the workspace owner.</p>
          </div>
        </div>
        <div class="header-actions">
          <div class="pill">Read-only</div>
        </div>
      </header>
      <main class="grid">
        <div class="column">
          <section class="card" aria-labelledby="status-heading">
            <h2 id="status-heading">Current status</h2>
            <div class="current-statuses" id="currentStatuses">${currentStatus}</div>
          </section>
          <section class="card" aria-labelledby="loops-heading">
            <div class="section-heading"><h2 id="loops-heading">Open loops</h2><span data-open-count>${projection.openLoops.length} open</span></div>
            <ul class="open-loop-list" data-open-loop-list>${openLoops}</ul>
          </section>
        </div>
        <div class="column">
          <section class="card" aria-labelledby="projects-heading">
            <h2 id="projects-heading">Active projects</h2>
            <ul id="activeProjects">${activeProjects}</ul>
          </section>
          <section class="card" aria-labelledby="recent-heading">
            <h2 id="recent-heading">Recent log</h2>
            <ul id="recent">${recent}</ul>
          </section>
        </div>
      </main>
      <div class="footer"><span>Read-only shared view · no changes can be made from this link</span></div>
    </div>
  </body>
</html>`;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      return await handle(request, env, ctx);
    } catch (error) {
      if (error instanceof HttpError) {
        return jsonResponse({ error: error.message }, error.status);
      }
      console.error("Unhandled request error", error);
      return jsonResponse({ error: "Internal server error" }, 500);
    }
  },
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    try {
      const cleaned = await cleanupAbandonedWorkspaces(env);
      if (cleaned > 0) {
        console.log(`Cleaned up ${cleaned} abandoned unclaimed workspace(s)`);
      }
    } catch (error) {
      console.error("Abandoned workspace cleanup failed", error);
    }
  },
} satisfies ExportedHandler<Env>;
