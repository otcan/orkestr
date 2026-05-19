#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Reset Orkestr host-native VPS state while preserving host configuration.

Usage:
  scripts/reset-vps-state.sh [--no-stop-service] [--check-only]

Environment:
  ORKESTR_ENV_FILE             Environment file. Defaults to /etc/orkestr/orkestr.env.
  ORKESTR_HOME                 Data directory to reset. Defaults to /opt/orkestr/data.
  ORKESTR_RUNTIME_WORKSPACE_ROOT  Workspace root to reset. Defaults to /opt/orkestr/workspace.
  ORKESTR_WORKSPACE_DIR        Workspace root fallback.
  ORKESTR_OVERLAY_DIR          Overlay directory. Defaults to /opt/orkestr/overlay.
  ORKESTR_RESET_OVERLAY        Reset overlay directory when set to 1. Defaults to 0.
  ORKESTR_SERVICE_NAME         systemd service name. Defaults to orkestr.
  ORKESTR_RUN_USER             Service user. Defaults to orkestr.
  ORKESTR_RESET_KILL_TMUX      Kill orkestr-* tmux sessions during reset. Defaults to 1.
  ORKESTR_RESET_ALLOW_ANY_PATH Allow non-standard reset paths. Defaults to 0.
  ORKESTR_RESET_SKIP_CODEX_LOGIN  Skip Codex API-key login after reset. Defaults to 0.
USAGE
}

stop_service=1
check_only=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --no-stop-service)
      stop_service=0
      shift
      ;;
    --check-only)
      check_only=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

have() {
  command -v "$1" >/dev/null 2>&1
}

load_env() {
  local env_file
  env_file="${ORKESTR_ENV_FILE:-/etc/orkestr/orkestr.env}"
  if [ -r "$env_file" ]; then
    set -a
    # shellcheck disable=SC1090
    . "$env_file"
    set +a
  fi
}

abs_path() {
  if have realpath; then
    realpath -m "$1"
  else
    python3 -c 'import os,sys; print(os.path.abspath(sys.argv[1]))' "$1"
  fi
}

