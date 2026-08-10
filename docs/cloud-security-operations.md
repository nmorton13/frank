# Frank Cloud security and cost controls

Frank Cloud isolates each workspace with workspace-bound agent credentials and human ownership sessions. Agent, claim, verification, login, and browser-session credentials are stored as hashes. Claim and magic-link capabilities are placed in URL fragments, then exchanged through same-origin JSON POST requests; fragments are removed from browser history by the page scripts.

## The three URL types and session model

Frank Cloud uses three distinct URL types with very different properties:

| Type | Example | Expires | Reusable | Grants access? |
| --- | --- | ---: | ---: | --- |
| **Dashboard URL** | `/w/{workspaceId}` | never (bookmark) | yes | No — only opens the dashboard with a valid session |
| **Login magic link** | `/login#token=…` | 20 minutes | no (single-use) | Yes, a temporary browser session to whoever redeems it first |
| **Initial claim link** | `/claim#token=…` | 30 minutes | no (single-use) | Yes, temporary ownership of a new workspace |

Key properties of access control:

- A **dashboard URL does not grant access**. It requires a valid, authenticated browser session for that workspace (an owner-bound `frank_session` cookie). Sharing only the dashboard URL does not expose any workspace data.
- A **login magic link** is a short-lived, single-use authentication capability sent by email. Whoever redeems an unused link first receives a browser session. It must not be shared or forwarded before use, and it currently expires after 20 minutes.
- An **initial claim link** is a temporary ownership capability returned during workspace bootstrap. It must be delivered securely, used promptly, and never shared. It currently expires after 30 minutes.
- Chrome, Safari, and separate browser profiles each keep their own session cookie. A user can remain signed in on multiple browsers by requesting and redeeming a separate login link in each browser.
- Browser sessions currently last up to 30 days unless the user logs out or the session is revoked or expired.
- **Workspace IDs are not secrets or authentication credentials.** They are opaque identifiers, not capabilities. Human access requires an owner-bound session cookie; agent access requires a workspace-scoped bearer token.
- Sharing an ordinary dashboard URL is **not** equivalent to sharing access. Sharing an unused claim or login magic link **is** equivalent to sharing temporary access authority.

## Application limits

The defaults in `wrangler.jsonc` are conservative pilot limits and can be changed before deployment:

| Variable | Default | Scope |
| --- | ---: | --- |
| `BOOTSTRAP_QUOTA_PER_HOUR` | 10 | absolute all-mode creation circuit/hour |
| `BOOTSTRAP_PUBLIC_QUOTA_PER_HOUR` | 5 | public creation/hour; leaves operator headroom |
| `BOOTSTRAP_CLIENT_CEILING` | 5 | public creation per client/hour |
| `BOOTSTRAP_PUBLIC_TOTAL_CEILING` | 80 | retained public workspaces |
| `BOOTSTRAP_TOTAL_CEILING` | 100 | all retained workspaces |
| `LOGIN_CLIENT_CEILING` / `LOGIN_GLOBAL_CEILING` | 20 / 200 | login requests/hour |
| `CLAIM_CLIENT_CEILING` / `CLAIM_GLOBAL_CEILING` | 20 / 200 | claim requests/hour |
| `EMAIL_RECIPIENT_CEILING` / `EMAIL_GLOBAL_CEILING` | 3 / 50 | claim plus login emails/hour |
| `AGENT_CREDENTIAL_MINUTE_CEILING` | 120 | requests per agent credential/minute |
| `HUMAN_SESSION_MINUTE_CEILING` | 120 | requests per browser session/minute |
| `WORKSPACE_MINUTE_CEILING` | 240 | aggregate agent + human requests per workspace/minute |
| `WORKSPACE_WRITE_HOUR_CEILING` | 1000 | agent writes per workspace/hour |
| `USER_WORKSPACE_CEILING` | 5 | workspaces per verified human |
| `WORKSPACE_ENTRY_CEILING` | 10000 | retained entries per workspace |
| `WORKSPACE_PROJECT_CEILING` | 1000 | retained projects per workspace |
| `WORKSPACE_ALIAS_CEILING` | 20000 | retained project aliases per workspace |
| `WORKSPACE_PROJECT_EVENT_CEILING` | 10000 | retained lifecycle audit events per workspace |
| `SUMMARY_ENTRY_CEILING` | 200 | target-date rows considered per summary; heavy structured JSON is not selected |
| `COLLECTION_RESPONSE_BYTE_CEILING` | 524288 | entry/open/status/history response budget |
| `SUMMARY_OUTPUT_BYTE_CEILING` | 262144 | summary body bytes |
| `SUMMARY_RESPONSE_BYTE_CEILING` | 524288 | whole summary response budget |
| `EXPORT_ENTRY_CEILING` / `EXPORT_RESPONSE_BYTE_CEILING` | 100 / 1048576 | bounded export rows/response |
| `CLEANUP_BATCH_SIZE` | 20 | abandoned workspaces processed per cron |
| `DELETED_WORKSPACE_RETENTION_DAYS` | 30 | incident-review tombstone retention |

