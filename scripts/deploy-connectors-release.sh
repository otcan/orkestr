#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/deploy-connectors-release.sh [--activate] [--source DIR]

Builds an isolated connector release under /opt/orkestr-connectors. Without
--activate it only stages and verifies the release. Activation stops only the
connector gateway/worker, updates their symlink and systemd overrides, then
starts and verifies them. It never restarts orkestr-ui.

Environment:
  ORKESTR_CONNECTORS_HEALTH_ATTEMPTS     Health attempts after activation. Defaults to 90.
  ORKESTR_CONNECTORS_HEALTH_RETRY_DELAY  Whole seconds between attempts. Defaults to 1.
  ORKESTR_CONNECTORS_HEALTH_STABLE_SUCCESSES Consecutive healthy checks required. Defaults to 3.
EOF
}

activate=0
source_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --activate) activate=1; shift ;;
    --source) source_dir="$(cd "$2" && pwd)"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

root="${ORKESTR_CONNECTORS_DEPLOY_ROOT:-/opt/orkestr-connectors}"
releases_dir="${ORKESTR_CONNECTORS_RELEASES_DIR:-$root/releases}"
current_link="${ORKESTR_CONNECTORS_CURRENT_LINK:-$root/current}"
retention="${ORKESTR_CONNECTORS_RELEASE_RETENTION:-3}"
connectors_env="${ORKESTR_CONNECTORS_ENV_FILE:-/etc/orkestr/orkestr-connectors.env}"
gateway_service="${ORKESTR_CONNECTORS_MCP_SERVICE_NAME:-orkestr-connectors-mcp}"
worker_service="${ORKESTR_WA_WORKER_SERVICE_NAME:-orkestr-wa-worker}@sender"
doctor_service="${ORKESTR_CONNECTORS_DOCTOR_SERVICE_NAME:-${gateway_service}-doctor}"
doctor_timer="${ORKESTR_CONNECTORS_DOCTOR_TIMER_NAME:-${doctor_service}}"
health_attempts="${ORKESTR_CONNECTORS_HEALTH_ATTEMPTS:-90}"
health_retry_delay="${ORKESTR_CONNECTORS_HEALTH_RETRY_DELAY:-1}"
health_stable_successes="${ORKESTR_CONNECTORS_HEALTH_STABLE_SUCCESSES:-3}"
lock_file="${ORKESTR_CONNECTORS_DEPLOY_LOCK_FILE:-/run/lock/orkestr-connectors-release.lock}"
node_bin="$(command -v node || echo /usr/bin/node)"
revision="$(git -C "$source_dir" rev-parse --verify HEAD)"
release_id="$(date -u +%Y%m%dT%H%M%SZ)-${revision:0:12}"
release_dir="$releases_dir/$release_id"

case "$health_attempts" in
  ''|*[!0-9]*|0) echo "ORKESTR_CONNECTORS_HEALTH_ATTEMPTS must be a positive integer." >&2; exit 2 ;;
esac
case "$health_retry_delay" in
  ''|*[!0-9]*|0) echo "ORKESTR_CONNECTORS_HEALTH_RETRY_DELAY must be a positive integer." >&2; exit 2 ;;
esac
case "$health_stable_successes" in
  ''|*[!0-9]*|0) echo "ORKESTR_CONNECTORS_HEALTH_STABLE_SUCCESSES must be a positive integer." >&2; exit 2 ;;
esac

switch_current_release() {
  local target="$1"
  rm -f "${current_link}.next"
  ln -s "$target" "${current_link}.next"
  mv -Tf "${current_link}.next" "$current_link"
  [ "$(readlink -f "$current_link" 2>/dev/null || true)" = "$(readlink -f "$target")" ]
}

active_connector_revision() {
  head -n 1 "$current_link/REVISION" 2>/dev/null | tr -d '[:space:]' || true
}

if ! git -C "$source_dir" diff --quiet || ! git -C "$source_dir" diff --cached --quiet; then
  echo "Connector releases must be built from a committed worktree." >&2
  exit 1
fi

if [ "$activate" -eq 1 ]; then
  command -v flock >/dev/null 2>&1 || {
    echo "Missing required command: flock" >&2
    exit 1
  }
  mkdir -p "$(dirname "$lock_file")"
  exec 9>"$lock_file"
  flock 9
  if [ "$(active_connector_revision)" = "$revision" ] \
    && systemctl is-active --quiet "$worker_service" \
    && systemctl is-active --quiet "$gateway_service"; then
    echo "Connector release already active for revision ${revision:0:12}; skipping activation."
    exit 0
  fi
