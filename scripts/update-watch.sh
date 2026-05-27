#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Check for and deploy the latest Orkestr host-native update.

Usage:
  scripts/update-watch.sh [--check-only]

Environment:
  ORKESTR_ENV_FILE             Environment file. Defaults to /etc/orkestr/orkestr.env.
  ORKESTR_APP_DIR              App checkout. Defaults to /opt/orkestr/app.
  ORKESTR_REPO_URL             Git repository URL. Defaults to https://github.com/otcan/orkestr.git.
  ORKESTR_UPDATE_REF           Branch, tag, or commit to follow. Defaults to main.
  ORKESTR_UPDATE_LOCK_FILE     Lock file. Defaults to /var/lock/orkestr-update.lock.
  ORKESTR_SERVICE_NAME         systemd service name. Defaults to orkestr.
  ORKESTR_RELEASE_DEPLOY       Use scripts/deploy-git-release.sh instead of in-place updates. Defaults to 0.
  ORKESTR_DEPLOY_CHANNEL       Release deployment channel. Defaults to production.
  ORKESTR_RESET_ON_UPDATE      Reset runtime state after a successful build. Defaults to 0.
  ORKESTR_RESET_OVERLAY        Also reset the overlay directory when reset is enabled. Defaults to 0.
  ORKESTR_BUILD_WEB_FROM_SOURCE Set to 1 to install dev dependencies and rebuild the Angular web app.

This script is intended to be run by orkestr-update.timer. It leaves the
existing service running while it fetches, installs dependencies, and builds.
It restarts orkestr.service only after a new ref builds successfully.
USAGE
}

check_only=0
while [ "$#" -gt 0 ]; do
  case "$1" in
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

if [ "$check_only" -eq 1 ]; then
  exit 0
fi

need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
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

runtime_run_user() {
  local user
  user="${ORKESTR_RUN_USER:-}"
  if [ -z "$user" ] && command -v systemctl >/dev/null 2>&1; then
    user="$(systemctl show -p User --value "${ORKESTR_SERVICE_NAME:-orkestr}.service" 2>/dev/null || true)"
  fi
  echo "${user:-orkestr}"
}

repair_runtime_ownership() {
  if [ "$(id -u)" -ne 0 ]; then
    return 0
  fi
  local run_user run_group runtime_home codex_home
  run_user="$(runtime_run_user)"
  if ! id "$run_user" >/dev/null 2>&1; then
    return 0
  fi
  run_group="$(id -gn "$run_user")"
  runtime_home="${ORKESTR_HOME:-/opt/orkestr/data}"
  codex_home="${CODEX_HOME:-$runtime_home/codex}"
  mkdir -p "$codex_home"
  chown -R "$run_user:$run_group" "$codex_home"
  chmod 0700 "$codex_home"
}

resolve_target_ref() {
  local ref
  ref="$1"
  if git -C "$app_dir" rev-parse --verify --quiet "origin/$ref^{commit}" >/dev/null; then
    git -C "$app_dir" rev-parse "origin/$ref^{commit}"
    return 0
  fi
  if git -C "$app_dir" rev-parse --verify --quiet "$ref^{commit}" >/dev/null; then
    git -C "$app_dir" rev-parse "$ref^{commit}"
    return 0
  fi
  return 1
}

checkout_target_ref() {
  local ref target
  ref="$1"
  target="$2"
  if git -C "$app_dir" rev-parse --verify --quiet "origin/$ref^{commit}" >/dev/null; then
    git -C "$app_dir" checkout -B "$ref" "origin/$ref"
    return 0
  fi
  git -C "$app_dir" checkout --detach "$target"
}

load_env

app_dir="${ORKESTR_APP_DIR:-/opt/orkestr/app}"
repo_url="${ORKESTR_REPO_URL:-https://github.com/otcan/orkestr.git}"
update_ref="${ORKESTR_UPDATE_REF:-main}"
service_name="${ORKESTR_SERVICE_NAME:-orkestr}"
lock_file="${ORKESTR_UPDATE_LOCK_FILE:-/var/lock/orkestr-update.lock}"

need flock
need git
need npm
need systemctl

mkdir -p "$(dirname "$lock_file")"
exec 9>"$lock_file"
if ! flock -n 9; then
  echo "Another Orkestr update is already running."
  exit 0
fi

if [ "${ORKESTR_RELEASE_DEPLOY:-0}" = "1" ]; then
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  channel="${ORKESTR_DEPLOY_CHANNEL:-production}"
  exec bash "$script_dir/deploy-git-release.sh" install --ref "$update_ref" --channel "$channel"
fi

if [ ! -d "$app_dir/.git" ]; then
  echo "Orkestr app checkout is missing: $app_dir" >&2
  exit 1
fi

cd "$app_dir"

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Refusing to update because $app_dir has local tracked changes." >&2
  exit 1
fi

git remote set-url origin "$repo_url"
current_ref="$(git rev-parse HEAD)"
git fetch --prune origin
target_ref="$(resolve_target_ref "$update_ref")"

if [ "$current_ref" = "$target_ref" ]; then
  repair_runtime_ownership
  echo "Orkestr is already current at $current_ref."
  exit 0
fi

echo "Updating Orkestr from $current_ref to $target_ref."
checkout_target_ref "$update_ref" "$target_ref"

bash scripts/install-runtime-deps.sh
npm run build:runtime
npm prune --omit=dev
repair_runtime_ownership

if [ "${ORKESTR_RESET_ON_UPDATE:-0}" = "1" ]; then
  systemctl stop "${service_name}.service" || true
  bash "$app_dir/scripts/reset-vps-state.sh" --no-stop-service
fi

systemctl restart "${service_name}.service"
systemctl is-active --quiet "${service_name}.service"
echo "Orkestr updated to $target_ref and ${service_name}.service restarted."