Application limits still execute Worker code and some D1 operations. They are not a substitute for Cloudflare edge controls.

## Manual Cloudflare dashboard checklist

These are account/dashboard actions and are deliberately **not configured by this repository**:

- [ ] Create edge rate-limiting/WAF rules for `POST /v1/workspaces`, `/v1/claims`, `/v1/login-links`, `/v1/claim-sessions`, and `/v1/login-sessions` before requests reach the Worker.
- [ ] Add a broader request-rate rule for `/v1/workspaces/*`, with stricter treatment for mutation methods.
- [ ] Challenge suspicious public signup/authentication traffic with Turnstile or a managed challenge if public onboarding is enabled.
- [ ] Restrict or disable the `workers.dev` route when the custom domain is authoritative.
- [ ] Configure billing alerts and usage notifications for Workers, D1, Durable Objects, Email Routing/Sending, and outbound bandwidth.
- [ ] Set lower warning thresholds than the maximum acceptable monthly spend.
- [ ] Document an emergency control: disable public bootstrap (`BOOTSTRAP_PUBLIC_QUOTA_PER_HOUR=0`; set `BOOTSTRAP_QUOTA_PER_HOUR=0` to disable all creation), disable email (`EMAIL_ENABLED=false`), and, if necessary, route/block traffic at the edge.
- [ ] Preserve an operator-only way to update variables/secrets during an incident.
- [ ] Review sampled logs without recording authorization headers, cookies, email bodies, or URL fragments.
- [ ] Test restoration and D1 backup procedures before schema migrations.

## Deployment identifiers

This document is generic; commands that touch Cloudflare state use the D1
database **binding name** in place of an account-specific value. In the hosted
pilot, the binding is `frank-cloud-directory` (matched in `wrangler.jsonc` by
`binding: "DIRECTORY"`). Substitute your own D1 binding name when operating
another deployment. Wherever a code block below shows a command with a literal
database name, replace it with your binding. For convenience, set it once and
reuse in a shell:

```bash
export FRANK_D1="frank-cloud-directory"   # your D1 binding name
```

All other options, `vars`, quota ceilings, secret names (`BOOTSTRAP_TOKEN`,
`EMAIL_*`), and the edge/billing procedures below are deployment-agnostic.

## D1 backup and recovery

Before a remote migration, create an operator-local SQL export and record the current Time Travel bookmark:

```bash
mkdir -p .tmp/backups
npx wrangler d1 export "$FRANK_D1" --remote --output ".tmp/backups/${FRANK_D1}-before-$FRANK_MIGRATION.sql"
npx wrangler d1 time-travel info "$FRANK_D1"
```

Keep the export private and capture the full `time-travel info` output in the incident/deployment record. To restore by bookmark:

```bash
npx wrangler d1 time-travel restore "$FRANK_D1" --bookmark=<bookmark>
```

A restore is destructive, overwrites database state, and cancels in-flight queries and transactions. Time Travel retention depends on the Cloudflare plan, so confirm the available bookmark before migration. See Cloudflare's official [D1 import/export documentation](https://developers.cloudflare.com/d1/best-practices/import-export-data/) and [Time Travel documentation](https://developers.cloudflare.com/d1/reference/time-travel/).

## Live quota diagnostics and repair

Live quota reconciliation is upward-only so cleanup cannot erase a bootstrap reservation that has incremented a counter but has not yet written its durable pending row. An abrupt Worker stop in that small window can therefore conservatively consume capacity until an operator repairs it; this fails closed instead of allowing the workspace ceiling to be exceeded. Normal workspace deletion and expired durable reservations decrement the fixed counters automatically.

Inspect counters and their authoritative lower bounds with remote D1 queries:

```bash
npx wrangler d1 execute "$FRANK_D1" --remote --command \
  "SELECT bucket, count FROM bootstrap_quota WHERE bucket IN ('live','live:public') ORDER BY bucket"
npx wrangler d1 execute "$FRANK_D1" --remote --command \
  "SELECT state, bootstrap_mode, COUNT(*) AS count FROM workspaces GROUP BY state, bootstrap_mode ORDER BY state, bootstrap_mode"
npx wrangler d1 execute "$FRANK_D1" --remote --command \
  "SELECT bootstrap_mode, COUNT(*) AS count FROM bootstrap_idempotency WHERE status='pending' AND quota_reserved=1 AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now') AND NOT EXISTS (SELECT 1 FROM workspaces w WHERE w.id=bootstrap_idempotency.workspace_id) GROUP BY bootstrap_mode"
```

