#!/usr/bin/env bash
# frank-cloud-post.sh — remote helper for the Frank Cloud (Workers) API.
# Workspace-scoped, agent-authenticated, idempotent writes.
#
# Requires:
#   FRANK_CLOUD_BASE   e.g. https://frank.asterio.io
#   FRANK_CLOUD_WS     workspace id, e.g. wsp_...
#   FRANK_CLOUD_TOKEN  agent credential token, e.g. frank_agent_...
#
# Credentials may also be stored in the XDG config file ~/.config/frank/frankrc
# (a plain shell snippet that exports the three FRANK_CLOUD_* variables). This
# helper sources it automatically, so an agent that has run setup once can rely
# on the file without re-exporting the variables in every shell.
set -euo pipefail

# --- Auto-load XDG credentials (silent; only applies when the file exists) ---
_FRANK_RC="${XDG_CONFIG_HOME:-${HOME:-}/.config}/frank/frankrc"
if [[ -f "$_FRANK_RC" ]]; then
  # shellcheck disable=SC1090
  . "$_FRANK_RC"
fi

usage() {
  cat >&2 <<'USAGE'
Usage:
  frank-cloud-post.sh bootstrap [displayName] [timeZone] [agentLabel] [email]
  frank-cloud-post.sh <note|status|active|todo|blocker|done|decision|session> <text> [project] [tag ...]
  frank-cloud-post.sh close <entry-id>
  frank-cloud-post.sh list [--type TYPE] [--project PROJECT] [--status STATUS] [--limit N]
  frank-cloud-post.sh open
  frank-cloud-post.sh status-view
  frank-cloud-post.sh projects [--all] [--limit N] [--offset N]
  frank-cloud-post.sh history <project>
  frank-cloud-post.sh summary [today|yesterday|YYYY-MM-DD]
  frank-cloud-post.sh project rename <project> <new-name>
  frank-cloud-post.sh project merge <from-project> <to-project>
  frank-cloud-post.sh project archive <project>
  frank-cloud-post.sh project inactive <project>
  frank-cloud-post.sh remote-check
  frank-cloud-post.sh self-test

For bootstrap: only FRANK_CLOUD_BASE is required.
For all other commands: FRANK_CLOUD_BASE, FRANK_CLOUD_WS, and FRANK_CLOUD_TOKEN must be set.
USAGE
}

TYPE="${1:-}"
if [[ -z "$TYPE" ]]; then usage; exit 2; fi
shift

# Bootstrap command — needs only FRANK_CLOUD_BASE.
if [[ "$TYPE" == "bootstrap" ]]; then
  BASE="${FRANK_CLOUD_BASE:-}"
  if [[ -z "$BASE" ]]; then
    echo "FRANK_CLOUD_BASE must be set" >&2
    exit 1
  fi
  BASE="${BASE%/}"
  DISP="${1:-}"
  TIMEZ="${2:-UTC}"
  LABL="${3:-default-agent}"
  EMAIL="${4:-}"
  # This key protects replay of the one-time credential response. Keep it
  # unguessable and reuse it only when retrying this same bootstrap operation.
  IDEM_KEY="${FRANK_BOOTSTRAP_IDEM_KEY:-bootstrap-$(node -e 'process.stdout.write(crypto.randomUUID())')}"
  PAYLOAD="$(node - "$LABL" "$DISP" "$TIMEZ" "$EMAIL" <<'NODE'
const [, , agentLabel, displayName, timeZone, email] = process.argv;
const payload = { agentLabel };
if (displayName) payload.displayName = displayName;
if (timeZone !== "UTC") payload.timeZone = timeZone;
if (email) payload.email = email;
process.stdout.write(JSON.stringify(payload));
NODE
)"
  printf 'Bootstrap retry key: %s\n' "$IDEM_KEY" >&2
  curl -fsS -X POST "${BASE}/v1/workspaces" \
    -H 'Content-Type: application/json' \
    -H "Idempotency-Key: ${IDEM_KEY}" \
    -d "${PAYLOAD}"
  printf '\n'
  exit 0
