#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: sudo bash scripts/install-postfix-mailbox.sh [options]

Options:
  --domain DOMAIN       Inbound-only mailbox domain. Defaults to in.orkestr.de.
  --hostname HOSTNAME   SMTP hostname. Defaults to mx.<domain>.
  --env-file PATH       Orkestr environment file. Defaults to /etc/orkestr/orkestr.env.
  --ui-env-file PATH    Main service environment file. Auto-detected by default.
  --mta-env-file PATH   Dedicated MTA environment file. Defaults to /etc/orkestr/mailbox-mta.env.
  --current PATH        Active release symlink. Defaults to /opt/orkestr/current.
  --service NAME        Main Orkestr service. Defaults to orkestr-ui.
  --run-user USER       Runtime user. Defaults to the main service user.
EOF
}

domain="${ORKESTR_MAILBOX_DOMAIN:-in.orkestr.de}"
smtp_hostname=""
env_file="${ORKESTR_ENV_FILE:-/etc/orkestr/orkestr.env}"
ui_env_file="${ORKESTR_UI_ENV_FILE:-}"
mta_env_file="${ORKESTR_MAILBOX_MTA_ENV_FILE:-/etc/orkestr/mailbox-mta.env}"
current_link="${ORKESTR_CURRENT_LINK:-/opt/orkestr/current}"
main_service="${ORKESTR_SERVICE_NAME:-orkestr-ui}"
run_user="${ORKESTR_RUN_USER:-}"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --domain) domain="${2:-}"; shift 2 ;;
    --hostname) smtp_hostname="${2:-}"; shift 2 ;;
    --env-file) env_file="${2:-}"; shift 2 ;;
    --ui-env-file) ui_env_file="${2:-}"; shift 2 ;;
    --mta-env-file) mta_env_file="${2:-}"; shift 2 ;;
    --current) current_link="${2:-}"; shift 2 ;;
    --service) main_service="${2:-}"; shift 2 ;;
    --run-user) run_user="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this installer as root." >&2
  exit 1
fi
if ! [[ "$domain" =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$ ]]; then
  echo "Invalid mailbox domain: $domain" >&2
  exit 2
fi
smtp_hostname="${smtp_hostname:-mx.$domain}"
if ! [[ "$smtp_hostname" =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$ ]]; then
  echo "Invalid SMTP hostname: $smtp_hostname" >&2
  exit 2
fi

main_unit="${main_service%.service}.service"
if [ -z "$ui_env_file" ]; then
  ui_env_file="$(systemctl show -p EnvironmentFiles --value "$main_unit" 2>/dev/null \
    | awk '{ print $1 }' \
    | grep '^/etc/orkestr/.*\.env$' \
    | tail -n 1 || true)"
fi
ui_env_file="${ui_env_file:-$env_file}"
if [ -z "$run_user" ]; then
  run_user="$(systemctl show -p User --value "$main_unit" 2>/dev/null || true)"
fi
run_user="${run_user:-openclaw}"
id "$run_user" >/dev/null 2>&1 || { echo "Runtime user not found: $run_user" >&2; exit 1; }
[ -f "$current_link/scripts/orkestr-mailbox-postfix.mjs" ] || {
  echo "Mailbox Postfix adapter is missing from $current_link; deploy the matching Orkestr release first." >&2
  exit 1
}

export DEBIAN_FRONTEND=noninteractive
echo "postfix postfix/mailname string $smtp_hostname" | debconf-set-selections
echo "postfix postfix/main_mailer_type select Internet Site" | debconf-set-selections
apt-get update -qq
apt-get install -y -qq postfix ca-certificates >/dev/null
postconf -m | grep -qx socketmap || { echo "This Postfix build does not support socketmap." >&2; exit 1; }

install -d -m 0755 "$(dirname "$env_file")"
touch "$env_file"
chmod 0640 "$env_file"
[ "$ui_env_file" = "$env_file" ] || {
  install -d -m 0755 "$(dirname "$ui_env_file")"
  touch "$ui_env_file"
}