path_is_inside() {
  local child parent
  child="$1"
  parent="$2"
  [ "$child" = "$parent" ] || case "$child" in "$parent"/*) return 0 ;; *) return 1 ;; esac
}

safe_reset_path() {
  local raw label path app_path env_dir
  raw="$1"
  label="$2"
  if [ -z "$raw" ]; then
    echo "$label is empty; refusing reset." >&2
    exit 1
  fi
  path="$(abs_path "$raw")"
  app_path="$(abs_path "${ORKESTR_APP_DIR:-/opt/orkestr/app}")"
  env_dir="$(abs_path "$(dirname "${ORKESTR_ENV_FILE:-/etc/orkestr/orkestr.env}")")"

  case "$path" in
    /|/bin|/boot|/dev|/etc|/home|/lib|/lib64|/opt|/proc|/root|/run|/sbin|/srv|/sys|/tmp|/usr|/var|/data)
      echo "$label points at unsafe path: $path" >&2
      exit 1
      ;;
  esac
  if path_is_inside "$path" "$app_path"; then
    echo "$label points inside the app checkout; refusing reset: $path" >&2
    exit 1
  fi
  if path_is_inside "$path" "$env_dir"; then
    echo "$label points inside the env directory; refusing reset: $path" >&2
    exit 1
  fi
  if [ "${ORKESTR_RESET_ALLOW_ANY_PATH:-0}" != "1" ]; then
    case "$path" in
      /opt/orkestr/*|/var/lib/orkestr/*|/srv/orkestr/*) ;;
      *)
        echo "$label must be under /opt/orkestr, /var/lib/orkestr, or /srv/orkestr. Set ORKESTR_RESET_ALLOW_ANY_PATH=1 for tests." >&2
        exit 1
        ;;
    esac
  fi
  printf '%s' "$path"
}

service_user() {
  local user
  user="${ORKESTR_RUN_USER:-}"
  if [ -z "$user" ] && have systemctl; then
    user="$(systemctl show -p User --value "${ORKESTR_SERVICE_NAME:-orkestr}.service" 2>/dev/null || true)"
  fi
  printf '%s' "${user:-orkestr}"
}

run_as_service_user() {
  local user home_dir
  user="$1"
  shift
  if [ "$(id -u)" -eq 0 ] && id "$user" >/dev/null 2>&1; then
    home_dir="$(getent passwd "$user" | cut -d: -f6)"
    runuser -u "$user" --preserve-environment -- env \
      HOME="${home_dir:-$home_path}" \
      USER="$user" \
      LOGNAME="$user" \
      "$@"
  else
    "$@"
  fi
}

kill_orkestr_tmux_sessions() {
  local user sessions session
  user="$1"
  if ! have tmux; then
    return 0
  fi
  sessions="$(run_as_service_user "$user" tmux list-sessions -F '#S' 2>/dev/null || true)"
  while IFS= read -r session; do
    case "$session" in
      orkestr-*) run_as_service_user "$user" tmux kill-session -t "$session" 2>/dev/null || true ;;
    esac
  done <<< "$sessions"
}

chown_if_root() {
  local user target group
  user="$1"
  target="$2"
  if [ "$(id -u)" -ne 0 ] || ! id "$user" >/dev/null 2>&1; then
    return 0
  fi
  group="$(id -gn "$user")"
  chown -R "$user:$group" "$target"
}

codex_api_key_login() {
  local user codex_home
  user="$1"
  codex_home="$2"
  if [ "${ORKESTR_RESET_SKIP_CODEX_LOGIN:-0}" = "1" ]; then
    return 0
  fi
  if [ -z "${OPENAI_API_KEY:-}" ] || ! have codex; then
    return 0
  fi
  mkdir -p "$codex_home"
  chown_if_root "$user" "$codex_home"
  printf '%s\n' "$OPENAI_API_KEY" | run_as_service_user "$user" env CODEX_HOME="$codex_home" codex login --with-api-key >/dev/null
}

load_env

service_name="${ORKESTR_SERVICE_NAME:-orkestr}"
run_user="$(service_user)"
home_path="$(safe_reset_path "${ORKESTR_HOME:-/opt/orkestr/data}" "ORKESTR_HOME")"
workspace_path="$(safe_reset_path "${ORKESTR_RUNTIME_WORKSPACE_ROOT:-${ORKESTR_WORKSPACE_DIR:-/opt/orkestr/workspace}}" "ORKESTR_RUNTIME_WORKSPACE_ROOT")"
overlay_path="$(safe_reset_path "${ORKESTR_OVERLAY_DIR:-/opt/orkestr/overlay}" "ORKESTR_OVERLAY_DIR")"
codex_home="$(abs_path "${CODEX_HOME:-$home_path/codex}")"

if [ "$check_only" -eq 1 ]; then
  echo "Reset paths validated."
  exit 0
fi

if [ "$stop_service" -eq 1 ] && have systemctl; then
  systemctl stop "${service_name}.service" 2>/dev/null || true
fi

if [ "${ORKESTR_RESET_KILL_TMUX:-1}" = "1" ]; then
  kill_orkestr_tmux_sessions "$run_user"
fi

rm -rf -- "$home_path" "$workspace_path"
if [ "${ORKESTR_RESET_OVERLAY:-0}" = "1" ]; then
  rm -rf -- "$overlay_path"
fi

mkdir -p "$home_path" "$workspace_path" "$overlay_path"
if path_is_inside "$codex_home" "$home_path"; then
  mkdir -p "$codex_home"
fi

chown_if_root "$run_user" "$home_path"
chown_if_root "$run_user" "$workspace_path"
chown_if_root "$run_user" "$overlay_path"

codex_api_key_login "$run_user" "$codex_home"

chown_if_root "$run_user" "$home_path"
chown_if_root "$run_user" "$workspace_path"
chown_if_root "$run_user" "$overlay_path"

echo "Orkestr state reset. Preserved ${ORKESTR_ENV_FILE:-/etc/orkestr/orkestr.env}."
