#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/migrate-connectors-mcp.sh [--activate] [options]

Installs the connector MCP gateway and WhatsApp worker beside an existing
Orkestr UI deployment. Without --activate, prints the cutover plan only.

Options:
  --activate                 Perform the attended cutover.
  --source DIR               Committed Orkestr checkout to run initially.
  --run-user USER            Service user. Defaults to ORKESTR_RUN_USER.
  --data-home DIR            Existing Orkestr data home.
  --ui-service NAME          Existing UI service. Defaults to orkestr-ui.
  --gateway-service NAME     Gateway service. Defaults to orkestr-connectors-mcp.
  --worker-service NAME      Worker template. Defaults to orkestr-wa-worker.
  --help                     Show this help.
EOF
}

activate=0
source_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
run_user="${ORKESTR_RUN_USER:-${SUDO_USER:-}}"
data_home="${ORKESTR_HOME:-/opt/orkestr/data}"
ui_service="${ORKESTR_UI_SERVICE_NAME:-orkestr-ui}"
gateway_service="${ORKESTR_CONNECTORS_MCP_SERVICE_NAME:-orkestr-connectors-mcp}"
worker_service="${ORKESTR_WA_WORKER_SERVICE_NAME:-orkestr-wa-worker}"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --activate) activate=1; shift ;;
    --source) source_dir="$(cd "$2" && pwd)"; shift 2 ;;
    --run-user) run_user="$2"; shift 2 ;;
    --data-home) data_home="$2"; shift 2 ;;
    --ui-service) ui_service="$2"; shift 2 ;;
    --gateway-service) gateway_service="$2"; shift 2 ;;
    --worker-service) worker_service="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

connectors_env="${ORKESTR_CONNECTORS_ENV_FILE:-/etc/orkestr/orkestr-connectors.env}"
ui_env="${ORKESTR_CONNECTORS_UI_ENV_FILE:-/etc/orkestr/orkestr-connectors-ui.env}"
ui_dropin_dir="/etc/systemd/system/${ui_service}.service.d"
ui_dropin="$ui_dropin_dir/95-connectors-mcp.conf"
gateway_unit="/etc/systemd/system/${gateway_service}.service"
worker_unit="/etc/systemd/system/${worker_service}@.service"
doctor_unit="/etc/systemd/system/${gateway_service}-doctor.service"
doctor_timer="/etc/systemd/system/${gateway_service}-doctor.timer"
node_bin="$(command -v node || echo /usr/bin/node)"

echo "Connector MCP cutover plan"
echo "  source: $source_dir"
echo "  data: $data_home"
echo "  UI: ${ui_service}.service"
echo "  worker: ${worker_service}@sender.service"
echo "  gateway: ${gateway_service}.service"
echo "  recovery: connector-only doctor, max three repairs per hour"
echo "  rollback: restore embedded UI routing if worker health does not become ready"

if [ "$activate" -ne 1 ]; then
  echo "Dry run only. Re-run with --activate for the attended cutover."
  exit 0
fi

if [ "$(id -u)" -ne 0 ]; then
  echo "--activate must run as root." >&2
  exit 1
fi
if [ -z "$run_user" ]; then
  run_user="$(systemctl show "${ui_service}.service" --property=User --value)"
  run_user="${run_user:-root}"
fi
if ! id "$run_user" >/dev/null 2>&1; then
  echo "A valid --run-user is required." >&2
  exit 1
fi
if ! git -C "$source_dir" diff --quiet || ! git -C "$source_dir" diff --cached --quiet; then
  echo "The tracked source worktree must be committed before cutover." >&2
  exit 1
fi

run_group="$(id -gn "$run_user")"

random_token() {
  openssl rand -hex 32
}

env_value() {
  local file="$1" name="$2" value
  value="$(sed -n "s/^${name}=//p" "$file" 2>/dev/null | tail -1)"
  value="${value%\"}"
  value="${value#\"}"
  value="${value%\'}"
  value="${value#\'}"
  printf '%s' "$value"
}

set_env_value() {
  local file="$1" name="$2" value="$3" escaped
  escaped="$(printf '%s' "$value" | sed 's/[&|]/\\&/g')"
  if grep -q "^${name}=" "$file" 2>/dev/null; then
    sed -i "s|^${name}=.*|${name}=${escaped}|" "$file"
  else
    printf '%s=%s\n' "$name" "$value" >> "$file"
  fi
}

