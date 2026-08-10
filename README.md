# Frank Cloud

[![Test](https://github.com/nmorton13/frank/actions/workflows/test.yml/badge.svg)](https://github.com/nmorton13/frank/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Frank Cloud is a hosted, agent-first work log.

> [!IMPORTANT]
> Frank is an early-stage pilot. It is intentionally small, and its interfaces, operating limits, and deployment procedures may change as it is tested in real use.

- Agents record notes, active work, todos, blockers, decisions, completed work, and session summaries through a workspace-scoped HTTP API.
- Humans review everything through a private dashboard.
- Humans close open loops (todos and blockers). Agents can create them but cannot close them.
- Frank is intentionally small. It is not a project-management platform or a multi-user collaboration suite.

## Why Frank?

I wanted an easy way for the coding agents I work with to keep a running work log that I can review without turning every update into a separate report or another system to maintain.

Because Frank Cloud exposes a small, authenticated API and a portable agent skill, an agent can log active work, capture a decision, add a todo, mark a blocker, or write a session summary directly. I review it all through a private dashboard, and I close the open loops myself. Frank is deliberately not a project-management platform — it is a small, private record of what agents and I are working on.

## Hosted service and source repository

[`frankagent.dev`](https://frankagent.dev) is the hosted pilot deployment. This repository contains its source code, tests, portable agent skill, Cloudflare configuration, migrations, and operational documentation.

Frank is Cloudflare-native rather than provider-agnostic:

| Cloudflare service | Role in Frank |
| --- | --- |
| Workers | HTTP application, API routing, authentication, and security headers |
| D1 | Workspace directory, claims, sessions, quotas, and lifecycle metadata |
| Durable Objects | Private, isolated storage for each workspace's work log |
| Workers Static Assets | Dashboard assets and the hosted agent skill |
| Email Sending | Claim verification and login links |
| Cron Triggers | Cleanup of expired and deleted workspace state |

Workspaces are private and isolated. Agents authenticate with workspace-scoped bearer credentials; humans authenticate with email-verified browser sessions. A credential for one workspace never grants access to another.

## Running your own deployment

The repository can be adapted for another Cloudflare account, but self-hosting is not currently a one-click workflow. A separate operator must provision their own D1 database, Durable Object and email bindings, application origin, secrets, routes, and edge controls. Deployment-specific identifiers in `wrangler.jsonc` describe the hosted pilot and do not grant access to its Cloudflare resources.

Before operating a public deployment, review the migration, backup, quota, WAF/rate-limit, billing-alert, and emergency-disable guidance in [`docs/cloud-security-operations.md`](docs/cloud-security-operations.md). See [`docs/operations.md`](docs/operations.md) for validation and smoke checks.

## Quick start

Give an agent the hosted Frank Cloud skill and let it bootstrap a workspace:

1. Give the agent the hosted skill URL: `https://frankagent.dev/skills/frank-cloud/SKILL.md`.
2. The agent bootstraps a workspace (asking you for a display name, dashboard title, timezone, and agent-credential label).
3. The agent securely stores its workspace credential.
4. The agent gives you a claim URL.
5. You verify your email and claim the dashboard.
6. The agent runs `remote-check`.
7. The agent can begin writing entries.

### The three required agent values

An agent needs three values to talk to its workspace:

| Variable | Meaning |
| --- | --- |
| `FRANK_CLOUD_BASE` | The Frank Cloud deployment origin (for example `https://frankagent.dev`). |
| `FRANK_CLOUD_WS` | The workspace id (for example `wsp_...`). |
| `FRANK_CLOUD_TOKEN` | The agent credential token (for example `frank_agent_...`). |

Shell exports are temporary examples only:

```bash
export FRANK_CLOUD_BASE="https://frankagent.dev"
export FRANK_CLOUD_WS="wsp_..."
export FRANK_CLOUD_TOKEN="frank_agent_..."
```

The credential is a capability token that grants read and write access to its workspace and is returned exactly once at bootstrap. Store durable credentials through the agent environment's normal secret-storage mechanism — never in plaintext, a repository, or a config file in Git.

## Entry types

```text
status   = headline current focus; do not use for ordinary notes
active   = active-right-now work for a project
note     = context/history
todo     = future action; remains an open loop until closed
blocker  = blocked work; remains an open loop until closed
done     = completed work
decision = a durable choice and rationale
session  = concise summary of a work or agent session
```

Agents create todos and blockers but cannot close them. Closing an open loop is a human action in the dashboard.

## URLs and access

Frank Cloud uses three distinct URL types. They are not interchangeable:

1. **Dashboard URL** (`/w/{workspaceId}`) — a reusable, bookmarkable link. The URL itself does **not** grant access; it only opens the dashboard when your browser has a valid, authenticated session for that workspace. Sharing only the dashboard URL does not expose any data, and each browser or browser profile must sign in separately.

2. **Login magic link** — a short-lived, single-use authentication capability sent by email. Whoever redeems an unused link first receives a browser session. Do not share or forward it before use. It currently expires after 20 minutes.

3. **Initial claim link** — a temporary ownership capability returned when a workspace is bootstrapped. Deliver it securely, use it promptly, and never share it. It currently expires after 30 minutes.

A few things worth knowing about how access works:

- Chrome, Safari, and separate browser profiles each keep their own session cookie. A user can stay signed in on multiple browsers by requesting and redeeming a separate login link in each one.
- Browser sessions currently last up to 30 days unless you log out, or the session is revoked or expired.
- Workspace IDs are **not** secrets or credentials. Human access requires an owner-bound session cookie; agent access requires a workspace-scoped bearer token.
- Sharing an ordinary dashboard URL is **not** the same as sharing access. Sharing an unused claim or login magic link **is** equivalent to sharing temporary access authority.

See [`docs/cloud-security-operations.md`](docs/cloud-security-operations.md) for the full access and session model.

## Using Frank Cloud from an agent

The portable skill makes Frank Cloud discoverable and reusable across agents and repositories:

- Agents can follow the hosted skill at `https://frankagent.dev/skills/frank-cloud/SKILL.md` and its `frank-cloud-post.sh` helper.
- The skill source of truth lives at [`skills/frank-cloud`](skills/frank-cloud) in this repository.
- Run `node scripts/sync-skill.js` to synchronize the source-of-truth skill into the hosted copy under [`public/skills/frank-cloud`](public/skills/frank-cloud).

## Development and validation

This repository contains the Frank Cloud Worker and its development tooling. Local tools are used during development and testing; the product itself runs on Cloudflare Workers.

Use Node.js 22.22.2 or newer on the Node 22 line, or Node.js 24.15.0 or newer. A Cloudflare account is not required to run the local test suite.

```bash
npm install
npm test                # Cloud tests, DOM tests, helper integration, skill-sync
npm run typecheck
npm run cf:check        # Wrangler dry-run build
npm run dev:cloud       # local `wrangler dev` against a local D1
```

## Documentation

- [Frank Cloud HTTP API](docs/cloud-api.md)
- [Frank Cloud security and cost controls](docs/cloud-security-operations.md)
- [Operations and smoke checks](docs/operations.md)

## License

[MIT](LICENSE)
