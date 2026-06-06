#!/usr/bin/env bash
set -euo pipefail
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

usage() {
  cat <<'USAGE'
Deploy Orkestr from an exact git ref into versioned release directories.

Usage:
  scripts/deploy-git-release.sh install [--ref REF] [--channel NAME] [--allow-untagged|--require-tagged] [--no-smoke] [--no-backup] [--sync-workers|--no-sync-workers] [--all-instances|--no-all-instances] [--no-interrupt|--allow-interrupt] [--wait-active] [--active-timeout SECONDS]
  scripts/deploy-git-release.sh rollback [--to RELEASE_ID] [--no-interrupt|--allow-interrupt] [--wait-active] [--active-timeout SECONDS]
  scripts/deploy-git-release.sh status [--json]
  scripts/deploy-git-release.sh --check-only

Environment:
  ORKESTR_ENV_FILE              Environment file. Defaults to /etc/orkestr/orkestr.env.
  ORKESTR_REPO_URL              Git repository URL. Defaults to https://github.com/otcan/orkestr.git.
  ORKESTR_DEPLOY_REF            Branch, tag, or commit to deploy. Defaults to ORKESTR_UPDATE_REF or main.
  ORKESTR_DEPLOY_CHANNEL        Deployment channel label. Defaults to production.
  ORKESTR_DEPLOY_TAGS_ONLY      Require an exact git tag. Defaults to 1 for production, 0 otherwise.
  ORKESTR_DEPLOY_ROOT           Root directory. Defaults to /opt/orkestr.
  ORKESTR_RELEASES_DIR          Release directory. Defaults to $ORKESTR_DEPLOY_ROOT/releases.
  ORKESTR_CURRENT_LINK          Active symlink. Defaults to $ORKESTR_DEPLOY_ROOT/current.
  ORKESTR_REPO_CACHE            Git cache. Defaults to $ORKESTR_DEPLOY_ROOT/repo-cache.
  ORKESTR_DEPLOY_HISTORY        JSON deployment history. Defaults to $ORKESTR_DEPLOY_ROOT/deployments.json.
  ORKESTR_DEPLOY_BACKUP_DIR     State backup directory. Defaults to $ORKESTR_DEPLOY_ROOT/backups.
  ORKESTR_DEPLOY_LOCK_FILE      Lock file. Defaults to /var/lock/orkestr-deploy.lock.
  ORKESTR_DEPLOY_RUN_SMOKE      Run npm smoke before activation. Defaults to 1.
  ORKESTR_DEPLOY_BACKUP_STATE   Back up ORKESTR_HOME before activation. Defaults to 1.
  ORKESTR_DEPLOY_BACKUP_EXCLUDES Space-separated paths under ORKESTR_HOME to omit from backups. Defaults to live runtime/session dirs.
  ORKESTR_DEPLOY_SYNC_WORKERS   Fast-forward and push safe stale worker branches after deploy. Defaults to 1.
  ORKESTR_RELEASE_TRAIN_FANOUT  Deploy eligible broker-listed instances after local deploy. Defaults to 0.
  ORKESTR_RELEASE_REQUIRED_WHATSAPP_ACCOUNTS Space/comma-separated WA accounts that must be ready after restart.
  ORKESTR_RELEASE_CONNECTIVITY_RECOVERY_COMMAND Command to run between required-account retry attempts.
  ORKESTR_DEPLOY_LOCK_BUSY_EXIT_CODE Exit code when another deploy holds the lock. Defaults to 0.
  ORKESTR_DEPLOY_HEALTH_URL     Health URL. Defaults to http://$ORKESTR_HOST:$ORKESTR_PORT/api/health.
  ORKESTR_DEPLOY_EXPOSURE_CHECK Check public no-cookie API exposure after restart. Defaults to 1.
  ORKESTR_DEPLOY_PUBLIC_BASE_URL Public app URL to probe. Defaults to configured Orkestr public URLs or /api/setup/status.
  ORKESTR_DEPLOY_EXPOSURE_PRIVATE_PATHS Space-separated private paths that must return 401 before auth.
  ORKESTR_DEPLOY_NO_INTERRUPT   Refuse to restart while thread work is active. Defaults to 1.
  ORKESTR_DEPLOY_WAIT_ACTIVE    Wait for active thread work before restart. Defaults to 0.
  ORKESTR_DEPLOY_ACTIVE_TIMEOUT_SECONDS  Max wait with --wait-active. Defaults to 900.
  ORKESTR_DEPLOY_ACTIVE_CHECK_URL Thread summary URL. Defaults to http://$ORKESTR_HOST:$ORKESTR_PORT/api/threads?scope=all.
  ORKESTR_DEPLOY_DRAIN_FILE     Drain marker file. Defaults to $ORKESTR_HOME/deploy-drain.json.
  ORKESTR_RELEASE_WA_NOTIFICATIONS Send WhatsApp release notifications to non-admin external chats. Defaults to 1.
  ORKESTR_RELEASE_WA_NOTIFY_EXCLUDE_CHAT_IDS Exclude specific WhatsApp chat ids from release notifications.
  ORKESTR_CODEX_APP_SERVER_MODE If external/proxy/daemon, active codex-app-server turns are restart-safe.
  ORKESTR_CODEX_APP_SERVER_SOCKET  Unix socket for the external Codex app-server.
  ORKESTR_CODEX_APP_SERVER_SERVICE_NAME  External Codex app-server systemd unit. Defaults to $ORKESTR_SERVICE_NAME-codex.
  ORKESTR_SERVICE_NAME          systemd service name. Defaults to orkestr.
  ORKESTR_SERVICE_TIMEOUT_STOP_SEC systemd stop timeout for Orkestr. Defaults to 15s.
  ORKESTR_BUILD_WEB_FROM_SOURCE Set to 1 to install dev dependencies and rebuild the Angular web app.

The app code is versioned. ORKESTR_HOME and /etc/orkestr/orkestr.env stay
outside release directories and are backed up before activation.
USAGE
}

command="install"
ref_arg=""
channel_arg=""
to_release=""
json_output=0
check_only=0
run_smoke_arg=""
tags_only_arg=""
backup_state_arg=""
sync_workers_arg=""
fanout_arg=""
no_interrupt_arg=""
wait_active_arg=""
active_timeout_arg=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    install|rollback|status)
      command="$1"
      shift
      ;;
    --ref)
      ref_arg="${2:-}"
      shift 2
      ;;
    --channel)
      channel_arg="${2:-}"
      shift 2
      ;;
    --to)
      to_release="${2:-}"
      shift 2
      ;;
    --json)
      json_output=1
      shift
      ;;
    --no-smoke)
      run_smoke_arg=0
      shift
      ;;
    --smoke)
      run_smoke_arg=1
      shift
      ;;
    --allow-untagged|--allow-untagged-releases)
      tags_only_arg=0
      shift
      ;;
    --require-tagged|--require-tagged-releases)
      tags_only_arg=1
      shift
      ;;
    --no-backup)
      backup_state_arg=0
      shift
      ;;
    --sync-workers)
      sync_workers_arg=1
      shift
      ;;
    --no-sync-workers)
      sync_workers_arg=0
      shift
      ;;
    --all-instances)
      fanout_arg=1
      shift
      ;;
    --no-all-instances)
      fanout_arg=0
      shift
      ;;
    --no-interrupt)
      no_interrupt_arg=1
      shift
      ;;
    --allow-interrupt)
      no_interrupt_arg=0
      shift
      ;;
    --wait-active)
      wait_active_arg=1
      shift
      ;;
    --no-wait-active)
      wait_active_arg=0
      shift
      ;;
    --active-timeout)
      active_timeout_arg="${2:-}"
      shift 2
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
    bash -n "$env_file"
    set -a
    # shellcheck disable=SC1090
    . "$env_file"
    set +a
  fi
}

