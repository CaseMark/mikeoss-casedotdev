#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_DIR="${MIKE_DEV_STATE_DIR:-$ROOT_DIR/.mike-dev}"

BACKEND_PORT="${BACKEND_PORT:-3001}"
FRONTEND_PORT="${FRONTEND_PORT:-3000}"

mkdir -p "$STATE_DIR"

usage() {
  cat <<EOF
Usage: scripts/mike-dev.sh <start|stop|restart|status|logs> [service]

Services:
  backend   Express API on http://localhost:${BACKEND_PORT}
  frontend  Next.js app on http://localhost:${FRONTEND_PORT}
  all       Both services (default)

Examples:
  scripts/mike-dev.sh start
  scripts/mike-dev.sh restart backend
  scripts/mike-dev.sh status
  scripts/mike-dev.sh logs frontend

Environment overrides:
  BACKEND_PORT=4001 scripts/mike-dev.sh restart backend
  FRONTEND_PORT=4000 scripts/mike-dev.sh restart frontend
  MIKE_DEV_STATE_DIR=/tmp/mike-dev scripts/mike-dev.sh start
EOF
}

service_pid_file() {
  echo "$STATE_DIR/$1.pid"
}

service_log_file() {
  echo "$STATE_DIR/$1.log"
}

service_session_name() {
  echo "mike-dev-$1"
}

service_role() {
  case "$1" in
    backend) echo "Express API, auth, document processing, Case.dev sync" ;;
    frontend) echo "Next.js web app" ;;
    *) return 1 ;;
  esac
}

service_port() {
  case "$1" in
    backend) echo "$BACKEND_PORT" ;;
    frontend) echo "$FRONTEND_PORT" ;;
    *) return 1 ;;
  esac
}

port_listener_pid() {
  local port="$1"
  lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null | head -n 1 || true
}

service_base_url() {
  case "$1" in
    backend) echo "http://localhost:${BACKEND_PORT}" ;;
    frontend) echo "http://localhost:${FRONTEND_PORT}" ;;
    *) return 1 ;;
  esac
}

is_running() {
  local pid="$1"
  [[ -n "$pid" ]] && kill -0 "$pid" >/dev/null 2>&1
}

screen_available() {
  command -v screen >/dev/null 2>&1
}

screen_session_pid() {
  local service="$1"
  local session
  session="$(service_session_name "$service")"
  screen_available || return 0
  screen -ls 2>/dev/null | awk -v session="$session" '
    $1 ~ ("[.]" session "$") {
      split($1, parts, ".")
      print parts[1]
      exit
    }
  '
}

screen_running() {
  local service="$1"
  [[ -n "$(screen_session_pid "$service")" ]]
}

service_running() {
  local service="$1"
  local pid="$2"
  screen_running "$service" || is_running "$pid"
}

read_pid() {
  local file
  file="$(service_pid_file "$1")"
  [[ -f "$file" ]] && cat "$file" || true
}

kill_tree() {
  local pid="$1"
  local child

  while read -r child; do
    [[ -n "$child" ]] && kill_tree "$child"
  done < <(pgrep -P "$pid" 2>/dev/null || true)

  kill "$pid" >/dev/null 2>&1 || true
}

service_url() {
  case "$1" in
    backend) echo "http://localhost:${BACKEND_PORT}/health" ;;
    frontend) echo "http://localhost:${FRONTEND_PORT}" ;;
    *) return 1 ;;
  esac
}

service_workdir() {
  case "$1" in
    backend) echo "$ROOT_DIR/backend" ;;
    frontend) echo "$ROOT_DIR/frontend" ;;
    *) return 1 ;;
  esac
}

service_env_file() {
  case "$1" in
    backend) echo "$ROOT_DIR/backend/.env" ;;
    frontend) echo "$ROOT_DIR/frontend/.env.local" ;;
    *) return 1 ;;
  esac
}

service_command() {
  case "$1" in
    backend) echo "PORT=${BACKEND_PORT} FRONTEND_URL=http://localhost:${FRONTEND_PORT} npm run dev" ;;
    frontend) echo "npm run dev -- --port ${FRONTEND_PORT}" ;;
    *) return 1 ;;
  esac
}

