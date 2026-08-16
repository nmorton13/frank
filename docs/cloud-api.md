# Frank Cloud HTTP API

Frank Cloud is a hosted service on Cloudflare Workers. Responses containing private data use `Cache-Control: no-store` and all routes receive the configured security headers.

## Bootstrap and capability handling

`POST /v1/workspaces` is public when `BOOTSTRAP_TOKEN` is configured and no `Bootstrap-Token` header is supplied. It requires JSON plus a high-entropy `Idempotency-Key`. A valid `Bootstrap-Token` selects operator provisioning. The response contains a workspace ID, agent credential, and one-time claim capability. An optional `email` field emails the human a one-time claim/verification link (Workers Paid plan required) so they can claim the private dashboard without opening the claim URL; the `claim.url` is still returned as a fallback.

Claim and email magic-link URLs store their capability after `#token=`. URL fragments are not sent in HTTP request targets. The same-origin page script removes the fragment from browser history and exchanges it through JSON POST. Database row IDs are metadata only and cannot redeem a capability.

| Method | Route | Authentication / purpose |
| --- | --- | --- |
| `POST` | `/v1/workspaces` | Public/operator bootstrap; idempotency key required. |
| `GET` | `/claim#token=…` | Claim form; fragment processed in browser. |
| `POST` | `/v1/claims` | `{"claimToken":"…","email":"…"}`; sends verification email. |
| `GET` | `/verify#token=…` | Verification page; fragment processed in browser. |
| `POST` | `/v1/claim-sessions` | `{"verificationToken":"…"}`; sets an HTTP-only session cookie. |
| `POST` | `/v1/login-links` | `{"email":"…"}`; always returns a non-enumerating acceptance response. |
| `GET` | `/login#token=…` | Login page or magic-link exchange page. |
| `POST` | `/v1/login-sessions` | `{"loginToken":"…"}`; sets an HTTP-only session cookie. |
| `POST` | `/v1/logout` | Same-origin request; revokes current session and expires cookie. |

Claim, verification, and login capabilities are one-time and expire. Agent and session tokens are stored only as hashes.

## Agent API

Every route below requires `Authorization: Bearer <agent token>` and is bound to `{workspaceId}`. Mutations also require `Idempotency-Key`.

| Method | Route |
| --- | --- |
| `POST`, `GET` | `/v1/workspaces/{workspaceId}/entries` |
| `POST`, `GET` | `/v1/workspaces/{workspaceId}/projects` |
| `POST` | `/v1/workspaces/{workspaceId}/projects/rename` |
| `POST` | `/v1/workspaces/{workspaceId}/projects/merge` |
| `POST` | `/v1/workspaces/{workspaceId}/projects/archive` |
| `POST` | `/v1/workspaces/{workspaceId}/projects/inactive` |
| `PATCH` | `/v1/workspaces/{workspaceId}/entries/{entryId}/close` | Close an open todo/blocker. |
| `GET` | `/v1/workspaces/{workspaceId}/open` |
| `GET` | `/v1/workspaces/{workspaceId}/status` |
| `GET` | `/v1/workspaces/{workspaceId}/projects/{name}/entries` |
| `GET` | `/v1/workspaces/{workspaceId}/summary` |

Project listing accepts `limit=1..200`, `offset=0..10000`, and `all=true`. Entry listing accepts at most 100 rows and returns `{entries, truncated}`. Open-loop listing uses the same page shape. Project-history and status responses add truthful `truncated` metadata when their conservative row or whole-response byte budgets omit data. Summary responses preserve `date`, `body`, `mode`, and `entries`, and add `truncated.sourceEntries`, `truncated.responseEntries`, and `truncated.body` so callers can detect every configured truncation. Requests, writes, stored entries/projects/aliases/events, summary rows, and whole summary output are constrained by the variables listed in `cloud-security-operations.md`.

Summary generation uses a lean projection: `entries[].structuredJson` is `{}` in summary responses because the potentially large structured payload is intentionally not selected. Retrieve an individual entry page when structured data is needed.

