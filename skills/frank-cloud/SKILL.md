---
name: frank-cloud
description: Log work notes, todos, blockers, status to Frank Cloud. Use when the user asks to log work to Frank, update status, mark a todo, or set up Frank. Requires bash + curl + Node.js (Claude Code, Codex, Cursor, Copilot, Hermes).
version: 2.3.2
compatibility: Requires a reachable Frank Cloud API. Bootstrap is public (no token needed). After setup, FRANK_CLOUD_BASE, FRANK_CLOUD_WS, and FRANK_CLOUD_TOKEN are required (or auto-loaded from ~/.config/frank/frankrc). Needs bash, curl, and Node.js (used for URL/JSON encoding).
---

# Frank Cloud Work Log Skill

Frank Cloud is a hosted, agent-first work log. Agents write through a workspace-scoped, authenticated HTTP API. A human reviews via a private dashboard.

This skill is **portable**: it is a markdown guide plus a plain bash/curl/Node helper. Any agent that can run shell commands plus Node.js (Claude Code, Codex, Cursor, GitHub Copilot, Hermes, etc.) can use it. The only per-agent difference is *how* the skill directory is installed; the content and helper work everywhere.

## Requirements

The helper needs **bash**, **curl**, and **Node.js** (it uses Node for URL-encoding and JSON serialization). Verify they are present before first use:

```bash
bash --version >/dev/null && curl --version >/dev/null && node --version >/dev/null
```

## Quick start: one-time setup

Tell the human:

> Read `@url:https://frankagent.dev/skills/frank-cloud/SKILL.md` and set up Frank for me.

Then:

1. Bootstrap an unclaimed workspace by calling the public API (no token required). Optionally pass an `email` to have the claim link emailed to the human automatically.
2. The response returns a workspace ID, an agent credential, and a human claim URL (and the claimed email, if provided).
3. Store the credential securely and give the claim URL to the human (or have it emailed via `email`).
4. The human claims the private dashboard by opening the emailed verification link, or by opening the claim URL and entering their email.
5. Set the three environment variables (or write them to the XDG config file so the helper loads them automatically).

### Bootstrap a workspace

Call the public bootstrap endpoint. No `Bootstrap-Token` header is needed for the public path. Generate one high-entropy idempotency key and retain it until the bootstrap succeeds:

```bash
curl -sS -X POST "https://frankagent.dev/v1/workspaces" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: bootstrap-$(node -e 'process.stdout.write(crypto.randomUUID())')" \
  -d '{
    "displayName":"My Workspace",
    "pageTitle":"My Work Log",
    "timeZone":"America/Chicago",
    "agentLabel":"my-agent",
    "email":"owner@example.com"
  }'
```

The optional `email` field emails the human a one-time claim/verification link so they can claim the private dashboard without opening the claim URL.

The response returns structured workspace, agent credential, and claim data:

```json
{
  "workspace": { "id": "wsp_...", "state": "unclaimed" },
  "agentCredential": { "id": "cred_...", "token": "frank_agent_...", "prefix": "frank_agent_...", "scopes": ["read","write"] },
  "claim": { "id": "clm_...", "token": "frank_claim_...", "expiresAt": "2026-...", "url": "https://frankagent.dev/claim#token=...", "email": "owner@example.com" }
}
```

**Use the same `Idempotency-Key` on retry** to safely retry without creating multiple workspaces. Treat it as a temporary secret: anyone who knows the key and original request can replay the bootstrap response while the claim remains unused. Never derive it from a workspace name, email address, or other public metadata.

### Set environment variables

You can export the three variables per shell, or write them to the XDG config file so the helper loads them automatically:

```bash
# Option A: export in the current shell
export FRANK_CLOUD_BASE="https://frankagent.dev"   # your deployment origin
export FRANK_CLOUD_WS="wsp_..."                        # workspace id
export FRANK_CLOUD_TOKEN="frank_agent_..."             # agent credential token

# Option B (recommended): write the XDG config file once, mode 600
mkdir -p "${XDG_CONFIG_HOME:-$HOME/.config}/frank"
umask 077
cat > "${XDG_CONFIG_HOME:-$HOME/.config}/frank/frankrc" <<EOF
export FRANK_CLOUD_BASE="https://frankagent.dev"
export FRANK_CLOUD_WS="wsp_..."
export FRANK_CLOUD_TOKEN="frank_agent_..."
EOF
```