copy_ui_account_environment() {
  local name encoded value
  while IFS=$'\t' read -r name encoded; do
    [ -n "$name" ] || continue
    value="$(printf '%s' "$encoded" | base64 --decode)"
    set_env_value "$connectors_env" "$name" "$value"
  done < <(
    systemctl show "${ui_service}.service" --property=Environment --value |
      python3 -c '
import base64
import shlex
import sys

allowed = {
    "ORKESTR_WHATSAPP_ACCOUNT_IDS",
    "WHATSAPP_LOCAL_ACCOUNT_IDS",
    "ORKESTR_WHATSAPP_STRICT_ACCOUNT_IDS",
    "WHATSAPP_LOCAL_STRICT_ACCOUNT_IDS",
    "ORKESTR_WHATSAPP_ACCOUNT_CLIENT_IDS",
    "WHATSAPP_LOCAL_ACCOUNT_CLIENT_IDS",
    "ORKESTR_WHATSAPP_ACCOUNT_SESSION_ROOTS",
    "WHATSAPP_LOCAL_ACCOUNT_SESSION_ROOTS",
    "ORKESTR_WHATSAPP_DEFAULT_RESPONDER_ACCOUNT_ID",
    "WHATSAPP_LOCAL_DEFAULT_RESPONDER_ACCOUNT_ID",
    "ORKESTR_WHATSAPP_SENDER_ACCOUNT_ID",
    "ORKESTR_WHATSAPP_RESPONDER_ACCOUNT_ID",
    "ORKESTR_WHATSAPP_SENDER_ROLE",
    "ORKESTR_WHATSAPP_RESPONDER_ROLE",
}
for assignment in shlex.split(sys.stdin.read()):
    name, separator, value = assignment.partition("=")
    if separator and name in allowed:
        print(name + "\t" + base64.b64encode(value.encode()).decode())
'
  )
}

mkdir -p /etc/orkestr "$ui_dropin_dir" "$data_home/connectors"
touch "$connectors_env" "$ui_env"
chmod 0600 "$connectors_env" "$ui_env"
chown root:"$run_group" "$connectors_env" "$ui_env"

mcp_token="$(env_value "$connectors_env" ORKESTR_CONNECTORS_MCP_TOKEN)"
worker_token="$(env_value "$connectors_env" ORKESTR_WA_WORKER_TOKEN)"
event_token="$(env_value "$connectors_env" ORKESTR_WA_WORKER_EVENT_TOKEN)"
[ -n "$mcp_token" ] || mcp_token="$(random_token)"
[ -n "$worker_token" ] || worker_token="$(random_token)"
[ -n "$event_token" ] || event_token="$(random_token)"

set_env_value "$connectors_env" ORKESTR_HOME "$data_home"
set_env_value "$connectors_env" ORKESTR_CONNECTORS_MCP_HOST "127.0.0.1"
set_env_value "$connectors_env" ORKESTR_CONNECTORS_MCP_PORT "18914"
set_env_value "$connectors_env" ORKESTR_CONNECTORS_MCP_URL "http://127.0.0.1:18914/mcp"
set_env_value "$connectors_env" ORKESTR_CONNECTORS_MCP_TOKEN "$mcp_token"
set_env_value "$connectors_env" ORKESTR_WA_SERVICE_TOKEN "$mcp_token"
set_env_value "$connectors_env" ORKESTR_WA_WORKER_TOKEN "$worker_token"
set_env_value "$connectors_env" ORKESTR_WA_WORKER_EVENT_TOKEN "$event_token"
set_env_value "$connectors_env" ORKESTR_WA_WORKER_SOCKET "/run/orkestr-wa/sender.sock"
set_env_value "$connectors_env" ORKESTR_WA_WORKER_EVENT_SINK_URL "http://127.0.0.1:18914/internal/whatsapp/inbound"
set_env_value "$connectors_env" ORKESTR_CONNECTORS_MCP_INBOUND_TARGET_URL "http://127.0.0.1:18912/api/connectors/whatsapp/inbound"
copy_ui_account_environment
set_env_value "$connectors_env" ORKESTR_CONNECTORS_REQUIRED_WA_ACCOUNTS "sender"
set_env_value "$connectors_env" ORKESTR_WHATSAPP_AUTOSTART_ACCOUNT_IDS "sender"
set_env_value "$connectors_env" ORKESTR_WHATSAPP_AUTOSTART "1"

set_env_value "$ui_env" ORKESTR_CONNECTORS_MCP_URL "http://127.0.0.1:18914/mcp"
set_env_value "$ui_env" ORKESTR_CONNECTORS_MCP_TOKEN "$mcp_token"
set_env_value "$ui_env" ORKESTR_CONNECTORS_MCP_BEARER_TOKEN "$mcp_token"
set_env_value "$ui_env" WHATSAPP_BRIDGE_TOKEN "$mcp_token"
set_env_value "$ui_env" ORKESTR_WHATSAPP_BRIDGE_TOKEN "$mcp_token"

shared_env_directives=""
for candidate in \
  /opt/openclaw.env \
  /etc/orkestr/broker-registration.env \
  "$data_home/secrets/whatsapp-inbound.env"; do
  if [ -f "$candidate" ]; then
    shared_env_directives+="EnvironmentFile=-${candidate}"$'\n'
  fi
done

