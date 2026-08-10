# Operations and smoke checks

For Frank Cloud deployment, abuse controls, billing alerts, WAF rules, and the emergency-disable checklist, also follow [`cloud-security-operations.md`](cloud-security-operations.md).

Run these checks after a Frank Cloud change and after restoring a database. For schema or storage changes, first follow the D1 backup procedure in [`cloud-security-operations.md`](cloud-security-operations.md).

## Repository checks

From the repository:

```bash
npm install
npm test                # Cloud, DOM, helper, and skill-sync suites
npm run typecheck
npm run cf:check        # Wrangler dry-run build
npm audit --omit=dev
```

`npm run cf:check` produces a dry-run build and confirms the Worker bundles without deploying.

## Local development Worker

For local iteration, run the Worker against a local D1 with `wrangler dev --local`:

```bash
npm run dev:cloud
```

The `test:helper` suite (`node tests/frank-cloud-helper.test.js`) already boots a local `wrangler dev` instance and exercises the `frank-cloud-post.sh` helper end-to-end, so local Worker behavior is covered by `npm test`.

## Running-service checks

Set the base URL for the Frank Cloud deployment being checked:

```bash
export FRANK_CLOUD_BASE="https://frankagent.dev"
```

Check the health endpoint and the hosted skill:

```bash
curl -fsS "$FRANK_CLOUD_BASE/health"
curl -fsS "$FRANK_CLOUD_BASE/skills/frank-cloud/SKILL.md"
curl -fsS "$FRANK_CLOUD_BASE/skills/frank-cloud/frank-cloud-post.sh"
```

Open the dashboard in a browser and verify a workspace can be claimed, that claim/login email verification works, and that a todo/blocker created by an agent can be closed from the dashboard.

## Before publishing

In addition to `npm test`, audit tracked files and Git history for API tokens, agent credentials, private hostnames, email addresses, and real work-log data. Confirm `.env`, runtime state, `.wrangler`, generated agent runtime directories, and any D1 exports or backups are not tracked.