The helper `frank-cloud-post.sh` automatically sources `~/.config/frank/frankrc` (honoring `XDG_CONFIG_HOME`), so once that file exists you do not need to re-export the variables in every shell. The file holds capability credentials — keep it mode `600` and out of Git.

Verify connectivity without writing anything:

```bash
/path/to/skills/frank-cloud/scripts/frank-cloud-post.sh remote-check
```

## Entry types

```text
status   = headline current focus; do not use for ordinary notes
active   = active-right-now work for a project; a new active closes the prior one for the same project
note     = context/history
todo     = future action; remains an open loop until closed
blocker  = blocked work; remains an open loop until closed
done     = completed work
decision = a durable choice and rationale
session  = concise summary of a work or agent session
```

Rules:

- Use `status` only to change the headline status.
- Use `active` for work happening now.
- Use `note` for information with no action required.
- Do not duplicate a todo/blocker as a note.
- Use `decision` for choices worth preserving.
- Use `session` for a concise summary, not a transcript.
- **Agents can close loops.** Any agent credential with `write` scope can close any open todo/blocker in the workspace (human- or agent-opened) via the close endpoint. The audit trail records which agent closed it. Humans can also close loops from the dashboard.

## Helper usage

```bash
# Create entries
frank-cloud-post.sh status "headline status" "Project Name" tag1 tag2
frank-cloud-post.sh active "working on X" "Project Name"
frank-cloud-post.sh note "context" "Project Name"
frank-cloud-post.sh todo "follow-up" "Project Name"
frank-cloud-post.sh blocker "blocked by Y" "Project Name"
frank-cloud-post.sh done "completed work" "Project Name"
frank-cloud-post.sh decision "decision and rationale" "Project Name"
frank-cloud-post.sh session "session title" "Project Name" tag1

# Read
frank-cloud-post.sh status-view
frank-cloud-post.sh open
frank-cloud-post.sh list --type todo --project "Project Name"
frank-cloud-post.sh projects
frank-cloud-post.sh history "Project Name"
frank-cloud-post.sh summary today

# Close a loop (agents can close any open todo/blocker)
frank-cloud-post.sh close <entry-id>
frank-cloud-post.sh backup [outfile.json]  # full untruncated portable dump (default stdout)

# Project lifecycle (only when asked to clean up project names)
frank-cloud-post.sh project rename "Old Name" "New Name"
frank-cloud-post.sh project merge "From Project" "To Project"
frank-cloud-post.sh project archive "Project"
frank-cloud-post.sh project inactive "Project"

# Bootstrap (optional 4th arg = email the claim link)
frank-cloud-post.sh bootstrap "My Workspace" "America/Chicago" "my-agent"
frank-cloud-post.sh bootstrap "My Workspace" "America/Chicago" "my-agent" "owner@example.com"

# Connectivity
frank-cloud-post.sh remote-check   # verify base URL + token without writing
frank-cloud-post.sh projects --limit 100 --offset 0
frank-cloud-post.sh self-test      # write + verify a marked synthetic entry
frank-cloud-post.sh skill-update   # fetch the latest hosted skill + helper
```

The helper checks the hosted skill version at most once per day (cached locally) and prints a non-blocking notice to stderr when a newer version is available. It never blocks or fails a write. To update, run `frank-cloud-post.sh skill-update` (or ask your agent to update and tell you what's new).

### Keeping the skill updated

Frank's skill is portable and self-updating. When a newer version is published to the hosted skill (the copy the Worker serves at `/skills/frank-cloud/`), the helper:

1. Notices the version drift the next time it runs a write (checked at most once per day).
2. Prints a non-blocking notice to stderr like:
   ```
   frank-cloud: a newer skill version (2.3.1) is available (installed 2.3.0).
   frank-cloud: run `frank-cloud-post.sh skill-update` to refresh, or ask your agent to update.
   ```
3. Leaves the write untouched — the notice never blocks or fails a write.

To update, run:
```bash
frank-cloud-post.sh skill-update
```
or ask your agent: *"Update the Frank skill."* The helper fetches the latest hosted `SKILL.md` and `frank-cloud-post.sh`, writes them over the local copies, and clears the version cache so the next run reflects the new version.

**Where files land:** the helper detects the skill root (the directory containing `SKILL.md`) whether the helper sits flat next to it (manual / hosted-copy install) or in a `scripts/` subdirectory (skill-manager install such as `~/.hermes/skills/...`). Updates always land in the correct places.

The skill is portable — it works under any agent that can run bash + curl + Node (Hermes, Claude Code, Codex, Cursor, Copilot, and others). The self-update logic lives entirely in the helper script, not in any agent, so the behavior is identical regardless of which agent drives it.

**Skill-root detection:** the helper resolves the skill root by looking for `SKILL.md`:
- If `SKILL.md` sits next to the helper (hosted-copy / manual install), that directory is the root.
- If the helper lives in a `scripts/` subdirectory (skill-manager installs such as `~/.hermes/skills/...`), the root is the parent of `scripts/`.
- Otherwise it falls back to the helper's own directory.

So `skill-update` writes the fetched `SKILL.md` to the true root and the helper in place, in either layout. If you installed Frank's skill in an unusual directory structure and `skill-update` seems to do nothing, check whether the local `SKILL.md` is still old and move it to the directory containing the helper (or the helper's parent, if it is in `scripts/`), then run `skill-update` again.