run_service_in_foreground() {
  local service="$1"
  case "$service" in
    backend)
      cd "$ROOT_DIR/backend"
      exec env PORT="$BACKEND_PORT" FRONTEND_URL="http://localhost:${FRONTEND_PORT}" npm run dev
      ;;
    frontend)
      cd "$ROOT_DIR/frontend"
      exec npm run dev -- --port "$FRONTEND_PORT"
      ;;
    *)
      echo "Unknown service: $service" >&2
      exit 1
      ;;
  esac
}

start_service_process() {
  local service="$1"
  local log_file="$2"
  local session
  session="$(service_session_name "$service")"

  if screen_available; then
    SERVICE="$service" \
      ROOT_DIR="$ROOT_DIR" \
      BACKEND_PORT="$BACKEND_PORT" \
      FRONTEND_PORT="$FRONTEND_PORT" \
      LOG_FILE="$log_file" \
      screen -dmS "$session" bash -c '
        cd "$ROOT_DIR"
        exec scripts/mike-dev.sh __run_service "$SERVICE" >>"$LOG_FILE" 2>&1
      '
    sleep 0.2
    screen_session_pid "$service"
    return 0
  fi

  ROOT_DIR="$ROOT_DIR" \
    BACKEND_PORT="$BACKEND_PORT" \
    FRONTEND_PORT="$FRONTEND_PORT" \
    nohup bash -c \
    'cd "$1" && exec scripts/mike-dev.sh __run_service "$2"' \
    _ "$ROOT_DIR" "$service" \
    >"$log_file" 2>&1 < /dev/null &
  echo "$!"
}

service_ready() {
  local service="$1"
  curl -fsS "$(service_url "$service")" >/dev/null 2>&1
}

env_file_value() {
  local file="$1"
  local key="$2"
  [[ -f "$file" ]] || return 0
  grep -E "^${key}=" "$file" 2>/dev/null | tail -n 1 | cut -d= -f2- || true
}

env_required_keys() {
  case "$1" in
    backend)
      echo "DATABASE_URL BETTER_AUTH_SECRET CASE_KEY_ENCRYPTION_SECRET"
      ;;
    frontend)
      echo "NEXT_PUBLIC_API_BASE_URL"
      ;;
    *) return 1 ;;
  esac
}