fi

# All other commands need the full env.
if [[ -z "${FRANK_CLOUD_BASE:-}" || -z "${FRANK_CLOUD_WS:-}" || -z "${FRANK_CLOUD_TOKEN:-}" ]]; then
  echo "FRANK_CLOUD_BASE, FRANK_CLOUD_WS, and FRANK_CLOUD_TOKEN must all be set" >&2
  exit 1
fi

BASE="${FRANK_CLOUD_BASE%/}"
WS="${FRANK_CLOUD_WS}"
TOKEN="${FRANK_CLOUD_TOKEN}"

# A fresh idempotency key per invocation. For retry-safe writes, set FRANK_IDEM_KEY.
IDEM_KEY="${FRANK_IDEM_KEY:-$(uuidgen 2>/dev/null || cat /proc/sys/kernel/random/uuid 2>/dev/null || echo "key-$(date +%s)-$$")}"

urlencode() {
  node -e 'process.stdout.write(encodeURIComponent(process.argv[1] || ""))' "$1"
}

json_entry_payload() {
  local type="$1" text="$2" project="$3"
  shift 3
  local tags_json
  tags_json="$(printf '%s\n' "$@" | node -e 'const fs=require("fs"); const tags=fs.readFileSync(0,"utf8").split(/\n/).filter(Boolean); process.stdout.write(JSON.stringify(tags));')"
  node - "$type" "$text" "$project" "$tags_json" <<'NODE'
const [, , type, text, project, tagsJson] = process.argv;
process.stdout.write(JSON.stringify({
  type, text,
  project: project || undefined,
  tags: JSON.parse(tagsJson || '[]'),
  source: 'frank-cloud-skill'
}));
NODE
}

json_object_payload() {
  node - "$@" <<'NODE'
const args = process.argv.slice(2);
const obj = {};
for (let i = 0; i < args.length; i += 2) {
  const key = args[i];
  const value = args[i + 1];
  if (value !== undefined && value !== '') obj[key] = value;
}
process.stdout.write(JSON.stringify(obj));
NODE
}

api_get() {
  curl -fsS -H "Authorization: Bearer ${TOKEN}" "${BASE}/v1/workspaces/${WS}$1"
}

api_post() {
  local path="$1" payload="$2"
  printf '%s' "$payload" | curl -fsS \
    -H "Authorization: Bearer ${TOKEN}" \
    -H 'Content-Type: application/json' \
    -H "Idempotency-Key: ${IDEM_KEY}" \
    -d @- \
    "${BASE}/v1/workspaces/${WS}${path}"
}

if [[ "$TYPE" == "remote-check" ]]; then
  curl -fsS "${BASE}/health" >/dev/null
  api_get "/open" >/dev/null
  printf 'frank-cloud [remote] check passed: %s (workspace %s)\n' "${BASE}" "${WS}"
  exit 0
fi

if [[ "$TYPE" == "self-test" ]]; then
  MARKER="frank-cloud-selftest-$(date +%s)-$$"
  TEXT="Frank Cloud self-test at $(date -u +%Y-%m-%dT%H:%M:%SZ) marker=${MARKER}"
  IDEM_KEY="selftest-${IDEM_KEY}" api_post "/entries" "$(json_entry_payload note "$TEXT" 'Frank Cloud Self Test' selftest)"
  RESP="$(api_get "/entries?project=$(urlencode 'Frank Cloud Self Test')&limit=5")"
  if printf '%s' "$RESP" | grep -q "$MARKER"; then
    printf 'frank-cloud [remote] self-test passed: marker %s verified\n' "$MARKER"
    exit 0
  fi
  echo "frank-cloud [remote] self-test FAILED: marker not found" >&2
  exit 1
fi