The bootstrap helper prints its generated retry key to stderr. If the request outcome is uncertain, rerun the same bootstrap command with that value as `FRANK_BOOTSTRAP_IDEM_KEY`.

## Speaking naturally to your agent

You don't have to quote helper commands. Tell your agent what you want in plain words and it will translate. Common phrasings:

```text
"Add a todo to project Frank: write up the Access migration decision."
"Have Frank log a note to the docs project about the backup format."
"Frank, add a blocker to project X: waiting on the design sign-off."
"Set my current status to: finishing the portability docs."
"Make a decision entry in project Y: we're going with the JSON export approach."
"Log a session for today's work on project Z."
"Put a done entry in project Q: deployed the export button."
"Close the todo about the trailing space bug."
"What open loops are in project Frank?"   /   "What's my current status?"
```

The mapping is simple: an entry type (note/todo/blocker/status/done/decision/session) plus a project, and optionally tags. If you only say "log this to Frank" the agent will pick a sensible type and project (defaulting to the active project or "Frank").

## Portability: backup and restore

Frank's portability model is a **full portable JSON export + agent re-ingest through the normal write API**. There is no restore endpoint — to move a workspace, you export the data and have an agent replay it into the new workspace.

**Back up (to a file):**
```bash
frank-cloud-post.sh backup /tmp/frank-backup.json
```

**Back up (to stdout):**
```bash
frank-cloud-post.sh backup
```

**From the dashboard:** click **Export** in the header — it downloads `frank-backup-{workspaceId}.json` (owner session only; share viewers cannot export).

Say it naturally:
```text
"Back up my Frank data to ~/frank-backup.json."
"Tell Frank to export everything."
```

**Put it back (move to a fresh workspace):**
```text
"Here's my old Frank backup at /tmp/frank-backup.json. Fire up a new workspace
and re-create the projects and todos from it."
```

The agent reads the JSON and replays entries through `POST /entries`. Two caveats:

- **Timestamps flatten.** Re-ingested entries get `created_at = now`; the original timeline is not preserved. The decision to accept this is documented in Frank.
- **Open vs closed state.** Re-ingest recreates entries as open; if you need closed loops, the agent should mark them done after importing.

A backup is a snapshot of your workspace content (entries, projects, aliases, daily summaries). It is a portable archive you can move between deployments or keep as an off-site copy.

## Idempotency

Writes require an `Idempotency-Key` header. The helper generates a fresh key per call, so each invocation is a distinct mutation. If you need a **retry-safe** write (same logical mutation on retry), set a fixed key:

```bash
FRANK_IDEM_KEY="my-fixed-key" frank-cloud-post.sh todo "important task" "Project"
```

Reusing the same key with the same payload returns the original entry (`replayed: true`) instead of creating a duplicate.

**Bootstrap idempotency**: A high-entropy `Idempotency-Key` is required. Retain and reuse it only for retries of the same bootstrap request. Treat it as a temporary secret and never derive it from public metadata.

## Direct API reference

All routes under `/v1/workspaces/{workspaceId}` require `Authorization: Bearer <token>` except public status/health routes and the bootstrap endpoint.