env_required_issues() {
  local service="$1"
  local file="$2"
  local key value
  [[ -f "$file" ]] || return 0

  for key in $(env_required_keys "$service"); do
    value="$(env_file_value "$file" "$key")"
    if [[ -z "$value" ]] || [[ "$value" =~ your-|your_|generate-a-32-byte-random-secret|REPLACE_ME|changeme|postgres://user:password@host ]]; then
      echo "$key"
    fi
  done
}

env_placeholder_state() {
  local service="$1"
  local file="$2"
  if [[ ! -f "$file" ]]; then
    echo "(missing)"
  elif [[ -n "$(env_required_issues "$service" "$file")" ]]; then
    echo "(present, needs values)"
  else
    echo "(present)"
  fi
}

generated_secret() {
  node -e 'console.log(require("crypto").randomBytes(32).toString("base64url"))'
}

ensure_backend_env() {
  local env_file="$ROOT_DIR/backend/.env"
  [[ -f "$env_file" ]] && return 0

  local case_secret
  case_secret="$(generated_secret)"

  cat >"$env_file" <<EOF
# Created by scripts/mike-dev.sh for local development.
  # Replace the Case DB placeholder before testing signup, uploads, downloads,
  # document processing, or Case.dev vault storage/search.
PORT=${BACKEND_PORT}
FRONTEND_URL=http://localhost:${FRONTEND_PORT}

DATABASE_URL=postgres://user:password@host/database?sslmode=require
CASE_DATABASE_PROJECT_ID=db_your-case-database-project-id
CASE_DATABASE_BRANCH=main

BETTER_AUTH_URL=http://localhost:${BACKEND_PORT}
BETTER_AUTH_SECRET=${case_secret}
BETTER_AUTH_TRUSTED_ORIGINS=http://localhost:${FRONTEND_PORT}

CASE_API_BASE_URL=https://api.case.dev
CASE_KEY_ENCRYPTION_SECRET=${case_secret}
CASE_DEFAULT_MAIN_MODEL=casemark/core-large
CASE_DEFAULT_TITLE_MODEL=casemark/core-large
CASE_DEFAULT_TABULAR_MODEL=casemark/core-large

# Optional legacy/fallback provider keys.
GEMINI_API_KEY=your-gemini-key
ANTHROPIC_API_KEY=your-anthropic-key
OPENROUTER_API_KEY=your-openrouter-key
RESEND_API_KEY=your-resend-key
EOF

  echo "Created backend env file: $env_file"
}

ensure_frontend_env() {
  local env_file="$ROOT_DIR/frontend/.env.local"
  [[ -f "$env_file" ]] && return 0

  ensure_backend_env

  cat >"$env_file" <<EOF
# Created by scripts/mike-dev.sh for local development.
# The frontend talks to the Express/Better Auth backend here.
NEXT_PUBLIC_API_BASE_URL=http://localhost:${BACKEND_PORT}
EOF

  echo "Created frontend env file: $env_file"
}

print_env_guidance() {
  cat <<EOF

Local env checklist
  backend/.env:
    Required for auth/database: DATABASE_URL, BETTER_AUTH_SECRET
    Optional Case DB metadata: CASE_DATABASE_PROJECT_ID, CASE_DATABASE_BRANCH
    Required for Case key encryption: CASE_KEY_ENCRYPTION_SECRET
    Case API keys are normally saved per user in /account/models and power
    LLM routing plus canonical Case Vault document storage.
    Optional only for legacy migration: R2_ENDPOINT_URL, R2_ACCESS_KEY_ID,
    R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME.

  frontend/.env.local:
    Required for API calls: NEXT_PUBLIC_API_BASE_URL=http://localhost:${BACKEND_PORT}

  If any env file says "(present, needs values)" in status, replace placeholder
  values before testing login, uploads, downloads, or vault sync.
  Restart services after changing env files.
EOF
}

print_runtime_summary() {
  cat <<EOF
Mike local dev configuration
  root:      $ROOT_DIR
  state:     $STATE_DIR
  frontend:  http://localhost:${FRONTEND_PORT}
  backend:   http://localhost:${BACKEND_PORT}
  health:    http://localhost:${BACKEND_PORT}/health
EOF
}

print_connect_summary() {
  cat <<EOF

How to connect
  app:      http://localhost:${FRONTEND_PORT}
  backend:  http://localhost:${BACKEND_PORT}
  health:   http://localhost:${BACKEND_PORT}/health

Useful commands
  scripts/mike-dev.sh status
  scripts/mike-dev.sh logs frontend
  scripts/mike-dev.sh logs backend
  scripts/mike-dev.sh stop
EOF
  print_env_guidance
}

wait_for_service() {
  local service="$1"
  local url
  url="$(service_url "$service")"

  for _ in $(seq 1 40); do
    if service_ready "$service"; then
      echo "  readiness: ready at $url"
      return 0
    fi
    sleep 0.5
  done

  echo "  readiness: not ready yet at $url"
  echo "  next step: tail the log with scripts/mike-dev.sh logs $service"
}

preflight_service() {
  local service="$1"

  case "$service" in
    backend)
      if [[ ! -d "$ROOT_DIR/backend/node_modules" ]]; then
        echo "Missing backend/node_modules. Run: npm install --prefix backend" >&2
        exit 1
      fi
      ensure_backend_env
      ;;
    frontend)
      if [[ ! -d "$ROOT_DIR/frontend/node_modules" ]]; then
        echo "Missing frontend/node_modules. Run: npm install --prefix frontend" >&2
        exit 1
      fi
      ensure_frontend_env
      ;;
  esac
}