## Human API

The private dashboard and human API require the `frank_session` cookie. Ownership is checked against the requested workspace on every request.

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/w/{workspaceId}` | Private dashboard. |
| `GET` | `/w/{workspaceId}/projects/{name}/entries` | Private project history. |
| `PATCH` | `/v1/workspaces/{workspaceId}/entries/{entryId}/close` | Same-origin open-loop completion. |
| `POST` | `/v1/workspaces/{workspaceId}/agent-credentials` | Same-origin mint a new agent credential; returns a single-use setup link. |
| `GET` | `/v1/workspaces/{workspaceId}/agent-credentials` | Same-origin list agent credentials (label, prefix, status — never the token). |
| `POST` | `/v1/workspaces/{workspaceId}/agent-credentials/{credentialId}/revoke` | Same-origin agent revocation. |
| `GET` | `/v1/workspaces/{workspaceId}/export` | Bounded export with per-collection `truncated` flags. |
| `GET` | `/v1/workspaces/{workspaceId}/export?full=1` | Full untruncated portable dump (agent bearer read scope, or owner human session). |

No workspace route accepts a token/session belonging only to another workspace owner. One verified user may own up to the configured workspace ceiling.

## Multi-agent provisioning

A claimed workspace can have many agents writing to it concurrently, each with its own credential and label. From the dashboard, click **Agents** to mint a new credential, list existing ones (label, prefix, status — never the token), and revoke any credential individually without affecting the others. Minting and listing require an owner session and a same-origin request; revocation uses the `POST …/agent-credentials/{id}/revoke` route above.

| Method | Route | Purpose |
| --- | --- | --- |
| `POST` | `/v1/workspaces/{workspaceId}/agent-credentials` | Owner mints a credential (label required). Returns `{provision:{credential:{id,label,prefix,scopes},setup:{id,token,prefix,expiresAt,url}}}` — the setup `url` is a **single-use** link shown once. |
| `GET` | `/v1/workspaces/{workspaceId}/agent-credentials` | Owner lists credentials `{credentials:[{id,label,prefix,scopes,status,lastUsedAt,createdAt}]}`. Never returns a token. |
| `GET` | `/a/{setupToken}` | **Public, agent-facing.** Redeem a setup link once → returns `{base,workspaceId,credentialId,token,prefix,label,scopes}`. The write token is never stored; it is derived at redeem. Second redeem (or expired/revoked) → 410. |

Setup links are short-lived (60 minutes) and single-use. The provisioned write credential is long-lived until revoked. Each agent should persist its own `FRANK_PROFILE` (see the skill) so its future helper calls load the right credential — never set it in a shared global shell file.

## Share API

A workspace owner can create a **read-only** dashboard share link. The share token is returned once in plaintext and stored only as a SHA-256 hash. It authorizes only the read-only shared dashboard view — it can never close loops, revoke credentials, or export data. The owner can revoke a share token at any time, which immediately invalidates the link.

The owner dashboard exposes this through a **Share** button in the header. It opens a drawer to create a link, copy the freshly-minted URL, list active tokens, and revoke them. The full share URL is a capability shown only once at creation; the list endpoint returns each token's `prefix` and `expiresAt` for display, not the full URL.

| Method | Route | Purpose |
| --- | --- | --- |
| `POST` | `/v1/workspaces/{workspaceId}/share` | Create a share token (owner-only, same-origin). Returns `{share:{id,prefix,expiresAt,url}}`. |
| `GET` | `/v1/workspaces/{workspaceId}/share` | List active share tokens (owner-only). Returns `{tokens:[{id,prefix,createdAt,expiresAt}]}` — prefix only, never the full URL. |
| `POST` | `/v1/workspaces/{workspaceId}/share/{shareTokenId}/revoke` | Revoke a share token (owner-only, same-origin). |
| `GET` | `/s/{shareToken}` | Read-only shared dashboard view (share-token authenticated). |

Share tokens expire after 30 days by default and are stored hashed. Revoking a token sets `revoked_at`, so the link returns 401 immediately.