cat > "$worker_unit" <<EOF
[Unit]
Description=Orkestr WhatsApp worker (%i)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$run_user
Group=$run_group
WorkingDirectory=$source_dir
${shared_env_directives}EnvironmentFile=$connectors_env
Environment=ORKESTR_WA_WORKER_SOCKET=/run/orkestr-wa/%i.sock
Environment=ORKESTR_WHATSAPP_ACCOUNT_IDS=%i
Environment=ORKESTR_WHATSAPP_AUTOSTART_ACCOUNT_IDS=%i
ExecStart=$node_bin scripts/orkestr-wa-worker.mjs
Restart=on-failure
RestartSec=5
TimeoutStopSec=30s
KillMode=mixed
RuntimeDirectory=orkestr-wa
RuntimeDirectoryMode=0750
PrivateTmp=true
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF

cat > "$gateway_unit" <<EOF
[Unit]
Description=Orkestr connector MCP gateway
After=network-online.target ${worker_service}@sender.service
Wants=network-online.target ${worker_service}@sender.service

[Service]
Type=simple
User=$run_user
Group=$run_group
WorkingDirectory=$source_dir
${shared_env_directives}EnvironmentFile=$connectors_env
ExecStart=$node_bin scripts/orkestr-connectors-mcp.mjs
Restart=on-failure
RestartSec=5
TimeoutStopSec=30s
KillMode=mixed
PrivateTmp=true
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF

cat > "$doctor_unit" <<EOF
[Unit]
Description=Orkestr connector health and bounded repair
After=${gateway_service}.service ${worker_service}@sender.service

[Service]
Type=oneshot
User=root
WorkingDirectory=$source_dir
EnvironmentFile=$connectors_env
Environment=ORKESTR_CONNECTORS_MCP_SYSTEMD_SERVICE=$gateway_service
Environment=ORKESTR_WA_WORKER_SYSTEMD_SERVICE=${worker_service}@sender
ExecStart=$node_bin scripts/orkestr-connectors-doctor.mjs --repair
EOF

cat > "$doctor_timer" <<EOF
[Unit]
Description=Check Orkestr connector services every minute

[Timer]
OnBootSec=60s
OnUnitActiveSec=60s
Unit=${gateway_service}-doctor.service

[Install]
WantedBy=timers.target
EOF

dropin_backup=""
if [ -f "$ui_dropin" ]; then
  dropin_backup="$(mktemp /run/orkestr-connectors-ui-dropin.XXXXXX)"
  cp "$ui_dropin" "$dropin_backup"
fi

cat > "$ui_dropin" <<EOF
[Service]
EnvironmentFile=$ui_env
Environment=WHATSAPP_BRIDGE_MODE=external
Environment=ORKESTR_WHATSAPP_EXTERNAL_BRIDGE_ENABLED=1
Environment=WHATSAPP_BRIDGE_URL=http://127.0.0.1:18914
Environment=ORKESTR_WHATSAPP_AUTOSTART=0
Environment=WHATSAPP_LOCAL_AUTOSTART=0
EOF

cutover_started=0
rollback() {
  local code=$?
  trap - ERR
  if [ "$cutover_started" -eq 1 ]; then
    systemctl stop "${gateway_service}.service" "${worker_service}@sender.service" || true
    if [ -n "$dropin_backup" ] && [ -f "$dropin_backup" ]; then
      cp "$dropin_backup" "$ui_dropin"
    else
      rm -f "$ui_dropin"
    fi
    systemctl daemon-reload
    systemctl start "${ui_service}.service" || true
  fi
  echo "Connector MCP cutover failed; embedded UI routing was restored." >&2
  exit "$code"
}
trap rollback ERR

systemctl daemon-reload
cutover_started=1
systemctl stop "${ui_service}.service"
systemctl kill --kill-who=all --signal=SIGKILL "${ui_service}.service" 2>/dev/null || true
systemctl start "${worker_service}@sender.service"
systemctl start "${gateway_service}.service"

set -a
# shellcheck disable=SC1090
. "$connectors_env"
set +a
healthy=0
for _ in $(seq 1 60); do
  if "$node_bin" "$source_dir/scripts/orkestr-connectors-doctor.mjs" >/dev/null 2>&1; then
    healthy=1
    break
  fi
  sleep 3
done
if [ "$healthy" -ne 1 ]; then
  echo "The connector worker did not become ready within 180 seconds." >&2
  false
fi

systemctl start "${ui_service}.service"
ui_ready=0
for _ in $(seq 1 30); do
  if curl --fail --silent --max-time 3 http://127.0.0.1:18912/api/health >/dev/null; then
    ui_ready=1
    break
  fi
  sleep 2
done
if [ "$ui_ready" -ne 1 ]; then
  echo "The Orkestr UI did not become healthy after connector cutover." >&2
  false
fi

systemctl enable "${worker_service}@sender.service" "${gateway_service}.service" "${gateway_service}-doctor.timer"
systemctl start "${gateway_service}-doctor.timer"
rm -f "$dropin_backup"
cutover_started=0
trap - ERR
echo "Connector MCP cutover completed. The UI now uses the isolated worker through the gateway."