fi

mkdir -p "$release_dir"
git -C "$source_dir" archive --format=tar "$revision" | tar -xf - -C "$release_dir"
cd "$release_dir"
npm ci --omit=dev
node --check scripts/orkestr-connectors-mcp.mjs
node --check scripts/orkestr-wa-worker.mjs
node --test --test-concurrency=1 test/connectors-mcp.test.js test/orkestr-wa-service.test.js
printf '%s\n' "$revision" > "$release_dir/REVISION"

if [ "$activate" -ne 1 ]; then
  echo "Connector release staged: $release_dir"
  exit 0
fi

previous_release="$(readlink -f "$current_link" 2>/dev/null || true)"
doctor_timer_was_active=0
if systemctl is-active --quiet "${doctor_timer}.timer"; then
  doctor_timer_was_active=1
fi
restore_doctor_timer() {
  if [ "$doctor_timer_was_active" -eq 1 ]; then
    systemctl start "${doctor_timer}.timer" || true
  fi
}
trap restore_doctor_timer EXIT
systemctl stop "${doctor_timer}.timer" "${doctor_service}.service" || true
systemctl stop "${gateway_service}.service" "${worker_service}.service"
switch_current_release "$release_dir"

mkdir -p "/etc/systemd/system/${gateway_service}.service.d" "/etc/systemd/system/${worker_service}.service.d" "/etc/systemd/system/${doctor_service}.service.d"
printf '[Service]\nWorkingDirectory=%s\nExecStart=\nExecStart=%s %s/scripts/orkestr-connectors-mcp.mjs\n' \
  "$current_link" "$node_bin" "$current_link" > "/etc/systemd/system/${gateway_service}.service.d/release.conf"
printf '[Service]\nWorkingDirectory=%s\nExecStart=\nExecStart=%s %s/scripts/orkestr-wa-worker.mjs\n' \
  "$current_link" "$node_bin" "$current_link" > "/etc/systemd/system/${worker_service}.service.d/release.conf"
printf '[Service]\nWorkingDirectory=%s\nExecStart=\nExecStart=%s %s/scripts/orkestr-connectors-doctor.mjs --repair\n' \
  "$current_link" "$node_bin" "$current_link" > "/etc/systemd/system/${doctor_service}.service.d/release.conf"
systemctl daemon-reload
systemctl start "${worker_service}.service"
systemctl start "${gateway_service}.service"

token="${ORKESTR_CONNECTORS_MCP_TOKEN:-${ORKESTR_WA_SERVICE_TOKEN:-}}"
if [ -z "$token" ] && [ -r "$connectors_env" ]; then
  token="$(sed -n 's/^ORKESTR_CONNECTORS_MCP_TOKEN=//p' "$connectors_env" | tail -1)"
  token="${token%\"}"
  token="${token#\"}"
  token="${token%\'}"
  token="${token#\'}"
fi
health_ready=0
health_successes=0
for _ in $(seq 1 "$health_attempts"); do
  if ORKESTR_CONNECTORS_MCP_TOKEN="$token" \
      ORKESTR_CONNECTORS_MCP_HEALTH_URL="${ORKESTR_CONNECTORS_MCP_HEALTH_URL:-http://127.0.0.1:18914/health}" \
      "$node_bin" "$release_dir/scripts/orkestr-connectors-doctor.mjs" >/dev/null 2>&1; then
    health_successes=$((health_successes + 1))
    if [ "$health_successes" -ge "$health_stable_successes" ]; then
      health_ready=1
      break
    fi
  else
    health_successes=0
  fi
  sleep "$health_retry_delay"
done
if [ "$health_ready" -ne 1 ]; then
  echo "Connector health verification failed; restoring the previous release." >&2
  systemctl stop "${gateway_service}.service" "${worker_service}.service" || true
  if [ -n "$previous_release" ] && [ -d "$previous_release" ]; then
    switch_current_release "$previous_release"
    systemctl start "${worker_service}.service" "${gateway_service}.service" || true
  fi
  exit 1
fi

restore_doctor_timer
doctor_timer_was_active=0
trap - EXIT

find "$releases_dir" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' \
  | sort -nr \
  | awk -v keep="$retention" 'NR > keep { sub(/^[^ ]+ /, ""); print }' \
  | while IFS= read -r old_release; do
      [ -n "$old_release" ] || continue
      [ "$(readlink -f "$current_link")" = "$(readlink -f "$old_release")" ] && continue
      rm -rf -- "$old_release"
    done

echo "Connector release active: $release_dir"
