#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Deploy Orkestr to a host-native VPS over SSH.

Usage:
  scripts/deploy-vps.sh
  scripts/deploy-vps.sh --check-only

Required environment:
  ORKESTR_DEPLOY_HOST        SSH host or tailnet DNS name.
  ORKESTR_DEPLOY_SSH_KEY     Private SSH key contents, unless ORKESTR_DEPLOY_KEY_FILE is set.

Optional environment:
  ORKESTR_DEPLOY_USER        SSH user. Defaults to root.
  ORKESTR_DEPLOY_PORT        SSH port. Defaults to 22.
  ORKESTR_DEPLOY_KEY_FILE    Existing private key path.
  ORKESTR_DEPLOY_KNOWN_HOSTS known_hosts line(s). Recommended for CI.
  ORKESTR_DEPLOY_REF         Git branch, tag, or commit to deploy. Defaults to main.
  ORKESTR_DEPLOY_REPO_URL    Git repository URL. Defaults to https://github.com/otcan/orkestr.git.

The remote host runs scripts/install.sh --systemd from this checkout. The
installer updates /opt/orkestr/app, rebuilds, prunes dev dependencies, writes
the systemd unit, and restarts orkestr.service.
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

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
install_script="$script_dir/install.sh"

if [ ! -f "$install_script" ]; then
  echo "Missing installer: $install_script" >&2
  exit 1
fi

if [ "$check_only" -eq 1 ]; then
  bash -n "$install_script"
  exit 0
fi

need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

quote() {
  printf "%q" "$1"
}

require_env() {
  local name value
  name="$1"
  value="${!name:-}"
  if [ -z "$value" ]; then
    echo "Missing required environment variable: $name" >&2
    exit 1
  fi
}

need ssh
require_env ORKESTR_DEPLOY_HOST

deploy_host="$ORKESTR_DEPLOY_HOST"
deploy_user="${ORKESTR_DEPLOY_USER:-root}"
deploy_port="${ORKESTR_DEPLOY_PORT:-22}"
deploy_ref="${ORKESTR_DEPLOY_REF:-main}"
deploy_repo_url="${ORKESTR_DEPLOY_REPO_URL:-https://github.com/otcan/orkestr.git}"

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

ssh_opts=(
  -p "$deploy_port"
  -o BatchMode=yes
  -o ServerAliveInterval=30
  -o ServerAliveCountMax=3
)

if [ -n "${ORKESTR_DEPLOY_KNOWN_HOSTS:-}" ]; then
  known_hosts_file="$tmpdir/known_hosts"
  printf "%s\n" "$ORKESTR_DEPLOY_KNOWN_HOSTS" > "$known_hosts_file"
  ssh_opts+=(-o UserKnownHostsFile="$known_hosts_file" -o StrictHostKeyChecking=yes)
else
  ssh_opts+=(-o StrictHostKeyChecking=accept-new)
fi

if [ -n "${ORKESTR_DEPLOY_KEY_FILE:-}" ]; then
  ssh_opts+=(-i "$ORKESTR_DEPLOY_KEY_FILE")
elif [ -n "${ORKESTR_DEPLOY_SSH_KEY:-}" ]; then
  key_file="$tmpdir/deploy_key"
  printf "%s\n" "$ORKESTR_DEPLOY_SSH_KEY" > "$key_file"
  chmod 0600 "$key_file"
  ssh_opts+=(-i "$key_file")
else
  echo "Set ORKESTR_DEPLOY_SSH_KEY or ORKESTR_DEPLOY_KEY_FILE." >&2
  exit 1
fi

target="${deploy_user}@${deploy_host}"
remote_install_path="/tmp/orkestr-install-${GITHUB_RUN_ID:-manual}-$$.sh"
remote_install_quoted="$(quote "$remote_install_path")"
remote_env="ORKESTR_REPO_URL=$(quote "$deploy_repo_url") ORKESTR_GIT_REF=$(quote "$deploy_ref")"

echo "Uploading installer to $target"
ssh "${ssh_opts[@]}" "$target" "umask 077 && cat > $remote_install_quoted" < "$install_script"

echo "Deploying Orkestr ref $deploy_ref"
ssh "${ssh_opts[@]}" "$target" "$remote_env bash -s -- $remote_install_quoted" <<'REMOTE'
set -euo pipefail

install_path="$1"
if [ "$(id -u)" -eq 0 ]; then
  bash "$install_path" --systemd
else
  sudo -E bash "$install_path" --systemd
fi

service_name="${ORKESTR_SERVICE_NAME:-orkestr}"
systemctl is-active --quiet "${service_name}.service"
systemctl --no-pager --full status "${service_name}.service" | sed -n '1,14p'
rm -f "$install_path"
REMOTE
