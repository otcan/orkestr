#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Uninstall local Orkestr.

Usage:
  scripts/uninstall.sh [--keep-data] [--keep-source]

One-line uninstall:
  curl -fsSL https://raw.githubusercontent.com/otcan/orkestr/main/scripts/uninstall.sh | bash

Options:
  --keep-data    Stop services and remove wrappers, but keep ~/.orkestr.
  --keep-source  Keep the managed checkout under ~/.orkestr-src.
USAGE
}

keep_data=0
keep_source=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --keep-data)
      keep_data=1
      shift
      ;;
    --keep-source)
      keep_source=1
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

is_macos() {
  [ "$(uname -s)" = "Darwin" ]
}

safe_remove_path() {
  local path
  path="${1:-}"
  [ -n "$path" ] || return 0
  case "$path" in
    "/"|"$HOME"|"$HOME/"|"/home"|"/Users"|"/root"|"/opt"|"/usr"|"/usr/local")
      echo "Refusing to remove unsafe path: $path" >&2
      exit 1
      ;;
  esac
  rm -rf "$path"
}

data_dir="${ORKESTR_HOME:-$HOME/.orkestr}"
local_env_file="${ORKESTR_LOCAL_ENV_FILE:-$data_dir/orkestr.env}"

if [ -r "$local_env_file" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$local_env_file"
  set +a
fi

data_dir="${ORKESTR_HOME:-$data_dir}"
local_env_file="${ORKESTR_LOCAL_ENV_FILE:-$data_dir/orkestr.env}"
source_dir="${ORKESTR_APP_DIR:-${ORKESTR_INSTALL_DIR:-$HOME/.orkestr-src/orkestr-oss}}"
service_name="${ORKESTR_LOCAL_SERVICE_NAME:-orkestr}"
service_label="${ORKESTR_LOCAL_SERVICE_LABEL:-com.orkestr.oss}"
local_bin="${ORKESTR_LOCAL_CLI_BIN:-${ORKESTR_LOCAL_BIN_DIR:-$HOME/.local/bin}/orkestr}"
server_wrapper="${ORKESTR_LOCAL_SERVER_WRAPPER:-$data_dir/bin/orkestr-server}"
log_dir="${ORKESTR_LOCAL_LOG_DIR:-$data_dir/logs}"
pid_file="${ORKESTR_LOCAL_PID_FILE:-$data_dir/orkestr.pid}"
launchd_file="${ORKESTR_LOCAL_SERVICE_FILE:-$HOME/Library/LaunchAgents/$service_label.plist}"
systemd_user_file="${ORKESTR_LOCAL_SERVICE_FILE:-$HOME/.config/systemd/user/$service_name.service}"
cron_file="${ORKESTR_LOCAL_SERVICE_FILE:-$data_dir/cron-service}"

remove_cron_entry() {
  local tmp marker
  if ! have crontab; then
    return 0
  fi
  marker="# orkestr local service"
  tmp="$(mktemp)"
  crontab -l 2>/dev/null | grep -vF "$marker" > "$tmp" || true
  crontab "$tmp" 2>/dev/null || true
  rm -f "$tmp"
}

stop_services() {
  local domain pid
  if is_macos && have launchctl; then
    domain="gui/$(id -u)"
    launchctl bootout "$domain/$service_label" >/dev/null 2>&1 || launchctl bootout "$domain" "$launchd_file" >/dev/null 2>&1 || true
    rm -f "$launchd_file" "$HOME/Library/LaunchAgents/$service_label.plist"
  fi
  if have systemctl; then
    systemctl --user disable --now "$service_name.service" >/dev/null 2>&1 || true
    rm -f "$systemd_user_file" "$HOME/.config/systemd/user/$service_name.service"
    systemctl --user daemon-reload >/dev/null 2>&1 || true
  fi
  remove_cron_entry
  if [ -r "$pid_file" ]; then
    pid="$(cat "$pid_file" 2>/dev/null || true)"
    if [ -n "$pid" ]; then
      kill "$pid" >/dev/null 2>&1 || true
    fi
    rm -f "$pid_file"
  fi
}

stop_services
rm -f "$local_bin" "$server_wrapper" "$cron_file"
rm -rf "$log_dir"

if [ "$keep_data" = "0" ]; then
  safe_remove_path "$data_dir"
else
  echo "Kept data directory: $data_dir"
fi

if [ "$keep_source" = "0" ]; then
  case "$source_dir" in
    "$HOME/.orkestr-src/"*)
      safe_remove_path "$source_dir"
      ;;
    *)
      echo "Kept source checkout: $source_dir"
      ;;
  esac
else
  echo "Kept source checkout: $source_dir"
fi

cat <<EOF
Orkestr local install removed.

Removed service files and wrappers. Reinstall with:
  curl -fsSL https://raw.githubusercontent.com/otcan/orkestr/main/scripts/install.sh | bash

Fresh reinstall:
  curl -fsSL https://raw.githubusercontent.com/otcan/orkestr/main/scripts/install.sh | bash -s -- --fresh
EOF