if [[ "$TYPE" == "list" ]]; then
  FILTERS=()
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --type|--project|--status|--limit)
        [[ -n "${2:-}" ]] || { usage; exit 2; }
        FILTERS+=("${1#--}=$(urlencode "$2")")
        shift 2 ;;
      *) usage; exit 2 ;;
    esac
  done
  QUERY=""
  if [[ ${#FILTERS[@]} -gt 0 ]]; then QUERY="?$(IFS='&'; echo "${FILTERS[*]}")"; fi
  api_get "/entries${QUERY}"
  printf '\n'
  exit 0
fi

if [[ "$TYPE" == "open" ]]; then
  api_get "/open"; printf '\n'; exit 0
fi

if [[ "$TYPE" == "status-view" ]]; then
  api_get "/status"; printf '\n'; exit 0
fi

if [[ "$TYPE" == "projects" ]]; then
  FILTERS=()
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --all)
        FILTERS+=("all=true")
        shift
        ;;
      --limit|--offset)
        [[ -n "${2:-}" ]] || { usage; exit 2; }
        FILTERS+=("${1#--}=$(urlencode "$2")")
        shift 2
        ;;
      *) usage; exit 2 ;;
    esac
  done
  QUERY=""
  if [[ ${#FILTERS[@]} -gt 0 ]]; then QUERY="?$(IFS='&'; echo "${FILTERS[*]}")"; fi
  api_get "/projects${QUERY}"
  printf '\n'; exit 0
fi

if [[ "$TYPE" == "history" ]]; then
  PROJECT="${1:-}"
  [[ -n "$PROJECT" ]] || { usage; exit 2; }
  api_get "/projects/$(urlencode "$PROJECT")/entries"
  printf '\n'; exit 0
fi

if [[ "$TYPE" == "summary" ]]; then
  DATE="${1:-today}"
  api_get "/summary?date=$(urlencode "$DATE")"
  printf '\n'; exit 0
fi

if [[ "$TYPE" == "close" ]]; then
  ID="${1:-}"
  [[ -n "$ID" ]] || { usage; exit 2; }
  echo "Close is a human action (same-origin, browser session). Agents cannot close loops." >&2
  exit 2
fi

if [[ "$TYPE" == "project" ]]; then
  SUB="${1:-}"
  [[ -n "$SUB" ]] || { usage; exit 2; }
  shift
  case "$SUB" in
    rename)
      PROJECT="${1:-}"; NAME="${2:-}"
      [[ -n "$PROJECT" && -n "$NAME" ]] || { usage; exit 2; }
      api_post "/projects/rename" "$(json_object_payload nameOrAlias "$PROJECT" newName "$NAME")"
      ;;
    merge)
      FROM="${1:-}"; TO="${2:-}"
      [[ -n "$FROM" && -n "$TO" ]] || { usage; exit 2; }
      api_post "/projects/merge" "$(json_object_payload fromNameOrAlias "$FROM" toNameOrAlias "$TO")"
      ;;
    archive)
      PROJECT="${1:-}"
      [[ -n "$PROJECT" ]] || { usage; exit 2; }
      api_post "/projects/archive" "$(json_object_payload nameOrAlias "$PROJECT")"
      ;;
    inactive)
      PROJECT="${1:-}"
      [[ -n "$PROJECT" ]] || { usage; exit 2; }
      api_post "/projects/inactive" "$(json_object_payload nameOrAlias "$PROJECT")"
      ;;
    *) usage; exit 2 ;;
  esac
  printf '\n'
  exit 0
fi

TEXT="${1:-}"
PROJECT="${2:-}"
if [[ $# -ge 2 ]]; then shift 2; else shift $#; fi

if [[ -z "$TEXT" ]]; then usage; exit 2; fi

case "$TYPE" in
  note|status|active|todo|blocker|done|decision|session) ;;
  *) usage; exit 2 ;;
esac

api_post "/entries" "$(json_entry_payload "$TYPE" "$TEXT" "$PROJECT" "$@")"
printf '\n'