start_service() {
  local service="$1"
  local pid_file log_file pid
  pid_file="$(service_pid_file "$service")"
  log_file="$(service_log_file "$service")"
  pid="$(read_pid "$service")"

  preflight_service "$service"

  if service_running "$service" "$pid"; then
    echo
    echo "$service is already running"
    echo "  launcher: $(screen_available && echo "screen session $(service_session_name "$service")" || echo "background process")"
    echo "  pid:      ${pid:-$(screen_session_pid "$service")}"
    echo "  url:  $(service_base_url "$service")"
    echo "  log:  $log_file"
    wait_for_service "$service"
    return 0
  fi

  rm -f "$pid_file"
  : >"$log_file"

  local listener_pid
  listener_pid="$(port_listener_pid "$(service_port "$service")")"
  if [[ -n "$listener_pid" ]]; then
    echo
    echo "Cannot start $service because port $(service_port "$service") is already in use"
    echo "  listener pid: $listener_pid"
    echo "  url:          $(service_base_url "$service")"
    echo "  next step:    stop that process or choose a different port"
    echo "                FRONTEND_PORT=4000 scripts/mike-dev.sh start frontend"
    echo "                BACKEND_PORT=4001 scripts/mike-dev.sh start backend"
    exit 1
  fi

  echo
  echo "Starting $service"
  echo "  role:      $(service_role "$service")"
  echo "  port:      $(service_port "$service")"
  echo "  url:       $(service_base_url "$service")"
  echo "  ready url: $(service_url "$service")"
  echo "  workdir:   $(service_workdir "$service")"
  echo "  env:       $(service_env_file "$service")"
  echo "  log:       $log_file"
  echo "  pid file:  $pid_file"
  echo "  command:   $(service_command "$service")"

  pid="$(start_service_process "$service" "$log_file")"
  echo "$pid" >"$pid_file"
  echo "  launcher:  $(screen_available && echo "screen session $(service_session_name "$service")" || echo "background process")"
  echo "  pid:       ${pid:-unknown}"
  wait_for_service "$service"
}

stop_service() {
  local service="$1"
  local pid_file pid listener_pid
  pid_file="$(service_pid_file "$service")"
  pid="$(read_pid "$service")"
  listener_pid="$(port_listener_pid "$(service_port "$service")")"

  if ! service_running "$service" "$pid"; then
    rm -f "$pid_file"
    if [[ -n "$listener_pid" ]]; then
      echo
      echo "Stopping unmanaged $service listener"
      echo "  port: $(service_port "$service")"
      echo "  pid:  $listener_pid"
      echo "  log:  $(service_log_file "$service")"

      kill_tree "$listener_pid"
      for _ in $(seq 1 20); do
        listener_pid="$(port_listener_pid "$(service_port "$service")")"
        if [[ -z "$listener_pid" ]]; then
          echo "  stopped"
          return 0
        fi
        sleep 0.25
      done

      listener_pid="$(port_listener_pid "$(service_port "$service")")"
      if [[ -n "$listener_pid" ]]; then
        kill -9 "$listener_pid" >/dev/null 2>&1 || true
      fi
      echo "  stopped"
      return 0
    fi

    echo
    echo "$service is not running"
    echo "  pid file: $pid_file"
    echo "  log:      $(service_log_file "$service")"
    return 0
  fi

  echo
  echo "Stopping $service"
  echo "  launcher: $(screen_running "$service" && echo "screen session $(service_session_name "$service")" || echo "background process")"
  echo "  pid: ${pid:-$(screen_session_pid "$service")}"
  echo "  log: $(service_log_file "$service")"

  if screen_running "$service"; then
    screen -S "$(service_session_name "$service")" -X quit >/dev/null 2>&1 || true
  elif is_running "$pid"; then
    kill_tree "$pid"
  fi
  if [[ -n "$listener_pid" ]]; then
    kill_tree "$listener_pid"
  fi

  for _ in $(seq 1 20); do
    listener_pid="$(port_listener_pid "$(service_port "$service")")"
    if ! service_running "$service" "$pid" && [[ -z "$listener_pid" ]]; then
      rm -f "$pid_file"
      echo "  stopped"
      return 0
    fi
    sleep 0.25
  done

  if screen_running "$service"; then
    screen -S "$(service_session_name "$service")" -X quit >/dev/null 2>&1 || true
  elif is_running "$pid"; then
    kill -9 "$pid" >/dev/null 2>&1 || true
  fi
  listener_pid="$(port_listener_pid "$(service_port "$service")")"
  if [[ -n "$listener_pid" ]]; then
    kill -9 "$listener_pid" >/dev/null 2>&1 || true
  fi
  rm -f "$pid_file"
  echo "  stopped"
}