upsert_env_file() {
  local file="$1" key="$2" value="$3" temporary
  temporary="$(mktemp)"
  awk -v key="$key" 'index($0, key "=") != 1 { print }' "$file" > "$temporary"
  printf '%s=%s\n' "$key" "$value" >> "$temporary"
  cat "$temporary" > "$file"
  rm -f "$temporary"
}

upsert_env() {
  local key="$1" value="$2"
  upsert_env_file "$env_file" "$key" "$value"
  [ "$ui_env_file" = "$env_file" ] || upsert_env_file "$ui_env_file" "$key" "$value"
}

read_env_value() {
  local file="$1" key="$2"
  [ -r "$file" ] || return 0
  awk -v key="$key" 'index($0, key "=") == 1 { print substr($0, length(key) + 2); exit }' "$file"
}

remove_env_key() {
  local file="$1" key="$2" temporary
  [ -f "$file" ] || return 0
  temporary="$(mktemp)"
  awk -v key="$key" 'index($0, key "=") != 1 { print }' "$file" > "$temporary"
  cat "$temporary" > "$file"
  rm -f "$temporary"
}

revision="$(git -C "$current_link" rev-parse HEAD 2>/dev/null || date -u +%Y%m%dT%H%M%SZ)"
upsert_env ORKESTR_MAILBOX_DOMAIN "$domain"
upsert_env ORKESTR_MAILBOX_REQUIRE_MTA_READY 1
upsert_env ORKESTR_MAILBOX_MTA_ADAPTER postfix-socketmap
upsert_env ORKESTR_MAILBOX_MTA_PROPAGATION live-socketmap
upsert_env ORKESTR_MAILBOX_MTA_REVISION "$revision"
upsert_env ORKESTR_MAILBOX_MTA_READY 1
upsert_env ORKESTR_MAILBOX_SOCKET_HOST 127.0.0.1
upsert_env ORKESTR_MAILBOX_SOCKET_PORT "${ORKESTR_MAILBOX_SOCKET_PORT:-19096}"
mailbox_token="$(read_env_value "$mta_env_file" ORKESTR_MAILBOX_MTA_TOKEN)"
mailbox_token="${mailbox_token:-$(read_env_value "$ui_env_file" ORKESTR_MAILBOX_MTA_TOKEN)}"
mailbox_token="${mailbox_token:-$(read_env_value "$env_file" ORKESTR_MAILBOX_MTA_TOKEN)}"
mailbox_token="${mailbox_token:-$(openssl rand -hex 32)}"
spool_dir="${ORKESTR_MAILBOX_SPOOL_DIR:-/var/spool/orkestr-mailbox}"
upsert_env ORKESTR_MAILBOX_SPOOL_DIR "$spool_dir"
upsert_env_file "$ui_env_file" ORKESTR_MAILBOX_MTA_TOKEN "$mailbox_token"
[ "$ui_env_file" = "$env_file" ] || remove_env_key "$env_file" ORKESTR_MAILBOX_MTA_TOKEN
install -d -m 0755 "$(dirname "$mta_env_file")"
touch "$mta_env_file"
ui_port="$(read_env_value "$ui_env_file" ORKESTR_PORT)"
ui_port="${ui_port:-$(read_env_value "$env_file" ORKESTR_PORT)}"
upsert_env_file "$mta_env_file" ORKESTR_MAILBOX_API_BASE "http://127.0.0.1:${ui_port:-19812}"
upsert_env_file "$mta_env_file" ORKESTR_MAILBOX_MTA_TOKEN "$mailbox_token"
upsert_env_file "$mta_env_file" ORKESTR_MAILBOX_SOCKET_HOST 127.0.0.1
upsert_env_file "$mta_env_file" ORKESTR_MAILBOX_SOCKET_PORT "${ORKESTR_MAILBOX_SOCKET_PORT:-19096}"
upsert_env_file "$mta_env_file" ORKESTR_MAILBOX_SPOOL_DIR "$spool_dir"
chown root:"$(id -gn "$run_user")" "$mta_env_file"
chmod 0640 "$mta_env_file"
install -d -o "$run_user" -g "$(id -gn "$run_user")" -m 0700 "$spool_dir"