```text
POST /v1/workspaces            bootstrap (public; idempotency-key required)
POST /v1/workspaces/{ws}/entries                 create entry (idempotency-key required)
GET  /v1/workspaces/{ws}/entries                 list entries (?type=&project=&status=&limit=)
GET  /v1/workspaces/{ws}/open                    open loops (todos + blockers)
GET  /v1/workspaces/{ws}/status                  status projection
GET  /v1/workspaces/{ws}/export                  capped human dashboard export (100 entries, 30 summaries, 1MB)
GET  /v1/workspaces/{ws}/export?full=1           full untruncated portable dump (agent bearer read scope, or owner human session)
GET  /v1/workspaces/{ws}/projects                list projects (?all=true&limit=100&offset=0)
GET  /v1/workspaces/{ws}/projects/{name}/entries project history
GET  /v1/workspaces/{ws}/summary?date=today      deterministic daily summary

Entry/open responses include `truncated`; status/history/summary responses also report truncation when row or byte limits omit data. Entry and history pages accept at most 100 rows. Summary entry projections intentionally omit large `structuredJson` payloads (`structuredJson` is `{}`).

POST /v1/workspaces/{ws}/projects/rename         {nameOrAlias, newName}
POST /v1/workspaces/{ws}/projects/merge          {fromNameOrAlias, toNameOrAlias}
POST /v1/workspaces/{ws}/projects/archive        {nameOrAlias}
POST /v1/workspaces/{ws}/projects/inactive       {nameOrAlias}
PATCH /v1/workspaces/{ws}/entries/{id}/close      close an open todo/blocker (agent bearer or human session)
```

Example direct write:

```bash
curl -fsS -X POST "$FRANK_CLOUD_BASE/v1/workspaces/$FRANK_CLOUD_WS/entries" \
  -H "Authorization: Bearer $FRANK_CLOUD_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{"type":"note","text":"Updated docs.","project":"Frank","tags":["docs"],"source":"agent"}'
```

## Local dashboard (optional)

The helper can render a lightweight local HTML dashboard from the status projection. This is a read-only view for the agent or user; it does not require the human claim flow.

```bash
frank-cloud-post.sh status-view > /tmp/frank-dashboard.json
# Then render with the inline node script below
```

A minimal standalone dashboard page can be generated with:

