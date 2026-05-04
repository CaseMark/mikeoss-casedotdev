#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DOC_DIR="${MIKE_SMOKE_DOC_DIR:-$ROOT_DIR/.mike-dev/smoke-docs}"
BACKEND_PORT="${BACKEND_PORT:-3001}"
FRONTEND_PORT="${FRONTEND_PORT:-3000}"
BACKEND_URL="${MIKE_SMOKE_BACKEND_URL:-http://localhost:${BACKEND_PORT}}"
FRONTEND_URL="${MIKE_SMOKE_FRONTEND_URL:-http://localhost:${FRONTEND_PORT}}"
BACKEND_URL="${BACKEND_URL%/}"
FRONTEND_URL="${FRONTEND_URL%/}"
DRY_RUN=0

REQUIRED_DOCS=(
  "Med-sample.pdf"
  "ilya.pdf"
  "nadeau.pdf"
)

usage() {
  cat <<EOF
Usage: scripts/mike-smoke.sh [--dry-run] [--help]

Runs the local Case.dev Mike smoke test against the running dev services.

What it checks:
  1. Backend and frontend dev services are running.
  2. MIKE_SMOKE_CASE_API_KEY is available in the shell.
  3. Smoke fixtures exist in .mike-dev/smoke-docs/.
  4. A disposable local user can sign up, save the Case key, create a Matter,
     upload fixtures, wait for Vault ingestion, and run representative chat
     prompts for Vault, Skills, Legal, and generated DOCX behavior.

Configured endpoints:
  frontend:  ${FRONTEND_URL}
  backend:   ${BACKEND_URL}
  docs:      ${DOC_DIR}

Environment:
  MIKE_SMOKE_CASE_API_KEY   Required for a real run. The script never prints it.
  MIKE_SMOKE_DOC_DIR        Optional fixture directory override.
  MIKE_SMOKE_BACKEND_URL    Optional backend URL override.
  MIKE_SMOKE_FRONTEND_URL   Optional frontend URL override.
  MIKE_SMOKE_TIMEOUT_MS     Optional ingestion timeout. Default: 900000.

Examples:
  export MIKE_SMOKE_CASE_API_KEY=sk_case_...
  scripts/mike-smoke.sh

  scripts/mike-smoke.sh --dry-run
EOF
}

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      usage
      exit 1
      ;;
  esac
done

echo "Mike Case.dev smoke harness"
echo "  root:      $ROOT_DIR"
echo "  frontend:  $FRONTEND_URL"
echo "  backend:   $BACKEND_URL"
echo "  docs:      $DOC_DIR"
if [[ "$DRY_RUN" == "1" ]]; then
  echo "  mode:      dry run (no signup, uploads, Case calls, or chat prompts)"
else
  echo "  mode:      real smoke run"
fi

echo
echo "Checking local dev services with scripts/mike-dev.sh status..."
"$ROOT_DIR/scripts/mike-dev.sh" status

echo
echo "Checking HTTP readiness..."
if ! curl -fsS "$BACKEND_URL/health" >/dev/null 2>&1; then
  echo "Backend is not ready at $BACKEND_URL/health." >&2
  echo "Start it with: scripts/mike-dev.sh start backend" >&2
  exit 1
fi
echo "  backend health: ok"

if ! curl -fsS "$FRONTEND_URL" >/dev/null 2>&1; then
  echo "Frontend is not ready at $FRONTEND_URL." >&2
  echo "Start it with: scripts/mike-dev.sh start frontend" >&2
  exit 1
fi
echo "  frontend: ok"

echo
echo "Checking smoke fixtures..."
for doc in "${REQUIRED_DOCS[@]}"; do
  path="$DOC_DIR/$doc"
  if [[ ! -f "$path" ]]; then
    echo "Missing smoke fixture: $path" >&2
    exit 1
  fi
  bytes="$(wc -c < "$path" | tr -d ' ')"
  echo "  $doc ($bytes bytes)"
done

if [[ "$DRY_RUN" == "1" ]]; then
  echo
  if [[ -n "${MIKE_SMOKE_CASE_API_KEY:-}" ]]; then
    echo "MIKE_SMOKE_CASE_API_KEY: present (not printed)"
  else
    echo "MIKE_SMOKE_CASE_API_KEY: missing, which is fine for --dry-run"
  fi
  echo "Dry run complete. No records were created."
  exit 0
fi

if [[ -z "${MIKE_SMOKE_CASE_API_KEY:-}" ]]; then
  echo
  echo "MIKE_SMOKE_CASE_API_KEY is required for a real smoke run." >&2
  echo "Export it in your shell, then rerun this script. The key will not be printed or written to disk." >&2
  exit 1
fi

echo
echo "Starting smoke runner..."
cd "$ROOT_DIR/backend"
MIKE_SMOKE_DOC_DIR="$DOC_DIR" \
MIKE_SMOKE_BACKEND_URL="$BACKEND_URL" \
MIKE_SMOKE_FRONTEND_URL="$FRONTEND_URL" \
  npx tsx ../scripts/smoke-case.ts