cat > /etc/systemd/system/orkestr-mailbox-postfix.service <<EOF
[Unit]
Description=Orkestr Postfix mailbox recipient map
Documentation=https://github.com/otcan/orkestr
After=network-online.target ${main_unit}
Wants=network-online.target

[Service]
Type=simple
User=$run_user
Group=$(id -gn "$run_user")
WorkingDirectory=$current_link
EnvironmentFile=-$mta_env_file
ExecStart=/usr/bin/node $current_link/scripts/orkestr-mailbox-postfix.mjs serve
Restart=on-failure
RestartSec=2
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

master_cf=/etc/postfix/master.cf
temporary="$(mktemp)"
awk '
  /^# BEGIN ORKESTR MAILBOX$/ { skipping=1; next }
  /^# END ORKESTR MAILBOX$/ { skipping=0; next }
  !skipping { print }
' "$master_cf" > "$temporary"
cat >> "$temporary" <<EOF
# BEGIN ORKESTR MAILBOX
orkestr_mailbox unix  -       n       n       -       -       pipe
  flags=Rq user=$run_user argv=/usr/bin/node $current_link/scripts/orkestr-mailbox-postfix.mjs ingest --sender \${sender} --recipient \${recipient} --original-recipient \${original_recipient}
# END ORKESTR MAILBOX
EOF
cat "$temporary" > "$master_cf"
rm -f "$temporary"

postconf -e "myhostname = $smtp_hostname"
postconf -e "mydestination = localhost.localdomain, localhost"
postconf -e "mynetworks_style = host"
postconf -e "smtpd_relay_restrictions = permit_mynetworks, reject_unauth_destination"
postconf -e "smtpd_recipient_restrictions = permit_mynetworks, reject_unauth_destination"
postconf -e "virtual_mailbox_domains = $domain"
postconf -e "virtual_mailbox_maps = socketmap:inet:127.0.0.1:${ORKESTR_MAILBOX_SOCKET_PORT:-19096}:mailboxes"
postconf -e "virtual_transport = orkestr_mailbox:"
postconf -e "orkestr_mailbox_destination_recipient_limit = 1"
postconf -e "disable_vrfy_command = yes"
postconf -e "smtpd_helo_required = yes"
postconf -e "smtpd_tls_security_level = may"
postconf -e "smtp_tls_security_level = may"
postconf -e "message_size_limit = ${ORKESTR_MAILBOX_POSTFIX_MESSAGE_SIZE_LIMIT:-26214400}"
if [ -r /etc/ssl/certs/ssl-cert-snakeoil.pem ] && [ -r /etc/ssl/private/ssl-cert-snakeoil.key ]; then
  postconf -e "smtpd_tls_cert_file = /etc/ssl/certs/ssl-cert-snakeoil.pem"
  postconf -e "smtpd_tls_key_file = /etc/ssl/private/ssl-cert-snakeoil.key"
fi

systemctl daemon-reload
systemctl enable --now orkestr-mailbox-postfix.service
systemctl restart orkestr-mailbox-postfix.service
postfix check
systemctl enable --now postfix.service
systemctl reload postfix.service
if command -v ufw >/dev/null 2>&1; then
  ufw allow 25/tcp comment "Orkestr inbound mail" >/dev/null
fi
systemctl restart "$main_unit"

systemctl is-active --quiet orkestr-mailbox-postfix.service
systemctl is-active --quiet postfix.service
set -a
. "$mta_env_file"
set +a
probe_ready=0
for _attempt in $(seq 1 40); do
  if /usr/bin/node "$current_link/scripts/orkestr-mailbox-postfix.mjs" probe >/dev/null 2>&1; then
    probe_ready=1
    break
  fi
  sleep 0.25
done
[ "$probe_ready" = 1 ] || /usr/bin/node "$current_link/scripts/orkestr-mailbox-postfix.mjs" probe
echo "Orkestr inbound mailbox transport ready for $domain via $smtp_hostname."