status_service() {
  local service="$1"
  local pid pid_file log_file env_file listener_pid env_issues
  pid="$(read_pid "$service")"
  pid_file="$(service_pid_file "$service")"
  log_file="$(service_log_file "$service")"
  env_file="$(service_env_file "$service")"
  listener_pid="$(port_listener_pid "$(service_port "$service")")"
  env_issues="$(env_required_issues "$service" "$env_file" | paste -sd "," - | sed 's/,/, /g')"

  echo
  echo "$service"
  echo "  role:      $(service_role "$service")"
  echo "  port:      $(service_port "$service")"
  echo "  url:       $(service_base_url "$service")"
  echo "  ready url: $(service_url "$service")"
  echo "  workdir:   $(service_workdir "$service")"
  echo "  env:       $env_file $(env_placeholder_state "$service" "$env_file")"
  if [[ -n "$env_issues" ]]; then
    echo "  env todo:  replace required values for $env_issues"
  fi
  echo "  pid file:  $pid_file"
  echo "  log:       $log_file"
  echo "  command:   $(service_command "$service")"

  if service_running "$service" "$pid"; then
    if screen_running "$service"; then
      echo "  launcher:  screen session $(service_session_name "$service")"
      echo "  process:   running pid=$(screen_session_pid "$service")"
    else
      echo "  launcher:  background process"
      echo "  process:   running pid=$pid"
    fi
    if service_ready "$service"; then
      echo "  readiness: ready"
    else
      echo "  readiness: not responding yet"
    fi
    if [[ -n "$listener_pid" ]]; then
      echo "  listener:  pid=$listener_pid"
    fi
  else
    if [[ -n "$listener_pid" ]]; then
      echo "  process:   unmanaged listener pid=$listener_pid"
      echo "  readiness: ready, but not managed by this script"
    elif [[ -n "$pid" ]]; then
      echo "  process:   stopped (stale pid=$pid)"
      echo "  readiness: stopped"
    else
      echo "  process:   stopped"
      echo "  readiness: stopped"
    fi
  fi

  if [[ -s "$log_file" ]]; then
    local last_line
    last_line="$(grep -v '^[[:space:]]*$' "$log_file" | tail -n 1 || true)"
    if [[ -n "$last_line" ]]; then
      echo "  last log:  $last_line"
    fi
  fi
}

logs_service() {
  local service="$1"
  local log_file
  log_file="$(service_log_file "$service")"

  if [[ ! -f "$log_file" ]]; then
    echo "No log file yet for $service: $log_file"
    return 0
  fi

  tail -n 80 -f "$log_file"
}

expand_services() {
  local target="${1:-all}"
  case "$target" in
    all) echo "backend frontend" ;;
    backend|frontend) echo "$target" ;;
    *)
      echo "Unknown service: $target" >&2
      exit 1
      ;;
  esac
}

command="${1:-}"
target="${2:-all}"

if [[ "$command" == "__run_service" ]]; then
  run_service_in_foreground "$target"
fi

if [[ -z "$command" || "$command" == "-h" || "$command" == "--help" ]]; then
  usage
  exit 0
fi

services="$(expand_services "$target")"

case "$command" in
  start)
    print_runtime_summary
    for service in $services; do start_service "$service"; done
    print_connect_summary
    ;;
  stop)
    for service in $services; do stop_service "$service"; done
    ;;
  restart)
    print_runtime_summary
    for service in $services; do stop_service "$service"; done
    for service in $services; do start_service "$service"; done
    print_connect_summary
    ;;
  status)
    print_runtime_summary
    for service in $services; do status_service "$service"; done
    print_env_guidance
    ;;
  logs)
    if [[ "$target" == "all" ]]; then
      echo "Choose one service for logs: backend or frontend" >&2
      exit 1
    fi
    logs_service "$target"
    ;;
  *)
    usage
    exit 1
    ;;
esac