```bash
node -e '
const fs=require("fs");
const d=JSON.parse(fs.readFileSync("/tmp/frank-dashboard.json","utf8"));
const esc=s=>String(s??"").replace(/[&<>"]/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;"}[m]));
const html=`<!doctype html><html><head><meta charset="utf-8"><title>Frank</title>
<style>body{font-family:ui-monospace,monospace;background:#f7f2e9;color:#22201d;max-width:900px;margin:40px auto;padding:0 20px}
h1{letter-spacing:-.05em}.card{border:1px solid #22201d;border-radius:4px;padding:18px;margin:14px 0;background:rgba(255,250,242,.84);box-shadow:3px 3px 0 rgba(34,32,29,.1)}
h2{font-size:13px;text-transform:uppercase;letter-spacing:.11em;color:#716d66;border-bottom:1px solid #d8cdbc;padding-bottom:8px}
li{margin:6px 0}.badge{color:#075f49;background:#e1f3ea;border:1px solid #bbf7d0;border-radius:3px;padding:2px 6px;font-size:12px}</style></head><body>
<h1>Frank</h1>
<div class="card"><h2>Current status</h2><p>${esc(d.active?.text||"—")}</p></div>
<div class="card"><h2>Active right now</h2><ul>${d.activeRightNow.map(e=>`<li>${esc(e.text)}</li>`).join("")||"<li>—</li>"}</ul></div>
<div class="card"><h2>Open loops</h2><ul>${d.openLoops.map(e=>`<li>${esc(e.text)} <span class="badge">${esc(e.type)}</span></li>`).join("")||"<li>—</li>"}</ul></div>
<div class="card"><h2>Active projects</h2><ul>${d.activeProjects.map(p=>`<li>${esc(p.name)} <span class="badge">${p.count}</span></li>`).join("")||"<li>—</li>"}</ul></div>
</body></html>`;
fs.writeFileSync("/tmp/frank-dashboard.html",html);
console.log("Wrote /tmp/frank-dashboard.html");
'
```

Open `/tmp/frank-dashboard.html` in a browser. This is a local, read-only snapshot — it does not expose the workspace publicly.

## Onboarding a new workspace

Frank Cloud's public bootstrap endpoint lets any agent create a workspace without human login or an operator token. Ask the human for:

1. What should the workspace be called? (`displayName`, optional)
2. What title should show on the dashboard? (`pageTitle`, optional)
3. What timezone are they in? (`timeZone`, defaults to `UTC`)
4. What should the agent credential be labeled? (`agentLabel`, required)
5. Their email (`email`, optional) — if provided, the claim link is emailed to them so they can claim the private dashboard without opening the claim URL.

Then bootstrap with a high-entropy idempotency key for retry safety. Retain the key until the request succeeds:

```bash
IDEM_KEY="bootstrap-$(node -e 'process.stdout.write(crypto.randomUUID())')"
curl -sS -X POST "$FRANK_CLOUD_BASE/v1/workspaces" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $IDEM_KEY" \
  -d '{
    "displayName":"My Workspace",
    "pageTitle":"My Work Log",
    "timeZone":"America/Chicago",
    "agentLabel":"my-agent",
    "email":"owner@example.com"
  }'
```

The response returns workspace, credential, and claim URL. The same key and payload reproduce that response while the claim remains unused.

- Store the agent credential securely. It is returned only during bootstrap and eligible retries.
- Keep the idempotency key private while the claim remains unused, then discard it.
- Give the human the claim URL (or, if you passed `email`, they will receive it by email).
- Export `FRANK_CLOUD_BASE`, `FRANK_CLOUD_WS`, and `FRANK_CLOUD_TOKEN` for that workspace, or write them to `~/.config/frank/frankrc` so the helper loads them automatically.

Each workspace is private and isolated. One person's workspace cannot be read by another.

## The four URLs and how access works

Frank uses four URL types. Do not confuse them, and never pass a capability URL to a third party:

1. **Dashboard URL** (`/w/{workspaceId}`) — reusable and bookmarkable. The URL itself does **not** grant access; it only opens the dashboard when the browser already has a valid, authenticated session for that workspace. Sharing the dashboard URL alone does not expose workspace data.
2. **Login magic link** — short-lived, single-use, sent by email. Whoever redeems an unused link first receives a browser session. It must not be shared or forwarded before use; it currently expires after 20 minutes.
3. **Initial claim link** — temporary ownership capability returned during bootstrap. It must be delivered securely, used promptly, and never shared; it currently expires after 30 minutes.
4. **Share link** (`/s/{shareToken}`) — a read-only dashboard view created by the workspace owner. Anyone with the link can view the dashboard, but **cannot** close loops, revoke credentials, or export data. The owner can revoke a share link at any time, which immediately invalidates it. Treat it as a read-only capability: share it only with people you want to see the workspace.

Access model:

- **Get your dashboard URL from your agent.** Once a workspace is claimed, just ask: *"What's my Frank dashboard URL?"* — the agent knows the workspace ID and returns `https://frankagent.dev/w/{workspaceId}`. The URL itself does not grant access; it only opens the dashboard when the browser already has an authenticated session.
- Chrome, Safari, and separate browser profiles each keep their own session cookie. A user can stay signed in on several browsers by redeeming a separate login link in each.
- Browser sessions currently last up to 30 days unless logged out, revoked, or expired.
- Workspace IDs are **not** secrets or credentials. Human access requires an owner-bound session cookie; agent access requires a workspace-scoped bearer token.
- Sharing an ordinary dashboard URL is not sharing access. Sharing an unused claim or login magic link is sharing temporary access authority.

## Notes

- The token is a capability credential. Keep it private; it grants read+write to its workspace.
- No `Bootstrap-Token` or account is required for the public bootstrap path.
- Rate limits apply to bootstrap, public authentication requests, email delivery, agent credentials, workspace traffic, and writes. Workspace entry/project cardinality is also bounded.
- Public signup has a lower live-workspace ceiling than the absolute ceiling so operator capacity remains available.
- URL capabilities use fragments so browsers do not send them in HTTP request targets. Treat the full claim URL as secret until it is used.
- Unclaimed workspaces expire and are deleted periodically.
- Email sending (for the human claim/login flow) requires the Workers Paid plan. The agent API works on the Free plan.
- Passing an optional `email` at bootstrap emails the human a one-time claim/verification link, so they can claim the private dashboard without opening the claim URL.
- Store the agent credential in `~/.config/frank/frankrc` (mode `600`) so the helper auto-loads it; it is never committed to Git.
