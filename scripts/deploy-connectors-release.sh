#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/deploy-connectors-release.sh [--activate] [--source DIR]

Builds an isolated connector release under /opt/orkestr-connectors. Without
--activate it only stages and verifies the release. Activation stops only the
connector gateway/worker, updates their symlink and systemd overrides, then
starts and verifies them. It never restarts orkestr-ui.
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
node_bin="$(command -v node || echo /usr/bin/node)"
revision="$(git -C "$source_dir" rev-parse --verify HEAD)"
release_id="$(date -u +%Y%m%dT%H%M%SZ)-${revision:0:12}"
release_dir="$releases_dir/$release_id"

if ! git -C "$source_dir" diff --quiet || ! git -C "$source_dir" diff --cached --quiet; then
  echo "Connector releases must be built from a committed worktree." >&2
  exit 1
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
systemctl stop "${gateway_service}.service" "${worker_service}.service"
ln -sfn "$release_dir" "${current_link}.next"
mv -Tf "${current_link}.next" "$current_link"

mkdir -p "/etc/systemd/system/${gateway_service}.service.d" "/etc/systemd/system/${worker_service}.service.d"
printf '[Service]\nWorkingDirectory=%s\nExecStart=\nExecStart=%s %s/scripts/orkestr-connectors-mcp.mjs\n' \
  "$current_link" "$node_bin" "$current_link" > "/etc/systemd/system/${gateway_service}.service.d/release.conf"
printf '[Service]\nWorkingDirectory=%s\nExecStart=\nExecStart=%s %s/scripts/orkestr-wa-worker.mjs\n' \
  "$current_link" "$node_bin" "$current_link" > "/etc/systemd/system/${worker_service}.service.d/release.conf"
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
curl_args=(--fail --silent --show-error --max-time 10)
if [ -n "$token" ]; then curl_args+=(-H "Authorization: Bearer $token"); fi
if ! curl "${curl_args[@]}" "${ORKESTR_CONNECTORS_MCP_HEALTH_URL:-http://127.0.0.1:18914/health}" >/dev/null; then
  echo "Connector health verification failed; restoring the previous release." >&2
  systemctl stop "${gateway_service}.service" "${worker_service}.service" || true
  if [ -n "$previous_release" ] && [ -d "$previous_release" ]; then
    ln -sfn "$previous_release" "${current_link}.next"
    mv -Tf "${current_link}.next" "$current_link"
    systemctl start "${worker_service}.service" "${gateway_service}.service" || true
  fi
  exit 1
fi

find "$releases_dir" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' \
  | sort -nr \
  | awk -v keep="$retention" 'NR > keep { sub(/^[^ ]+ /, ""); print }' \
  | while IFS= read -r old_release; do
      [ -n "$old_release" ] || continue
      [ "$(readlink -f "$current_link")" = "$(readlink -f "$old_release")" ] && continue
      rm -rf -- "$old_release"
    done

echo "Connector release active: $release_dir"