json_string() {
  node -e 'process.stdout.write(JSON.stringify(process.argv[1] || ""))' "$1"
}

sanitize_id() {
  printf '%s' "$1" | LC_ALL=C tr -c 'A-Za-z0-9._+-' '-'
}

bool_value() {
  case "$(printf '%s' "${1:-}" | LC_ALL=C tr '[:upper:]' '[:lower:]')" in
    1|true|yes|on) echo 1 ;;
    0|false|no|off) echo 0 ;;
    *) echo "${1:-}" ;;
  esac
}

health_check() {
  local url attempts
  url="$1"
  attempts="${2:-40}"
  for _ in $(seq 1 "$attempts"); do
    if curl -fsS "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.5
  done
  echo "Health check failed: $url" >&2
  return 1
}

public_exposure_base_url() {
  local configured setup_url setup_json
  configured="${ORKESTR_DEPLOY_PUBLIC_BASE_URL:-${ORKESTR_PUBLIC_APP_URL:-${ORKESTR_PUBLIC_URL:-${ORKESTR_APP_URL:-${ORKESTR_PUBLIC_HTTPS_URL:-${ORKESTR_HTTPS_URL:-${ORKESTR_TAILSCALE_HTTPS_NAME:-}}}}}}}"
  configured="${configured%/}"
  if [ -n "$configured" ]; then
    printf '%s\n' "$configured"
    return 0
  fi
  setup_url="http://$host:$port/api/setup/status"
  setup_json="$(curl -fsS "$setup_url" --max-time 8 2>/dev/null || true)"
  if [ -z "$setup_json" ]; then
    return 0
  fi
  node -e 'const j = JSON.parse(process.argv[1] || "{}"); process.stdout.write(String(j.urls?.appUrl || j.urls?.authUrl || ""));' "$setup_json" 2>/dev/null | sed 's|/*$||'
}

public_exposure_url_is_local() {
  node -e 'const value = process.argv[1] || ""; try { const host = new URL(value).hostname.toLowerCase(); process.exit(["localhost", "127.0.0.1", "::1"].includes(host) ? 0 : 1); } catch { process.exit(1); }' "$1"
}

deploy_public_exposure_check() {
  local base path url code paths curl_args blocked_count
  if [ "$exposure_check" != "1" ]; then
    echo "Public exposure check disabled."
    return 0
  fi
  base="$(public_exposure_base_url)"
  base="${base%/}"
  if [ -z "$base" ]; then
    echo "Public exposure check skipped: no public app URL configured."
    return 0
  fi
  if public_exposure_url_is_local "$base"; then
    echo "Public exposure check skipped: configured app URL is local-only ($base)."
    return 0
  fi
  paths="${exposure_private_paths:-}"
  curl_args=(-sS -o /dev/null -w '%{http_code}' --max-time "$exposure_timeout_seconds")
  if [ "$exposure_curl_insecure" = "1" ]; then
    curl_args=(-k "${curl_args[@]}")
  fi
  blocked_count=0
  for path in $paths; do
    [ -n "$path" ] || continue
    url="$base$path"
    code="$(curl "${curl_args[@]}" "$url" 2>/dev/null || true)"
    if [ -z "$code" ]; then
      code="000"
    fi
    if printf '%s' "$code" | grep -Eq '^0+$'; then
      blocked_count=$((blocked_count + 1))
      continue
    fi
    if [ "$code" != "401" ]; then
      echo "Public exposure check failed: unauthenticated $url returned HTTP $code; expected 401." >&2
      echo "Refusing to mark deploy healthy because a private API may be exposed." >&2
      return 1
    fi
  done
  if [ "$blocked_count" -gt 0 ]; then
    echo "Public exposure check passed: unauthenticated private APIs returned 401 or were blocked by TLS/network from $base."
    return 0
  fi
  echo "Public exposure check passed: unauthenticated private APIs returned 401 from $base."
}

write_history_event() {
  local status release_id ref commit previous_release release_dir backup_path error
  status="$1"
  release_id="$2"
  ref="$3"
  commit="$4"
  previous_release="$5"
  release_dir="$6"
  backup_path="$7"
  error="${8:-}"
  mkdir -p "$(dirname "$deploy_history")"
  node - "$deploy_history" \
    "$status" "$release_id" "$ref" "$commit" "$previous_release" "$release_dir" "$backup_path" "$error" "$deploy_channel" "$service_name" <<'NODE'
const fs = require("node:fs");
const [file, status, releaseId, ref, commit, previousRelease, releaseDir, backupPath, error, channel, serviceName] = process.argv.slice(2);
let history = [];
try {
  history = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!Array.isArray(history)) history = [];
} catch {}
history.push({
  status,
  releaseId,
  ref,
  commit,
  previousRelease: previousRelease || null,
  releaseDir,
  backupPath: backupPath || null,
  error: error || null,
  channel,
  serviceName,
  deployedAt: new Date().toISOString(),
});
fs.writeFileSync(file, `${JSON.stringify(history.slice(-200), null, 2)}\n`);
NODE
}

current_release_id() {
  if [ -L "$current_link" ]; then
    basename "$(readlink -f "$current_link")"
  else
    echo ""
  fi
}

resolve_target_ref() {
  local ref
  ref="$1"
  if git -C "$repo_cache" rev-parse --verify --quiet "origin/$ref^{commit}" >/dev/null; then
    git -C "$repo_cache" rev-parse "origin/$ref^{commit}"
    return 0
  fi
  if git -C "$repo_cache" rev-parse --verify --quiet "$ref^{commit}" >/dev/null; then
    git -C "$repo_cache" rev-parse "$ref^{commit}"
    return 0
  fi
  return 1
}

prepare_repo_cache() {
  mkdir -p "$(dirname "$repo_cache")"
  if [ -d "$repo_cache/.git" ]; then
    git -C "$repo_cache" remote set-url origin "$repo_url"
    git -C "$repo_cache" fetch --prune --tags origin
  else
    git clone --no-checkout "$repo_url" "$repo_cache"
    git -C "$repo_cache" fetch --prune --tags origin
  fi
}