Only repair downward during an incident window: first set both bootstrap hourly ceilings to `0` (or block `POST /v1/workspaces` at the edge), wait for in-flight requests to finish, take the D1 export/bookmark above, then recompute the fixed rows:

```bash
npx wrangler d1 execute "$FRANK_D1" --remote --command \
  "UPDATE bootstrap_quota SET count=(SELECT COUNT(*) FROM workspaces WHERE state IN ('unclaimed','active'))+(SELECT COUNT(*) FROM bootstrap_idempotency bi WHERE bi.status='pending' AND bi.quota_reserved=1 AND bi.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now') AND NOT EXISTS (SELECT 1 FROM workspaces w WHERE w.id=bi.workspace_id)) WHERE bucket='live'; UPDATE bootstrap_quota SET count=(SELECT COUNT(*) FROM workspaces WHERE state IN ('unclaimed','active') AND bootstrap_mode='public')+(SELECT COUNT(*) FROM bootstrap_idempotency bi WHERE bi.status='pending' AND bi.quota_reserved=1 AND bi.bootstrap_mode='public' AND bi.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now') AND NOT EXISTS (SELECT 1 FROM workspaces w WHERE w.id=bi.workspace_id)) WHERE bucket='live:public'"
```

Re-enable bootstrap only after re-running the diagnostic queries. Never force counters downward while creation traffic is allowed.

## Bootstrap token (`BOOTSTRAP_TOKEN`)

`BOOTSTRAP_TOKEN` is the operator secret that authorizes the `Bootstrap-Token` header for creating workspaces. Provision it as a Cloudflare secret (never a plaintext `vars` entry), and use at least 128 bits of entropy (for example `openssl rand -hex 32`, which is 256 bits). A weak token (e.g. 32 bits) is unnecessary exposure: a distributed client could brute-force operator-mode creation, though the global 10/hour and live-100 circuits still bound the outcome.

It is **not** part of authentication for workspaces that already exist. Agent credentials, claim/verification/login tokens, and browser sessions are random values stored as plain SHA-256 hashes and verified against that literal value; they do not depend on `BOOTSTRAP_TOKEN`. Rotating it therefore does **not** revoke or lose access to any issued credential, session, or workspace.

Rotation side effects (all benign):

- Pending bootstrap idempotency replays are invalidated: a client retrying the same `Idempotency-Key` within the 30-minute claim window gets a new key and a fresh cryptographic login. Re-issue by having the agent bootstrap with a new key.
- Client-IP and email rate-limit hash buckets re-key, so their counters reset (harmless; the global circuits are unaffected).

Rotate any time with `npx wrangler secret put BOOTSTRAP_TOKEN`; secrets take effect immediately and need no redeploy.

## Deployment sequence

1. Export remote D1 and record a Time Travel bookmark using the procedure above.
2. Apply migrations through `0006_abuse_controls.sql` in numeric order.
3. Verify `BOOTSTRAP_TOKEN` remains a Cloudflare secret, not a Wrangler plaintext variable, and is at least 128 bits.
4. Run `npm run typecheck`, `npm test`, `npm audit --omit=dev`, and `npm run cf:check`.
5. Configure the manual edge and billing controls above.
6. Deploy only after reviewing the configured limits for expected pilot traffic.
7. Smoke-test claim, verification, login, logout, agent read/write, cross-workspace denial, and cleanup.

This release changes claim/login capabilities from query-string IDs to fragment tokens. Links issued by the previous deployment are intentionally incompatible; either allow their 20-minute login and 30-minute claim/verification TTLs to expire before rollout, or notify pilot users that outstanding links must be requested again. Authentication and workspace JavaScript is served with mandatory revalidation to prevent stale clients during this transition.

## Residual risks

At the entry ceiling, closing an existing todo/blocker remains available, but Frank omits the additional convenience `done` audit row rather than exceeding the cap. Summary and export responses include `truncated` metadata whenever configured bounds omit data.

Abandoned workspaces transition to `deleting` before capabilities are revoked and Durable Object data is erased. Failed deletions remain retryable; deleted directory tombstones are cascade-deleted after the configured incident-review retention.

A stolen agent token can act within its workspace until revoked, subject to rate and storage limits. A stolen browser session remains useful until logout, revocation, or its 30-day expiry. Distributed abuse can evade per-client limits, which is why edge WAF/rate limiting and account spend alerts remain required.