backup_state() {
  local stamp target backup_name data_dir data_base data_parent exclude tar_args
  if [ "$run_backup" != "1" ]; then
    echo ""
    return 0
  fi
  data_dir="${ORKESTR_HOME:-}"
  if [ -z "$data_dir" ] || [ ! -d "$data_dir" ]; then
    echo ""
    return 0
  fi
  mkdir -p "$backup_dir"
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  target="$(sanitize_id "$release_id")"
  backup_name="$backup_dir/${stamp}-${target}-state.tar.gz"
  data_parent="$(dirname "$data_dir")"
  data_base="$(basename "$data_dir")"
  tar_args=(-C "$data_parent" -czf "$backup_name")
  for exclude in $backup_excludes; do
    [ -n "$exclude" ] || continue
    case "$exclude" in
      /*) tar_args+=(--exclude="$exclude") ;;
      *) tar_args+=(--exclude="$data_base/$exclude") ;;
    esac
  done
  tar "${tar_args[@]}" "$data_base"
  echo "$backup_name"
}

activate_release() {
  local release_dir next_link
  release_dir="$1"
  if [ -e "$current_link" ] && [ ! -L "$current_link" ]; then
    echo "Refusing to replace non-symlink current path: $current_link" >&2
    exit 1
  fi
  mkdir -p "$(dirname "$current_link")"
  next_link="${current_link}.next"
  ln -sfn "$release_dir" "$next_link"
  mv -Tf "$next_link" "$current_link"
}

env_sed_value() {
  printf '%s' "$1" | sed 's/[&|]/\\&/g'
}

set_env_assignment() {
  local name value escaped
  name="$1"
  value="$2"
  [ -f "$env_file_path" ] || return 0
  escaped="$(env_sed_value "$value")"
  if grep -q "^${name}=" "$env_file_path"; then
    sed -i "s|^${name}=.*|${name}=${escaped}|" "$env_file_path"
  else
    printf '%s=%s\n' "$name" "$value" >> "$env_file_path"
  fi
}

sync_versioned_env() {
  [ -f "$env_file_path" ] || return 0
  set_env_assignment ORKESTR_APP_DIR "$current_link"
  set_env_assignment ORKESTR_RELEASE_DEPLOY "1"
  set_env_assignment ORKESTR_CURRENT_LINK "$current_link"
}

send_release_whatsapp_notifications() {
  local release_dir target_ref deployed_at api_base notify_enabled
  release_dir="$1"
  target_ref="${2:-}"
  deployed_at="${3:-}"
  notify_enabled="$(bool_value "${ORKESTR_RELEASE_WA_NOTIFICATIONS:-1}")"
  if [ "$notify_enabled" != "1" ]; then
    echo "Release WhatsApp notifications disabled."
    return 0
  fi
  if [ ! -f "$release_dir/scripts/release-whatsapp-notify.mjs" ]; then
    echo "Release WhatsApp notifications skipped: target release does not expose notifier."
    return 0
  fi
  api_base="${ORKESTR_API_BASE:-http://$host:$port}"
  if node "$release_dir/scripts/release-whatsapp-notify.mjs" \
    --release-id "$release_id" \
    --channel "$deploy_channel" \
    --commit "$target_ref" \
    --deployed-at "$deployed_at" \
    --api-base "$api_base"; then
    return 0
  fi
  echo "Release WhatsApp notifications failed; deploy remains successful and notification retry is left in the ledger." >&2
  return 0
}

repair_env_file_permissions() {
  if [ "$(id -u)" -ne 0 ] || [ ! -f "$env_file_path" ]; then
    return 0
  fi
  local run_user run_group
  run_user="$(runtime_run_user)"
  if ! id "$run_user" >/dev/null 2>&1; then
    chmod 0640 "$env_file_path" || true
    return 0
  fi
  if [ "$run_user" != "root" ]; then
    run_group="$(id -gn "$run_user")"
    chown "root:$run_group" "$env_file_path" || true
  fi
  chmod 0640 "$env_file_path" || true
}

active_thread_report() {
  if [ ! -f "$script_dir/deploy-active-work-check.mjs" ]; then
    printf '{"ok":false,"unavailable":true,"active":[],"error":"missing_active_work_checker"}\n'
    return 0
  fi
  node "$script_dir/deploy-active-work-check.mjs" --url "$active_check_url" --timeout-ms "$active_check_timeout_ms"
}

active_thread_count() {
  node -e 'const report = JSON.parse(process.argv[1] || "{}"); process.stdout.write(String(Array.isArray(report.active) ? report.active.length : 0));' "$1"
}

active_thread_hard_count() {
  node -e 'const report = JSON.parse(process.argv[1] || "{}"); const states = new Set(["working","processing","running","waking"]); const active = Array.isArray(report.active) ? report.active : []; const count = active.filter((thread) => Boolean(thread.activeTurnId) || Number(thread.runningCount || 0) > 0 || Number(thread.awaitingAckCount || 0) > 0 || states.has(String(thread.state || "").toLowerCase())).length; process.stdout.write(String(count));' "$1"
}

active_thread_unsafe_count() {
  node -e 'const report = JSON.parse(process.argv[1] || "{}"); const active = Array.isArray(report.active) ? report.active : []; const safeTransports = new Set(["proxy", "websocket"]); const restartSafe = (thread) => String(thread.runtimeKind || "").toLowerCase() === "codex-app-server" && safeTransports.has(String(thread.codexAppServerTransport || thread.appServerTransport || "").toLowerCase()); const unsafe = active.filter((thread) => !restartSafe(thread)); process.stdout.write(String(unsafe.length));' "$1"
}

active_report_unavailable() {
  node -e 'const report = JSON.parse(process.argv[1] || "{}"); process.stdout.write(report.unavailable ? "1" : "0");' "$1"
}

active_report_error() {
  node -e 'const report = JSON.parse(process.argv[1] || "{}"); process.stdout.write(String(report.error || ""));' "$1"
}

service_is_active() {
  systemctl is-active --quiet "${service_name}.service" >/dev/null 2>&1
}

codex_app_server_socket_default() {
  echo "${ORKESTR_CODEX_APP_SERVER_SOCKET:-${ORKESTR_HOME:-$deploy_root/data}/run/codex-app-server.sock}"
}

codex_command_supports_external_app_server() {
  local command
  command="${1:-codex}"
  "$command" app-server --help >/dev/null 2>&1 || return 1
  "$command" app-server proxy --help >/dev/null 2>&1 || return 1
}

codex_app_server_service_is_active() {
  systemctl is-active --quiet "${codex_app_server_service_name}.service" >/dev/null 2>&1
}

codex_app_server_external_enabled() {
  case "$codex_app_server_mode" in
    external|proxy|daemon)
      codex_app_server_service_is_active
      ;;
    *)
      return 1
      ;;
  esac
}

target_release_supports_external_codex_app_server() {
  local release_dir
  release_dir="$1"
  [ -f "$release_dir/packages/connectors/src/codex-app-server-transport.js" ] || return 1
  grep -q "codexAppServerClientArgs" "$release_dir/packages/core/src/codex-app-server-client.js" 2>/dev/null || return 1
}

write_codex_app_server_wrapper() {
  cat > /usr/local/bin/orkestr-codex-app-server <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
env_file="${ORKESTR_ENV_FILE:-/etc/orkestr/orkestr.env}"
if [ -r "$env_file" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$env_file"
  set +a
fi
socket="${ORKESTR_CODEX_APP_SERVER_SOCKET:-${ORKESTR_HOME:-/opt/orkestr/data}/run/codex-app-server.sock}"
codex_bin="${ORKESTR_CODEX_BIN:-codex}"
mkdir -p "$(dirname "$socket")"
rm -f "$socket"
umask 077
exec "$codex_bin" app-server --listen "unix://$socket"
EOF
  chmod 0755 /usr/local/bin/orkestr-codex-app-server
}

write_codex_app_server_systemd_service() {
  local run_user run_group workdir
  run_user="$(runtime_run_user)"
  if ! id "$run_user" >/dev/null 2>&1; then
    echo "Cannot configure external Codex app-server: run user does not exist: $run_user" >&2
    return 1
  fi
  run_group="$(id -gn "$run_user")"
  workdir="$current_link"
  [ -d "$workdir" ] || workdir="$deploy_root"
  cat > "/etc/systemd/system/${codex_app_server_service_name}.service" <<EOF
[Unit]
Description=Orkestr Codex app-server runtime
Documentation=https://github.com/otcan/orkestr
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$run_user
Group=$run_group
WorkingDirectory=$workdir
EnvironmentFile=-$env_file_path
ExecStart=/usr/local/bin/orkestr-codex-app-server
Restart=on-failure
RestartSec=3
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable "${codex_app_server_service_name}.service"
  systemctl restart "${codex_app_server_service_name}.service"
}

write_codex_app_server_main_service_dropin() {
  local dropin_dir socket escaped_socket escaped_service
  socket="$(codex_app_server_socket_default)"
  escaped_socket="$(printf '%s' "$socket" | sed 's/\\/\\\\/g; s/"/\\"/g')"
  escaped_service="$(printf '%s' "$codex_app_server_service_name" | sed 's/\\/\\\\/g; s/"/\\"/g')"
  dropin_dir="/etc/systemd/system/${service_name}.service.d"
  mkdir -p "$dropin_dir"
  cat > "$dropin_dir/60-codex-app-server.conf" <<EOF
[Service]
Environment=ORKESTR_CODEX_APP_SERVER_MODE=external
Environment="ORKESTR_CODEX_APP_SERVER_SOCKET=$escaped_socket"
Environment="ORKESTR_CODEX_APP_SERVER_SERVICE_NAME=$escaped_service"
EOF
  systemctl daemon-reload
}

ensure_codex_app_server_split_for_target() {
  local release_dir command socket mode_external_requested
  release_dir="$1"
  target_release_supports_external_codex_app_server "$release_dir" || return 0
  mode_external_requested=0
  case "$codex_app_server_mode" in
    external|proxy|daemon) mode_external_requested=1 ;;
  esac
  if [ "$mode_external_requested" = "1" ] && codex_app_server_service_is_active; then
    if [ "$(id -u)" -eq 0 ]; then
      write_codex_app_server_main_service_dropin
    fi
    return 0
  fi
  if [ "$(id -u)" -ne 0 ]; then
    if [ "$mode_external_requested" = "1" ]; then
      echo "External Codex app-server is configured but ${codex_app_server_service_name}.service is not active." >&2
      echo "Run deploy as root so it can repair the Codex runtime service, or start that service first." >&2
      exit 75
    fi
    echo "Skipping external Codex app-server setup because deploy is not running as root." >&2
    return 0
  fi
  command="${ORKESTR_CODEX_BIN:-codex}"
  if ! codex_command_supports_external_app_server "$command"; then
    if [ "$mode_external_requested" = "1" ]; then
      echo "External Codex app-server is configured, but Codex does not support app-server proxy." >&2
      echo "Update Codex or set ORKESTR_CODEX_BIN to a compatible Codex CLI before deploying." >&2
      exit 75
    fi
    echo "Codex does not support app-server proxy; keeping conservative in-process deploy behavior." >&2
    return 0
  fi
  [ -f "$env_file_path" ] || { mkdir -p "$(dirname "$env_file_path")"; touch "$env_file_path"; chmod 0640 "$env_file_path" || true; }
  repair_env_file_permissions
  socket="$(codex_app_server_socket_default)"
  set_env_assignment ORKESTR_CODEX_APP_SERVER_MODE external
  set_env_assignment ORKESTR_CODEX_APP_SERVER_SOCKET "$socket"
  set_env_assignment ORKESTR_CODEX_APP_SERVER_SERVICE_NAME "$codex_app_server_service_name"
  mkdir -p "$(dirname "$socket")"
  write_codex_app_server_wrapper
  write_codex_app_server_systemd_service
  write_codex_app_server_main_service_dropin
  codex_app_server_mode="external"
  echo "External Codex app-server ready: ${codex_app_server_service_name}.service ($socket)."
}

print_active_thread_report() {
  node - "$1" "${2:-all}" <<'NODE'
const report = JSON.parse(process.argv[2] || "{}");
const mode = process.argv[3] || "all";
const hardStates = new Set(["working", "processing", "running", "waking"]);
const hardActive = (thread) => Boolean(thread.activeTurnId) ||
  Number(thread.runningCount || 0) > 0 ||
  Number(thread.awaitingAckCount || 0) > 0 ||
  hardStates.has(String(thread.state || "").toLowerCase());
const safeTransports = new Set(["proxy", "websocket"]);
const restartSafe = (thread) => String(thread.runtimeKind || "").toLowerCase() === "codex-app-server" &&
  safeTransports.has(String(thread.codexAppServerTransport || thread.appServerTransport || "").toLowerCase());
const restartUnsafe = (thread) => !restartSafe(thread);
const active = (Array.isArray(report.active) ? report.active : []).filter((thread) => {
  if (mode === "hard") return hardActive(thread);
  if (mode === "unsafe") return restartUnsafe(thread);
  return true;
});
if (!active.length) {
  console.error("  - no active threads");
  process.exit(0);
}
for (const thread of active) {
  const parts = [
    thread.name || thread.id || "unknown",
    thread.state ? `state=${thread.state}` : "",
    thread.runtimeKind ? `runtime=${thread.runtimeKind}` : "",
    thread.codexAppServerTransport ? `appServer=${thread.codexAppServerTransport}` : "",
    Number(thread.pendingCount || 0) ? `pending=${thread.pendingCount}` : "",
    Number(thread.runningCount || 0) ? `running=${thread.runningCount}` : "",
    Number(thread.awaitingAckCount || 0) ? `awaitingAck=${thread.awaitingAckCount}` : "",
    thread.activeTurnId ? `turn=${thread.activeTurnId}` : "",
  ].filter(Boolean);
  console.error(`  - ${parts.join(" ")}`);
}
NODE
}

begin_deploy_drain() {
  if [ "$no_interrupt" != "1" ] || [ -z "$deploy_drain_file" ]; then
    return 0
  fi
  mkdir -p "$(dirname "$deploy_drain_file")"
  node - "$deploy_drain_file" "$release_id" "$deploy_ref" "$service_name" "$deploy_drain_ttl_seconds" <<'NODE'
const fs = require("node:fs");
const [file, releaseId, ref, serviceName, ttlSeconds] = process.argv.slice(2);
const ttlMs = Math.max(60, Number(ttlSeconds) || 1800) * 1000;
const marker = {
  state: "draining",
  reason: "deploy",
  releaseId: releaseId || null,
  ref: ref || null,
  serviceName: serviceName || null,
  startedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + ttlMs).toISOString(),
};
fs.writeFileSync(file, `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600 });
NODE
  deploy_drain_started=1
  echo "Deploy drain active: new inputs will queue while ${service_name}.service restarts."
}

clear_deploy_drain() {
  if [ -n "$deploy_drain_file" ] && [ -e "$deploy_drain_file" ]; then
    rm -f "$deploy_drain_file"
  fi
  deploy_drain_started=0
}

cleanup_deploy_drain_on_exit() {
  if [ "${deploy_drain_started:-0}" = "1" ]; then
    clear_deploy_drain
  fi
}

deploy_guard_active_work() {
  local mode
  mode="${1:-all}"
  if [ "$no_interrupt" != "1" ]; then
    echo "No-interrupt deploy guard disabled by --allow-interrupt."
    return 0
  fi

  local start deadline report count unavailable error now
  start="$(date +%s)"
  deadline=$((start + active_timeout_seconds))
  while true; do
    report="$(active_thread_report)"
    unavailable="$(active_report_unavailable "$report")"
    if [ "$unavailable" = "1" ]; then
      error="$(active_report_error "$report")"
      if service_is_active; then
        echo "Refusing no-interrupt deploy: active thread state is unavailable${error:+: $error}." >&2
        echo "Use --allow-interrupt to restart anyway, or fix ORKESTR_DEPLOY_ACTIVE_CHECK_URL." >&2
        exit 75
      fi
      echo "No-interrupt deploy guard could not read active thread state; continuing${error:+: $error}." >&2
      return 0
    fi

    if [ "$mode" = "unsafe" ]; then
      count="$(active_thread_unsafe_count "$report")"
    elif [ "$mode" = "hard" ]; then
      count="$(active_thread_hard_count "$report")"
    else
      count="$(active_thread_count "$report")"
    fi
    if [ "$count" -eq 0 ]; then
      return 0
    fi

    if [ "$wait_active" != "1" ]; then
      echo "Refusing no-interrupt deploy: active Orkestr thread work is running." >&2
      print_active_thread_report "$report" "$mode"
      echo "Use --wait-active to wait, or --allow-interrupt to restart anyway." >&2
      exit 75
    fi

    now="$(date +%s)"
    if [ "$now" -ge "$deadline" ]; then
      echo "Timed out waiting for active Orkestr thread work before deploy restart." >&2
      print_active_thread_report "$report" "$mode"
      echo "Use a larger --active-timeout, or --allow-interrupt to restart anyway." >&2
      exit 75
    fi

    echo "Waiting for active Orkestr thread work before deploy restart ($count active)." >&2
    sleep 5
  done
}

deploy_guard_before_restart() {
  local target_release_dir
  target_release_dir="${1:-}"
  if [ -n "$target_release_dir" ] && target_release_supports_external_codex_app_server "$target_release_dir" && codex_app_server_external_enabled; then
    begin_deploy_drain
    deploy_guard_active_work unsafe
    echo "No-interrupt deploy guard: external Codex app-server is active; codex-app-server turns may continue during the UI restart."
    echo "No-interrupt deploy preservation: external Codex app-server turns are preserved while service-local child processes are reaped after the stop timeout."
    return 0
  fi
  deploy_guard_active_work
  begin_deploy_drain
  deploy_guard_active_work hard
}

restart_and_verify() {
  configure_service_shutdown_timeout
  if [ "$no_interrupt" = "1" ] && [ "$deploy_drain_started" = "1" ]; then
    systemctl stop "${service_name}.service"
    systemctl start "${service_name}.service"
  else
    systemctl restart "${service_name}.service"
  fi
  systemctl is-active --quiet "${service_name}.service"
  health_check "$health_url" 40
  deploy_public_exposure_check
  if [ "$deploy_drain_started" = "1" ]; then
    clear_deploy_drain
    echo "Deploy drain cleared after ${service_name}.service passed health checks."
  fi
}

required_whatsapp_account_list() {
  local raw
  raw="${ORKESTR_RELEASE_REQUIRED_WHATSAPP_ACCOUNTS:-${ORKESTR_REQUIRED_WHATSAPP_ACCOUNTS:-}}"
  printf '%s\n' "$raw" | tr ',\n\t' '    ' | xargs 2>/dev/null || true
}

positive_integer_env() {
  local value fallback minimum
  value="${1:-}"
  fallback="$2"
  minimum="${3:-1}"
  case "$value" in
    ""|*[!0-9]*)
      echo "$fallback"
      ;;
    *)
      if [ "$value" -lt "$minimum" ]; then echo "$minimum"; else echo "$value"; fi
      ;;
  esac
}

whatsapp_account_ready() {
  local account payload
  account="$1"
  payload="$(ORKESTR_API_BASE="${ORKESTR_API_BASE:-http://$host:$port}" orkestr whatsapp accounts status "$account" --json 2>/dev/null)" || return 1
  printf '%s' "$payload" | node -e '
const wanted = String(process.argv[1] || "").trim().toLowerCase();
let data = "";
process.stdin.on("data", (chunk) => { data += chunk; });
process.stdin.on("end", () => {
  let payload;
  try { payload = JSON.parse(data || "{}"); } catch { process.exit(1); }
  const status = payload.status && typeof payload.status === "object" ? payload.status : {};
  const health = status.health && typeof status.health === "object" ? status.health : {};
  const accounts = [
    payload.account,
    ...(Array.isArray(status.accounts) ? status.accounts : []),
    ...(Array.isArray(health.accounts) ? health.accounts : []),
  ].filter(Boolean);
  const names = (account) => [
    account.accountId,
    account.id,
    account.label,
    account.runtimeAccountId,
    ...(Array.isArray(account.aliases) ? account.aliases : []),
    ...(Array.isArray(account.legacyRoleAliases) ? account.legacyRoleAliases : []),
  ].map((value) => String(value || "").trim().toLowerCase()).filter(Boolean);
  const ready = (account) => account.ready === true ||
    account.authenticated === true ||
    account.clientReady === true ||
    ["ready", "connected", "paired"].includes(String(account.state || account.status || "").trim().toLowerCase());
  process.exit(accounts.some((account) => ready(account) && names(account).includes(wanted)) ? 0 : 1);
});
' "$account"
}

run_release_connectivity_recovery() {
  local attempt error
  attempt="$1"
  error="$2"
  [ -n "${ORKESTR_RELEASE_CONNECTIVITY_RECOVERY_COMMAND:-}" ] || return 0
  ORKESTR_RELEASE_CONNECTIVITY_RECOVERY=1 \
  ORKESTR_RELEASE_CONNECTIVITY_CHECK=0 \
  ORKESTR_RELEASE_CONNECTIVITY_ATTEMPT="$attempt" \
  ORKESTR_RELEASE_CONNECTIVITY_NEXT_ATTEMPT="$((attempt + 1))" \
  ORKESTR_RELEASE_CONNECTIVITY_ERROR="$error" \
    sh -lc "$ORKESTR_RELEASE_CONNECTIVITY_RECOVERY_COMMAND" || true
}

verify_required_whatsapp_accounts() {
  local required attempts delay_ms attempt missing account error
  required="$(required_whatsapp_account_list)"
  [ -n "$required" ] || return 0
  attempts="$(positive_integer_env "${ORKESTR_RELEASE_CONNECTIVITY_ATTEMPTS:-}" 6 1)"
  delay_ms="$(positive_integer_env "${ORKESTR_RELEASE_CONNECTIVITY_RETRY_DELAY_MS:-}" 15000 0)"
  attempt=1
  while [ "$attempt" -le "$attempts" ]; do
    missing=""
    for account in $required; do
      if ! whatsapp_account_ready "$account"; then
        missing="${missing}${missing:+,}$account"
      fi
    done
    if [ -z "$missing" ]; then
      echo "Release WhatsApp account check passed: $required"
      return 0
    fi
    error="whatsapp_required_accounts_not_ready:$missing"
    if [ "$attempt" -ge "$attempts" ]; then
      echo "Release WhatsApp account check failed: $error" >&2
      return 1
    fi
    echo "Release WhatsApp account check retry $attempt/$attempts: $error" >&2
    run_release_connectivity_recovery "$attempt" "$error"
    if [ "$delay_ms" -gt 0 ]; then
      sleep "$(node -e 'process.stdout.write(String(Math.max(0, Number(process.argv[1] || 0) / 1000)))' "$delay_ms")"
    fi
    attempt="$((attempt + 1))"
  done
}

configure_service_shutdown_timeout() {
  if [ "$(id -u)" -ne 0 ]; then
    return 0
  fi
  local timeout dropin_dir node_bin
  timeout="${ORKESTR_SERVICE_TIMEOUT_STOP_SEC:-15s}"
  case "$timeout" in
    ""|*[!0123456789smhd.]*)
      timeout="15s"
      ;;
  esac
  node_bin="$(command -v node || true)"
  node_bin="${node_bin:-/usr/bin/node}"
  dropin_dir="/etc/systemd/system/${service_name}.service.d"
  mkdir -p "$dropin_dir"
  cat > "$dropin_dir/45-direct-node.conf" <<EOF
[Service]
WorkingDirectory=$current_link
ExecStart=
ExecStart=$node_bin dist/server/apps/server/src/server.js
EOF
  cat > "$dropin_dir/50-shutdown-timeout.conf" <<EOF
[Service]
TimeoutStopSec=$timeout
KillMode=mixed
EOF
  systemctl daemon-reload
}

sync_safe_workers_after_deploy() {
  local release_dir
  release_dir="$1"
  if [ "$sync_workers" != "1" ]; then
    echo "Post-deploy worker sync disabled."
    return 0
  fi
  if [ ! -f "$release_dir/packages/core/src/thread-workers.js" ]; then
    echo "Post-deploy worker sync skipped: target release does not expose thread worker helpers."
    return 0
  fi
  node --input-type=module - "$release_dir" <<'NODE'
import path from "node:path";
import { pathToFileURL } from "node:url";

const releaseDir = process.argv[2];
try {
  const moduleUrl = pathToFileURL(path.join(releaseDir, "packages/core/src/thread-workers.js")).href;
  const { syncSafeThreadWorkersWithParents } = await import(moduleUrl);
  const result = await syncSafeThreadWorkersWithParents({ push: true }, process.env);
  console.log(`Post-deploy worker sync: scanned ${result.scanned}, synced ${result.synced}, pushed ${result.pushed}, skipped ${result.skipped}.`);
  for (const item of result.results || []) {
    if (!item.synced && item.reason === "already_synced") continue;
    const name = item.name || item.threadId || "worker";
    const detail = [
      item.reason || (item.synced ? "synced" : "skipped"),
      item.gitParentBehind === null || item.gitParentBehind === undefined ? "" : `parentBehind=${item.gitParentBehind}`,
      item.gitParentAhead === null || item.gitParentAhead === undefined ? "" : `parentAhead=${item.gitParentAhead}`,
      item.gitDirtyFiles === null || item.gitDirtyFiles === undefined ? "" : `dirty=${item.gitDirtyFiles}`,
      item.error ? `error=${item.error}` : "",
    ].filter(Boolean).join(" ");
    console.log(`Post-deploy worker ${item.synced ? "synced" : "skipped"}: ${name}${detail ? ` (${detail})` : ""}`);
  }
} catch (error) {
  console.error(`Post-deploy worker sync skipped: ${error?.stack || error?.message || String(error)}`);
}
process.exit(0);
NODE
}

release_train_instance_fanout() {
  local release_dir target_ref fanout
  release_dir="$1"
  target_ref="$2"
  fanout="$(bool_value "${fanout_arg:-${ORKESTR_RELEASE_TRAIN_FANOUT:-0}}")"
  if [ ! -f "$release_dir/scripts/release-instance-broker.mjs" ]; then
    echo "Release instance broker skipped: target release does not expose broker script."
    return 0
  fi
  if [ "$fanout" = "1" ]; then
    echo "Release instance broker: deploying eligible remote instances."
    (cd "$release_dir" && node scripts/release-instance-broker.mjs deploy \
      --ref "$target_ref" \
      --channel "$deploy_channel")
    return $?
  fi
  echo "Release instance broker: fan-out disabled; planning broker-listed instances."
  (cd "$release_dir" && node scripts/release-instance-broker.mjs plan \
    --ref "$target_ref" \
    --channel "$deploy_channel") || true
}

status_command() {
  local active
  active="$(current_release_id)"
  if [ "$json_output" -eq 1 ]; then
    printf '{"currentRelease":%s,"currentLink":%s,"history":%s}\n' \
      "$(json_string "$active")" \
      "$(json_string "$current_link")" \
      "$(json_string "$deploy_history")"
    return 0
  fi
  echo "Current release: ${active:-none}"
  echo "Current link: $current_link"
  echo "History: $deploy_history"
}

runtime_run_user() {
  local user main_pid
  user="${ORKESTR_RUN_USER:-}"
  if [ -z "$user" ] && command -v systemctl >/dev/null 2>&1; then
    user="$(systemctl show -p User --value "${service_name:-orkestr}.service" 2>/dev/null || true)"
    if [ -z "$user" ]; then
      main_pid="$(systemctl show -p MainPID --value "${service_name:-orkestr}.service" 2>/dev/null || true)"
      if [ -n "$main_pid" ] && [ "$main_pid" != "0" ] && command -v ps >/dev/null 2>&1; then
        user="$(ps -o user= -p "$main_pid" 2>/dev/null | awk '{print $1}' || true)"
      fi
    fi
  fi
  echo "${user:-root}"
}

repair_runtime_ownership() {
  if [ "$(id -u)" -ne 0 ]; then
    return 0
  fi
  local run_user run_group runtime_home runtime_run_dir codex_home
  run_user="$(runtime_run_user)"
  if ! id "$run_user" >/dev/null 2>&1; then
    return 0
  fi
  run_group="$(id -gn "$run_user")"
  runtime_home="${ORKESTR_HOME:-/opt/orkestr/data}"
  runtime_run_dir="$(dirname "$(codex_app_server_socket_default)")"
  codex_home="${CODEX_HOME:-$runtime_home/codex}"
  mkdir -p "$runtime_home" "$runtime_run_dir"
  chown "$run_user:$run_group" "$runtime_home" "$runtime_run_dir"
  mkdir -p "$codex_home"
  chown -R "$run_user:$run_group" "$codex_home"
  chmod 0700 "$codex_home"
}

install_command() {
  local target_ref target_tag target_describe short_sha tag_required release_dir previous_release backup_path deployed_at fanout_status
  prepare_repo_cache
  target_ref="$(resolve_target_ref "$deploy_ref")"
  target_tag="$(git -C "$repo_cache" describe --tags --exact-match "$target_ref" 2>/dev/null || true)"
  target_describe="$(git -C "$repo_cache" describe --tags --always --long "$target_ref" 2>/dev/null || echo "$target_ref")"
  tag_required="${tags_only_arg:-${ORKESTR_DEPLOY_TAGS_ONLY:-}}"
  if [ -z "$tag_required" ]; then
    if [ "$deploy_channel" = "production" ]; then tag_required=1; else tag_required=0; fi
  fi
  if [ "$tag_required" = "1" ] && [ -z "$target_tag" ]; then
    echo "Refusing production deploy without an exact git tag for $deploy_ref ($target_ref)." >&2
    exit 1
  fi
  short_sha="$(printf '%s' "$target_ref" | cut -c1-12)"
  release_id="$(sanitize_id "${target_tag:-$deploy_channel-$short_sha}")"
  release_dir="$releases_dir/$release_id"
  previous_release="$(current_release_id)"
  deployed_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  if [ -f "$release_dir/release-manifest.json" ]; then
    deployed_at="$(node -e 'try { const fs = require("node:fs"); const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); process.stdout.write(String(manifest.deployedAt || "")); } catch {}' "$release_dir/release-manifest.json" 2>/dev/null || true)"
    if [ -z "$deployed_at" ]; then
      deployed_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    fi
  fi
  if [ "$previous_release" = "$release_id" ] && [ -d "$release_dir" ]; then
    repair_runtime_ownership
    echo "Orkestr already at $release_id ($target_ref)."
    return 0
  fi

  if [ ! -e "$release_dir/.git" ]; then
    mkdir -p "$releases_dir"
    git -C "$repo_cache" worktree add --detach "$release_dir" "$target_ref"
    (cd "$release_dir" && bash scripts/install-runtime-deps.sh)
    npm --prefix "$release_dir" run build:runtime
    node "$release_dir/scripts/release-manifest.mjs" \
      --cwd "$release_dir" \
      --output "$release_dir/release-manifest.json" \
      --repo "$repo_url" \
      --ref "$deploy_ref" \
      --commit "$target_ref" \
      --tag "$target_tag" \
      --describe "$target_describe" \
      --channel "$deploy_channel" \
      --release-id "$release_id" \
      --service "$service_name" \
      --deployed-at "$deployed_at"
    if [ "$run_smoke" = "1" ]; then
      npm --prefix "$release_dir" run smoke
    fi
    npm --prefix "$release_dir" prune --omit=dev
  fi

  repair_runtime_ownership
  deploy_guard_before_restart "$release_dir"
  ensure_codex_app_server_split_for_target "$release_dir"
  backup_path="$(backup_state)"
  activate_release "$release_dir"
  sync_versioned_env
  if restart_and_verify; then
    if ! verify_required_whatsapp_accounts; then
      write_history_event "failed" "$release_id" "$deploy_ref" "$target_ref" "$previous_release" "$release_dir" "$backup_path" "whatsapp_required_accounts_not_ready"
      exit 1
    fi
    fanout_status=0
    release_train_instance_fanout "$release_dir" "$target_ref" || fanout_status=$?
    send_release_whatsapp_notifications "$release_dir" "$target_ref" "$deployed_at"
    sync_safe_workers_after_deploy "$release_dir"
    write_history_event "success" "$release_id" "$deploy_ref" "$target_ref" "$previous_release" "$release_dir" "$backup_path"
    echo "Orkestr deployed $release_id ($target_ref)."
    if [ "$fanout_status" -ne 0 ]; then
      echo "Release instance broker failed for one or more remote instances." >&2
      exit "$fanout_status"
    fi
  else
    write_history_event "failed" "$release_id" "$deploy_ref" "$target_ref" "$previous_release" "$release_dir" "$backup_path" "health_check_failed"
    exit 1
  fi
}

rollback_command() {
  local target release_dir previous_release backup_path commit
  if [ -n "$to_release" ]; then
    target="$to_release"
  else
    target="$(node - "$deploy_history" "$(current_release_id)" <<'NODE'
const fs = require("node:fs");
const [file, current] = process.argv.slice(2);
let history = [];
try { history = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
const previous = [...history].reverse().find((entry) => entry.status === "success" && entry.releaseId && entry.releaseId !== current);
if (previous) process.stdout.write(previous.releaseId);
NODE
)"
  fi
  if [ -z "$target" ]; then
    echo "No previous release found for rollback." >&2
    exit 1
  fi
  release_dir="$releases_dir/$target"
  if [ ! -d "$release_dir" ]; then
    echo "Rollback target does not exist: $release_dir" >&2
    exit 1
  fi
  previous_release="$(current_release_id)"
  commit="$(git -C "$release_dir" rev-parse HEAD 2>/dev/null || true)"
  repair_runtime_ownership
  deploy_guard_before_restart "$release_dir"
  ensure_codex_app_server_split_for_target "$release_dir"
  backup_path="$(backup_state)"
  activate_release "$release_dir"
  sync_versioned_env
  if restart_and_verify; then
    write_history_event "rollback" "$target" "$target" "$commit" "$previous_release" "$release_dir" "$backup_path"
    echo "Orkestr rolled back to $target."
  else
    write_history_event "rollback_failed" "$target" "$target" "$commit" "$previous_release" "$release_dir" "$backup_path" "health_check_failed"
    exit 1
  fi
}

load_env

env_file_path="${ORKESTR_ENV_FILE:-/etc/orkestr/orkestr.env}"
deploy_root="${ORKESTR_DEPLOY_ROOT:-/opt/orkestr}"
releases_dir="${ORKESTR_RELEASES_DIR:-$deploy_root/releases}"
current_link="${ORKESTR_CURRENT_LINK:-$deploy_root/current}"
repo_cache="${ORKESTR_REPO_CACHE:-$deploy_root/repo-cache}"
deploy_history="${ORKESTR_DEPLOY_HISTORY:-$deploy_root/deployments.json}"
backup_dir="${ORKESTR_DEPLOY_BACKUP_DIR:-$deploy_root/backups}"
repo_url="${ORKESTR_REPO_URL:-https://github.com/otcan/orkestr.git}"
deploy_ref="${ref_arg:-${ORKESTR_DEPLOY_REF:-${ORKESTR_UPDATE_REF:-main}}}"
deploy_channel="${channel_arg:-${ORKESTR_DEPLOY_CHANNEL:-production}}"
service_name="${ORKESTR_SERVICE_NAME:-orkestr}"
codex_app_server_mode="$(printf '%s' "${ORKESTR_CODEX_APP_SERVER_MODE:-stdio}" | LC_ALL=C tr '[:upper:]' '[:lower:]')"
codex_app_server_socket="${ORKESTR_CODEX_APP_SERVER_SOCKET:-}"
codex_app_server_service_name="${ORKESTR_CODEX_APP_SERVER_SERVICE_NAME:-${service_name}-codex}"
repair_env_file_permissions
host="${ORKESTR_HOST:-127.0.0.1}"
port="${ORKESTR_PORT:-19812}"
health_url="${ORKESTR_DEPLOY_HEALTH_URL:-http://$host:$port/api/health}"
exposure_check="$(bool_value "${ORKESTR_DEPLOY_EXPOSURE_CHECK:-1}")"
exposure_private_paths="${ORKESTR_DEPLOY_EXPOSURE_PRIVATE_PATHS:-/api/threads /api/users /api/timers /api/browser-sessions /api/desktops/leases /api/connectors /api/whereiam}"
exposure_timeout_seconds="${ORKESTR_DEPLOY_EXPOSURE_TIMEOUT_SECONDS:-12}"
exposure_curl_insecure="$(bool_value "${ORKESTR_DEPLOY_EXPOSURE_CURL_INSECURE:-0}")"
run_smoke="${run_smoke_arg:-${ORKESTR_DEPLOY_RUN_SMOKE:-1}}"
run_backup="${backup_state_arg:-${ORKESTR_DEPLOY_BACKUP_STATE:-1}}"
backup_excludes="${ORKESTR_DEPLOY_BACKUP_EXCLUDES:-run tmp whatsapp-bridge/sessions}"
sync_workers="$(bool_value "${sync_workers_arg:-${ORKESTR_DEPLOY_SYNC_WORKERS:-1}}")"
lock_file="${ORKESTR_DEPLOY_LOCK_FILE:-/var/lock/orkestr-deploy.lock}"
lock_busy_exit_code="${ORKESTR_DEPLOY_LOCK_BUSY_EXIT_CODE:-0}"
no_interrupt="$(bool_value "${no_interrupt_arg:-${ORKESTR_DEPLOY_NO_INTERRUPT:-1}}")"
wait_active="$(bool_value "${wait_active_arg:-${ORKESTR_DEPLOY_WAIT_ACTIVE:-0}}")"
active_timeout_seconds="${active_timeout_arg:-${ORKESTR_DEPLOY_ACTIVE_TIMEOUT_SECONDS:-900}}"
active_check_url="${ORKESTR_DEPLOY_ACTIVE_CHECK_URL:-http://$host:$port/api/threads?scope=all}"
active_check_timeout_ms="${ORKESTR_DEPLOY_ACTIVE_CHECK_TIMEOUT_MS:-10000}"
deploy_drain_file="${ORKESTR_DEPLOY_DRAIN_FILE:-${ORKESTR_HOME:-$deploy_root/data}/deploy-drain.json}"
deploy_drain_ttl_seconds="${ORKESTR_DEPLOY_DRAIN_TTL_SECONDS:-1800}"
deploy_drain_started=0
release_id=""

case "$no_interrupt" in
  0|1) ;;
  *) echo "ORKESTR_DEPLOY_NO_INTERRUPT must be 0 or 1." >&2; exit 2 ;;
esac
case "$wait_active" in
  0|1) ;;
  *) echo "ORKESTR_DEPLOY_WAIT_ACTIVE must be 0 or 1." >&2; exit 2 ;;
esac
case "$sync_workers" in
  0|1) ;;
  *) echo "ORKESTR_DEPLOY_SYNC_WORKERS must be 0 or 1." >&2; exit 2 ;;
esac
case "$exposure_check" in
  0|1) ;;
  *) echo "ORKESTR_DEPLOY_EXPOSURE_CHECK must be 0 or 1." >&2; exit 2 ;;
esac
case "$exposure_curl_insecure" in
  0|1) ;;
  *) echo "ORKESTR_DEPLOY_EXPOSURE_CURL_INSECURE must be 0 or 1." >&2; exit 2 ;;
esac
case "$active_timeout_seconds" in
  ''|*[!0-9]*) echo "ORKESTR_DEPLOY_ACTIVE_TIMEOUT_SECONDS must be a non-negative integer." >&2; exit 2 ;;
esac
case "$exposure_timeout_seconds" in
  ''|*[!0-9]*) echo "ORKESTR_DEPLOY_EXPOSURE_TIMEOUT_SECONDS must be a positive integer." >&2; exit 2 ;;
esac
case "$active_check_timeout_ms" in
  ''|*[!0-9]*) echo "ORKESTR_DEPLOY_ACTIVE_CHECK_TIMEOUT_MS must be a positive integer." >&2; exit 2 ;;
esac
case "$lock_busy_exit_code" in
  ''|*[!0-9]*) echo "ORKESTR_DEPLOY_LOCK_BUSY_EXIT_CODE must be a non-negative integer." >&2; exit 2 ;;
esac
case "$deploy_drain_ttl_seconds" in
  ''|*[!0-9]*) echo "ORKESTR_DEPLOY_DRAIN_TTL_SECONDS must be a positive integer." >&2; exit 2 ;;
esac

trap cleanup_deploy_drain_on_exit EXIT

need git
need npm
need node
need curl
need tar
need systemctl
need flock

if [ "$command" != "status" ]; then
  mkdir -p "$(dirname "$lock_file")"
  exec 9>"$lock_file"
  if ! flock -n 9; then
    echo "Another Orkestr deploy is already running."
    exit "$lock_busy_exit_code"
  fi
fi

case "$command" in
  install) install_command ;;
  rollback) rollback_command ;;
  status) status_command ;;
  *)
    echo "Unknown command: $command" >&2
    usage >&2
    exit 2
    ;;
esac
