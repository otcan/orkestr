#!/usr/bin/env bash
set -euo pipefail

install_script_url="${ORKESTR_INSTALL_SCRIPT_URL:-https://raw.githubusercontent.com/otcan/orkestr/main/scripts/install.sh}"
if [ -n "${ORKESTR_INSTALL_TEMP_FILE:-}" ]; then
  trap 'rm -f "$ORKESTR_INSTALL_TEMP_FILE"' EXIT
fi
case "${ORKESTR_INSTALL_REEXECED:-0}:$0" in
  0:bash|0:*/bash|0:sh|0:*/sh|0:-bash)
    if command -v curl >/dev/null 2>&1; then
      install_tmp="$(mktemp)"
      curl -fsSL "$install_script_url" -o "$install_tmp"
      chmod 0755 "$install_tmp"
      export ORKESTR_INSTALL_REEXECED=1
      export ORKESTR_INSTALL_TEMP_FILE="$install_tmp"
      if { : </dev/tty; } 2>/dev/null; then
        exec bash "$install_tmp" "$@" </dev/tty
      fi
      exec bash "$install_tmp" "$@" </dev/null
    fi
    ;;
esac

usage() {
  cat <<'USAGE'
Install Orkestr.

Usage:
  scripts/install.sh [--config FILE] [--fresh] [--advanced] [--local] [--no-start] [--no-service] [--serve] [--profile local-safe|local-trusted] [--enable-host-codex]
  scripts/install.sh --systemd [--auto-update] [--track-main|--release-updates] [--install-dir DIR] [--data-dir DIR] [--workspace-dir DIR] [--env-file FILE] [--user USER]

Modes:
  default       Clone/update Orkestr when run outside a checkout, use the current checkout when run from one, build, install a local service, and start Orkestr.
  --systemd     Install a host-native VPS service. Requires root.
  --auto-update Install a host-local update watcher timer in --systemd mode.
  --track-main  Track origin/main with versioned releases. Implies --auto-update, --release-updates, --update-ref main, --channel main, and --allow-untagged-releases.
  --release-updates Use versioned release directories for updater deploys.

Configured installs:
  One-line local install or update:
    curl -fsSL https://raw.githubusercontent.com/otcan/orkestr/main/scripts/install.sh | bash

  Optional JSON config:
    curl -fsSL https://raw.githubusercontent.com/otcan/orkestr/main/scripts/install.sh | bash -s -- --config orkestr.install.json

  Fresh local reinstall:
    curl -fsSL https://raw.githubusercontent.com/otcan/orkestr/main/scripts/install.sh | bash -s -- --fresh

Local and compatibility flags:
  --local       Force using the current checkout.
  --serve       Dev shortcut: skip local service installation and run npm in the foreground.
  --no-serve    Alias for --no-start.
  --profile     Legacy alias for choosing Codex safety defaults. Prefer explicit ORKESTR_CODEX_* settings.
  --advanced    Ask for local URL, folders, service behavior, and host Codex CLI.
  --enable-host-codex  Allow a local macOS install to probe/use a verified host codex binary.

Environment:
  ORKESTR_INSTALL_MODE      local or service. service is equivalent to --systemd.
  ORKESTR_INSTALL_LOCAL_SERVICE Install a local user service for non-systemd installs. Defaults to 1 locally.
  ORKESTR_START_AFTER_INSTALL  Start the installed service after install. Defaults to 1 locally.
  ORKESTR_LOCAL_SERVICE_NAME  Local Linux service name. Defaults to orkestr.
  ORKESTR_LOCAL_SERVICE_LABEL Local macOS launchd label. Defaults to com.orkestr.oss.
  ORKESTR_LOCAL_BIN_DIR      Local CLI wrapper directory. Defaults to ~/.local/bin.
  ORKESTR_LOCAL_SERVICE_MANAGER Local service backend. Defaults to background on macOS, systemd-user or cron on Linux.
  ORKESTR_REPO_URL          Git repository to clone. Defaults to https://github.com/otcan/orkestr.git.
  ORKESTR_GIT_REF           Git branch, tag, or commit to deploy. Defaults to the repository default branch.
  ORKESTR_INSTALL_DIR       Install directory. Defaults to ~/.orkestr-src/orkestr-oss, or /opt/orkestr/app with --systemd.
  ORKESTR_HOME              Data directory. Defaults to /opt/orkestr/data with --systemd.
  ORKESTR_WORKSPACE_DIR     Workspace root. Defaults to /opt/orkestr/workspace with --systemd.
  ORKESTR_ENV_FILE          Environment file. Defaults to /etc/orkestr/orkestr.env with --systemd.
  ORKESTR_RUN_USER          Service user. Defaults to orkestr with --systemd.
  ORKESTR_HOST              Bind host. Defaults to 127.0.0.1.
  ORKESTR_PORT              Bind port. Defaults to 19812.
  ORKESTR_RUNTIME_SETTINGS_FILE  Non-secret runtime settings file. Defaults to $ORKESTR_HOME/runtime-settings.json.
  ORKESTR_CODEX_SANDBOX     Codex sandbox setting. Defaults to workspace-write.
  ORKESTR_CODEX_APPROVAL_POLICY  Codex approval policy. Defaults to on-request.
  ORKESTR_RUNTIME_CODEX_COMMAND  Codex command used for threads.
  ORKESTR_AUTO_UPDATE       Install and enable the update watcher. Defaults to 0.
  ORKESTR_UPDATE_REF        Git branch, tag, or commit watched by the updater. Defaults to main.
  ORKESTR_UPDATE_INTERVAL_SECONDS  Update check interval. Defaults to 120.
  ORKESTR_RELEASE_DEPLOY    Use versioned release directories for updates. Defaults to 0.
  ORKESTR_DEPLOY_CHANNEL    Deployment channel label. Defaults to production for release deploys.
  ORKESTR_DEPLOY_TAGS_ONLY  Require exact git tags for versioned deploys. Defaults to 1 for production, 0 otherwise.
  ORKESTR_DEPLOY_ROOT       Versioned release root. Defaults to /opt/orkestr.
  ORKESTR_CURRENT_LINK      Active release symlink. Defaults to /opt/orkestr/current.
  ORKESTR_RESET_ON_UPDATE   Reset runtime state after successful updates. Defaults to 0.
  ORKESTR_RESET_OVERLAY     Also reset ORKESTR_OVERLAY_DIR when reset is enabled. Defaults to 0.
  ORKESTR_INSTALL_CODEX     Install Codex CLI globally in --systemd mode. Defaults to 1.
  ORKESTR_ENABLE_HOST_CODEX Allow local macOS installs to prefer a verified host codex binary. Defaults to 0 on macOS.
  ORKESTR_ALLOW_MACOS_BREW_INSTALL Allow local macOS installs to run brew install for missing tools. Defaults to 0.
  ORKESTR_ALLOW_MACOS_ADMIN Permit local macOS install paths that may request administrator access. Defaults to 0.
  ORKESTR_CODEX_VERSION     Codex CLI version. Defaults to 0.134.0.
  ORKESTR_LOCAL_CODEX_PREFIX Local Codex CLI install prefix. Defaults to $ORKESTR_HOME/codex-cli.
  ORKESTR_CODEX_APP_SERVER_MODE  Codex app-server transport. Defaults to external in --systemd mode.
  ORKESTR_CODEX_APP_SERVER_SOCKET Unix socket for external Codex app-server.
  ORKESTR_CODEX_APP_SERVER_SERVICE_NAME  systemd unit name for the external Codex runtime.
  ORKESTR_INSTALL_WA_SERVICE  Install standalone orkestr-wa systemd service. Defaults to 0.
  ORKESTR_WA_SERVICE_NAME     systemd unit name for standalone WhatsApp service. Defaults to <service>-wa.
  ORKESTR_WA_SERVICE_HOME     Data root for standalone WhatsApp service. Defaults to <ORKESTR_HOME>/wa-service.
  ORKESTR_WA_SERVICE_ENV_FILE Private env file for standalone WhatsApp service. Defaults to /etc/orkestr/orkestr-wa.env.
  ORKESTR_INSTALL_CONNECTORS_MCP Install the isolated connector MCP gateway and WhatsApp worker. Defaults to ORKESTR_INSTALL_WA_SERVICE.
  ORKESTR_CONNECTORS_MCP_SERVICE_NAME systemd unit name for the connector gateway. Defaults to <service>-connectors-mcp.
  ORKESTR_CONNECTORS_ENV_FILE Private gateway/worker env file. Defaults to /etc/orkestr/orkestr-connectors.env.
  ORKESTR_INSTALL_PERSONAL_CONNECTORS_MCP Install an isolated personal +49 connector deployment. Defaults to 0.
  ORKESTR_PERSONAL_CONNECTORS_ENV_FILE Private personal deployment env. Defaults to /etc/orkestr/orkestr-connectors-personal.env.
  ORKESTR_LOCAL_ENV_FILE    Local env file written for non-systemd installs. Defaults to $ORKESTR_HOME/orkestr.env.
  ORKESTR_SKIP_SYSTEM_PACKAGES  Skip apt package installation when set to 1.
  ORKESTR_FRESH_INSTALL     Set to 1 to stop the local service and remove local Orkestr state before install.
  ORKESTR_INSTALL_ADVANCED  Set to 1 to ask advanced local installer questions.
  ORKESTR_NONINTERACTIVE    Set to 1 to skip local installer prompts.
  ORKESTR_BUILD_WEB_FROM_SOURCE Set to 1 to install dev dependencies and rebuild the Angular web app.
USAGE
}

initial_arg_count=$#
install_json_config_loaded=0
install_json_config_file=""
macos_local_admin_guard=0
install_arg_systemd=0

for ((arg_index = 1; arg_index <= $#; arg_index += 1)); do
  arg_value="${!arg_index}"
  case "$arg_value" in
    --systemd|--vps)
      install_arg_systemd=1
      ;;
    --config)
      next_index=$((arg_index + 1))
      if [ "$next_index" -gt "$#" ]; then
        echo "--config requires a JSON config file path." >&2
        exit 2
      fi
      install_json_config_file="${!next_index}"
      arg_index="$next_index"
      ;;
  esac
done

if [ -n "$install_json_config_file" ]; then
  if [ ! -r "$install_json_config_file" ]; then
    echo "Cannot read Orkestr JSON install config: $install_json_config_file" >&2
    exit 1
  fi
  if ! command -v node >/dev/null 2>&1; then
    echo "JSON install config requires Node.js 22 or newer on PATH." >&2
    exit 1
  fi
  set -a
  eval "$(node - "$install_json_config_file" <<'NODE'
const fs = require("node:fs");
const configPath = process.argv[2];
const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function emit(name, value) {
  if (!name || value === undefined || value === null) return;
  if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) return;
  console.log(`${name}=${shellQuote(typeof value === "boolean" ? (value ? "1" : "0") : value)}`);
}

const topLevel = {
  installMode: "ORKESTR_INSTALL_MODE",
  repoUrl: "ORKESTR_REPO_URL",
  gitRef: "ORKESTR_GIT_REF",
  installDir: "ORKESTR_INSTALL_DIR",
  home: "ORKESTR_HOME",
  workspaceDir: "ORKESTR_WORKSPACE_DIR",
  envFile: "ORKESTR_ENV_FILE",
  localEnvFile: "ORKESTR_LOCAL_ENV_FILE",
  host: "ORKESTR_HOST",
  port: "ORKESTR_PORT",
  primaryDomain: "ORKESTR_PRIMARY_DOMAIN",
  publicSiteUrl: "ORKESTR_PUBLIC_SITE_URL",
  appHost: "ORKESTR_APP_HOST",
  authHost: "ORKESTR_AUTH_HOST",
  publicUrl: "ORKESTR_PUBLIC_URL",
  authUrl: "ORKESTR_AUTH_URL",
  cookieDomain: "ORKESTR_COOKIE_DOMAIN",
  connectPublicUrl: "ORKESTR_CONNECT_PUBLIC_URL",
  acmeEmail: "ORKESTR_ACME_EMAIL",
  installLocalService: "ORKESTR_INSTALL_LOCAL_SERVICE",
  startAfterInstall: "ORKESTR_START_AFTER_INSTALL",
  localServiceName: "ORKESTR_LOCAL_SERVICE_NAME",
  localServiceLabel: "ORKESTR_LOCAL_SERVICE_LABEL",
  localBinDir: "ORKESTR_LOCAL_BIN_DIR",
  advanced: "ORKESTR_INSTALL_ADVANCED",
  enableHostCodex: "ORKESTR_ENABLE_HOST_CODEX",
  skipSystemPackages: "ORKESTR_SKIP_SYSTEM_PACKAGES",
};

const nested = {
  domain: {
    primary: "ORKESTR_PRIMARY_DOMAIN",
    publicSiteUrl: "ORKESTR_PUBLIC_SITE_URL",
    appHost: "ORKESTR_APP_HOST",
    authHost: "ORKESTR_AUTH_HOST",
    publicUrl: "ORKESTR_PUBLIC_URL",
    authUrl: "ORKESTR_AUTH_URL",
    cookieDomain: "ORKESTR_COOKIE_DOMAIN",
    connectPublicUrl: "ORKESTR_CONNECT_PUBLIC_URL",
    acmeEmail: "ORKESTR_ACME_EMAIL",
  },
  codex: {
    bin: "ORKESTR_CODEX_BIN",
    sandbox: "ORKESTR_CODEX_SANDBOX",
    approvalPolicy: "ORKESTR_CODEX_APPROVAL_POLICY",
    command: "ORKESTR_RUNTIME_CODEX_COMMAND",
  },
  update: {
    auto: "ORKESTR_AUTO_UPDATE",
    ref: "ORKESTR_UPDATE_REF",
    intervalSeconds: "ORKESTR_UPDATE_INTERVAL_SECONDS",
    releaseDeploy: "ORKESTR_RELEASE_DEPLOY",
    channel: "ORKESTR_DEPLOY_CHANNEL",
    tagsOnly: "ORKESTR_DEPLOY_TAGS_ONLY",
  },
};

for (const [key, value] of Object.entries(raw)) {
  if (/^[A-Z_][A-Z0-9_]*$/.test(key)) emit(key, value);
  if (topLevel[key]) emit(topLevel[key], value);
}
for (const [section, keys] of Object.entries(nested)) {
  const value = raw[section];
  if (!value || typeof value !== "object" || Array.isArray(value)) continue;
  for (const [key, envName] of Object.entries(keys)) emit(envName, value[key]);
}
NODE
)"
  set +a
  install_json_config_loaded=1
fi

local_mode=0
foreground_serve=0
start_after_install="${ORKESTR_START_AFTER_INSTALL:-}"
local_service="${ORKESTR_INSTALL_LOCAL_SERVICE:-}"
systemd=0
install_dir="${ORKESTR_INSTALL_DIR:-}"
data_dir="${ORKESTR_HOME:-}"
workspace_dir="${ORKESTR_WORKSPACE_DIR:-}"
env_file="${ORKESTR_ENV_FILE:-}"
local_env_file="${ORKESTR_LOCAL_ENV_FILE:-}"
fresh_install="${ORKESTR_FRESH_INSTALL:-0}"
advanced_install="${ORKESTR_INSTALL_ADVANCED:-0}"
run_user="${ORKESTR_RUN_USER:-orkestr}"
host="${ORKESTR_HOST:-127.0.0.1}"
port="${ORKESTR_PORT:-19812}"
auto_update="${ORKESTR_AUTO_UPDATE:-0}"
update_interval_seconds="${ORKESTR_UPDATE_INTERVAL_SECONDS:-120}"
update_ref="${ORKESTR_UPDATE_REF:-main}"
release_update="${ORKESTR_RELEASE_DEPLOY:-0}"
deploy_channel="${ORKESTR_DEPLOY_CHANNEL:-production}"
deploy_tags_only="${ORKESTR_DEPLOY_TAGS_ONLY:-}"
track_main=0
install_profile="${ORKESTR_INSTALL_PROFILE:-}"
install_mode="${ORKESTR_INSTALL_MODE:-}"

case "$install_mode" in
  service|systemd|vps)
    systemd=1
    ;;
  local|"")
    ;;
  *)
    echo "Unknown ORKESTR_INSTALL_MODE: $install_mode" >&2
    echo "Use ORKESTR_INSTALL_MODE=local or ORKESTR_INSTALL_MODE=service." >&2
    exit 2
    ;;
esac

while [ "$#" -gt 0 ]; do
  case "$1" in
    --local)
      local_mode=1
      shift
      ;;
    --config)
      if [ -z "${2:-}" ]; then
        echo "$1 requires a JSON config file path." >&2
        exit 2
      fi
      shift 2
      ;;
    --fresh)
      fresh_install=1
      ORKESTR_FRESH_INSTALL=1
      shift
      ;;
    --advanced)
      advanced_install=1
      ORKESTR_INSTALL_ADVANCED=1
      shift
      ;;
    --serve)
      foreground_serve=1
      local_service=0
      ORKESTR_INSTALL_LOCAL_SERVICE=0
      start_after_install=1
      ORKESTR_START_AFTER_INSTALL=1
      shift
      ;;
    --no-serve|--no-start)
      start_after_install=0
      ORKESTR_START_AFTER_INSTALL=0
      shift
      ;;
    --no-service)
      local_service=0
      ORKESTR_INSTALL_LOCAL_SERVICE=0
      shift
      ;;
    --systemd|--vps)
      systemd=1
      ORKESTR_INSTALL_MODE=service
      shift
      ;;
    --auto-update)
      auto_update=1
      ORKESTR_AUTO_UPDATE=1
      shift
      ;;
    --no-auto-update)
      auto_update=0
      ORKESTR_AUTO_UPDATE=0
      shift
      ;;
    --track-main)
      track_main=1
      auto_update=1
      release_update=1
      update_ref=main
      deploy_channel=main
      deploy_tags_only=0
      ORKESTR_AUTO_UPDATE=1
      ORKESTR_RELEASE_DEPLOY=1
      ORKESTR_UPDATE_REF=main
      ORKESTR_DEPLOY_CHANNEL=main
      ORKESTR_DEPLOY_TAGS_ONLY=0
      shift
      ;;
    --release-updates|--versioned-updates)
      release_update=1
      ORKESTR_RELEASE_DEPLOY=1
      shift
      ;;
    --in-place-updates)
      release_update=0
      ORKESTR_RELEASE_DEPLOY=0
      shift
      ;;
    --update-ref)
      update_ref="${2:-}"
      ORKESTR_UPDATE_REF="$update_ref"
      shift 2
      ;;
    --channel)
      deploy_channel="${2:-}"
      ORKESTR_DEPLOY_CHANNEL="$deploy_channel"
      shift 2
      ;;
    --allow-untagged-releases)
      deploy_tags_only=0
      ORKESTR_DEPLOY_TAGS_ONLY=0
      shift
      ;;
    --require-tagged-releases)
      deploy_tags_only=1
      ORKESTR_DEPLOY_TAGS_ONLY=1
      shift
      ;;
    --install-dir)
      install_dir="${2:-}"
      shift 2
      ;;
    --data-dir)
      data_dir="${2:-}"
      shift 2
      ;;
    --workspace-dir)
      workspace_dir="${2:-}"
      shift 2
      ;;
    --env-file)
      env_file="${2:-}"
      shift 2
      ;;
    --user)
      run_user="${2:-}"
      shift 2
      ;;
    --host)
      host="${2:-}"
      shift 2
      ;;
    --port)
      port="${2:-}"
      shift 2
      ;;
    --profile)
      install_profile="${2:-}"
      ORKESTR_INSTALL_PROFILE="$install_profile"
      shift 2
      ;;
    --skip-system-packages)
      ORKESTR_SKIP_SYSTEM_PACKAGES=1
      shift
      ;;
    --skip-codex)
      ORKESTR_INSTALL_CODEX=0
      shift
      ;;
    --enable-host-codex)
      ORKESTR_ENABLE_HOST_CODEX=1
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

if [ "$(uname -s 2>/dev/null || true)" = "Darwin" ] \
  && [ "$systemd" -eq 1 ] \
  && [ "$install_arg_systemd" != "1" ] \
  && [ "${ORKESTR_ALLOW_MACOS_ADMIN:-0}" != "1" ]; then
  echo "Ignoring inherited ORKESTR_INSTALL_MODE=$install_mode on macOS. Local Mac installs do not use sudo or --systemd." >&2
  systemd=0
  install_mode=local
fi

if [ "$track_main" -eq 1 ]; then
  auto_update=1
  release_update=1
  update_ref=main
  deploy_channel=main
  deploy_tags_only=0
  ORKESTR_AUTO_UPDATE=1
  ORKESTR_RELEASE_DEPLOY=1
  ORKESTR_UPDATE_REF=main
  ORKESTR_DEPLOY_CHANNEL=main
  ORKESTR_DEPLOY_TAGS_ONLY=0
fi

need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

have() {
  command -v "$1" >/dev/null 2>&1
}

is_macos() {
  [ "$(uname -s)" = "Darwin" ]
}

prepend_path_once() {
  local dir current
  dir="$1"
  current="${2:-}"
  [ -n "$dir" ] || {
    echo "$current"
    return 0
  }
  case ":$current:" in
    *":$dir:"*) echo "$current" ;;
    *) echo "$dir${current:+:$current}" ;;
  esac
}

local_runtime_path() {
  local path_value cmd cmd_path dir
  path_value="${PATH:-/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin}"
  if is_macos; then
    for dir in /opt/homebrew/bin /usr/local/bin /opt/homebrew/sbin /usr/local/sbin /usr/bin /bin /usr/sbin /sbin; do
      if [ -d "$dir" ]; then
        path_value="$(prepend_path_once "$dir" "$path_value")"
      fi
    done
  fi
  for cmd in node npm git tmux rg codex google-chrome google-chrome-stable chromium chromium-browser; do
    cmd_path="$(PATH="$path_value" command -v "$cmd" 2>/dev/null || true)"
    if [ -n "$cmd_path" ]; then
      path_value="$(prepend_path_once "$(dirname "$cmd_path")" "$path_value")"
    fi
  done
  echo "$path_value"
}

brew_command() {
  if have brew; then
    command -v brew
    return 0
  fi
  if [ -x /opt/homebrew/bin/brew ]; then
    echo /opt/homebrew/bin/brew
    return 0
  fi
  if [ -x /usr/local/bin/brew ]; then
    echo /usr/local/bin/brew
    return 0
  fi
  return 1
}

homebrew_install_without_admin() {
  local brew prefix repository
  brew="$1"
  prefix="$("$brew" --prefix 2>/dev/null || true)"
  repository="$("$brew" --repository 2>/dev/null || true)"
  [ -n "$prefix" ] || return 1
  [ -w "$prefix" ] || return 1
  [ -z "$repository" ] || [ -w "$repository" ]
}

profile_is_trusted() {
  case "$1" in
    local-trusted|vps-trusted|trusted)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

codex_sandbox_default() {
  if profile_is_trusted "$install_profile"; then
    echo "danger-full-access"
  else
    echo "workspace-write"
  fi
}

codex_approval_default() {
  if profile_is_trusted "$install_profile"; then
    echo "never"
  else
    echo "on-request"
  fi
}

codex_command_default() {
  if should_disable_macos_runtime_codex || [ "${ORKESTR_CODEX_BIN:-}" = "__orkestr_codex_disabled_on_macos__" ]; then
    echo "__orkestr_codex_disabled_on_macos__"
    return 0
  fi
  local codex_bin sandbox approval
  codex_bin="${ORKESTR_CODEX_BIN:-codex}"
  sandbox="${ORKESTR_CODEX_SANDBOX:-$(codex_sandbox_default)}"
  approval="${ORKESTR_CODEX_APPROVAL_POLICY:-$(codex_approval_default)}"
  if [ "$sandbox" = "danger-full-access" ] && [ "$approval" = "never" ]; then
    echo "$codex_bin --dangerously-bypass-approvals-and-sandbox"
  else
    echo "$codex_bin --sandbox $sandbox --ask-for-approval $approval --no-alt-screen"
  fi
}

codex_bin_default() {
  if should_disable_macos_codex_bin; then
    echo "__orkestr_codex_disabled_on_macos__"
  elif is_macos && [ "$systemd" -ne 1 ]; then
    local_codex_bin
  else
    echo "codex"
  fi
}

should_disable_macos_codex_bin() {
  [ "${ORKESTR_CODEX_BIN:-}" = "__orkestr_codex_disabled_on_macos__" ]
}

should_disable_macos_runtime_codex() {
  [ "${ORKESTR_RUNTIME_CODEX_COMMAND:-}" = "__orkestr_codex_disabled_on_macos__" ]
}

should_disable_macos_host_codex() {
  should_disable_macos_codex_bin || should_disable_macos_runtime_codex
}

print_macos_codex_notice() {
  if ! should_disable_macos_host_codex; then
    return 0
  fi
  cat <<'EOF'

macOS Codex note:
  This is not an install error.
  Orkestr will not auto-probe or run the host `codex` binary from this install.
  This avoids macOS Gatekeeper/XProtect prompts from an unverified native binary.

  To use a host-installed Codex binary anyway, first verify it yourself:
    codex --version
    codex login status

  Then rerun:
    ORKESTR_ENABLE_HOST_CODEX=1 scripts/install.sh --local

  Advanced users can also set ORKESTR_CODEX_BIN to an explicit verified Codex
  path before running the installer. Set ORKESTR_RUNTIME_CODEX_COMMAND too when
  the runtime needs custom Codex flags.

EOF
}

local_codex_prefix() {
  echo "${ORKESTR_LOCAL_CODEX_PREFIX:-$data_dir/codex-cli}"
}

local_codex_bin() {
  echo "${ORKESTR_LOCAL_CODEX_BIN:-$(local_codex_prefix)/node_modules/.bin/codex}"
}

local_codex_home_default() {
  echo "${ORKESTR_LOCAL_CODEX_HOME:-$HOME/.codex}"
}

codex_app_server_socket_default() {
  echo "${ORKESTR_CODEX_APP_SERVER_SOCKET:-$data_dir/run/codex-app-server.sock}"
}

systemd_service_name() {
  echo "${ORKESTR_SERVICE_NAME:-orkestr}"
}

codex_app_server_service_name() {
  echo "${ORKESTR_CODEX_APP_SERVER_SERVICE_NAME:-$(systemd_service_name)-codex}"
}

wa_service_name() {
  echo "${ORKESTR_WA_SERVICE_NAME:-$(systemd_service_name)-wa}"
}

connectors_mcp_service_name() {
  echo "${ORKESTR_CONNECTORS_MCP_SERVICE_NAME:-$(systemd_service_name)-connectors-mcp}"
}

wa_worker_service_name() {
  echo "${ORKESTR_WA_WORKER_SERVICE_NAME:-$(systemd_service_name)-wa-worker}"
}

personal_connectors_mcp_service_name() {
  echo "${ORKESTR_PERSONAL_CONNECTORS_MCP_SERVICE_NAME:-$(systemd_service_name)-connectors-personal-mcp}"
}

personal_wa_worker_service_name() {
  echo "${ORKESTR_PERSONAL_WA_WORKER_SERVICE_NAME:-$(systemd_service_name)-wa-worker-personal-49}"
}

codex_cli_version() {
  echo "${ORKESTR_CODEX_VERSION:-0.134.0}"
}

codex_command_supports_app_server() {
  local command
  command="$1"
  [ -n "$command" ] || return 1
  [ "$command" != "__orkestr_codex_disabled_on_macos__" ] || return 1
  "$command" --version >/dev/null 2>&1 || return 1
  "$command" app-server --help >/dev/null 2>&1 || return 1
}

codex_command_supports_external_app_server() {
  local command
  command="$1"
  codex_command_supports_app_server "$command" || return 1
  "$command" app-server proxy --help >/dev/null 2>&1 || return 1
}

codex_bypasses_approvals() {
  case "$1" in
    *--dangerously-bypass-approvals-and-sandbox*)
      return 0
      ;;
  esac
  [ "$2" = "danger-full-access" ] && [ "$3" = "never" ]
}

json_string() {
  node -e 'process.stdout.write(JSON.stringify(process.argv[1] || ""))' "$1"
}

shell_quote() {
  printf "'"
  printf "%s" "${1:-}" | sed "s/'/'\\\\''/g"
  printf "'"
}

write_env_var() {
  printf "%s=%s\n" "$1" "$(shell_quote "${2:-}")"
}

run_as_root() {
  [ "$(id -u)" -eq 0 ]
}

enable_macos_local_admin_guard() {
  macos_local_admin_guard=1
  ORKESTR_ALLOW_MACOS_BREW_INSTALL=0
  ORKESTR_ALLOW_MACOS_LAUNCHD=0
  if [ "${ORKESTR_LOCAL_SERVICE_MANAGER:-}" = "launchd" ]; then
    ORKESTR_LOCAL_SERVICE_MANAGER=background
  fi
  export ORKESTR_ALLOW_MACOS_BREW_INSTALL ORKESTR_ALLOW_MACOS_LAUNCHD ORKESTR_LOCAL_SERVICE_MANAGER
  export -f sudo osascript
}

sudo() {
  if [ "${macos_local_admin_guard:-0}" = "1" ]; then
    echo "Refusing to run sudo during a local macOS install." >&2
    return 1
  fi
  command sudo "$@"
}

osascript() {
  if [ "${macos_local_admin_guard:-0}" = "1" ]; then
    local joined
    joined="$*"
    case "$joined" in
      *"with administrator privileges"*)
        echo "Refusing administrator AppleScript during a local macOS install." >&2
        return 1
        ;;
    esac
  fi
  command osascript "$@"
}

is_interactive_terminal() {
  [ -t 0 ] && [ -t 1 ]
}

in_orkestr_checkout() {
  [ -d .git ] && [ -f package.json ] && [ -f scripts/install.sh ]
}

prompt_default() {
  local var_name label default_value answer
  var_name="$1"
  label="$2"
  default_value="$3"
  printf "%s [%s]: " "$label" "$default_value"
  read -r answer
  if [ -z "$answer" ]; then
    answer="$default_value"
  fi
  printf -v "$var_name" "%s" "$answer"
}

prompt_yes_no() {
  local var_name label default_value suffix answer normalized
  var_name="$1"
  label="$2"
  default_value="$3"
  suffix="[y/N]"
  if [ "$default_value" = "1" ]; then
    suffix="[Y/n]"
  fi
  while true; do
    printf "%s %s: " "$label" "$suffix"
    read -r answer
    normalized="$(printf "%s" "${answer:-}" | tr '[:upper:]' '[:lower:]')"
    if [ -z "$normalized" ]; then
      printf -v "$var_name" "%s" "$default_value"
      return 0
    fi
    case "$normalized" in
      y|yes)
        printf -v "$var_name" "1"
        return 0
        ;;
      n|no)
        printf -v "$var_name" "0"
        return 0
        ;;
    esac
  done
}

join_words() {
  local first item
  first=1
  for item in "$@"; do
    if [ "$first" -eq 1 ]; then
      printf "%s" "$item"
      first=0
    else
      printf " %s" "$item"
    fi
  done
}

run_codex_login_if_requested() {
  if ! have codex; then
    return 0
  fi
  if codex login status >/dev/null 2>&1; then
    echo "Codex login: connected"
    return 0
  fi
  local do_login
  prompt_yes_no do_login "Codex is installed but not logged in. Run codex login now" "0"
  if [ "$do_login" = "1" ]; then
    codex login || true
  fi
}

configure_codex_interactively() {
  if [ "$systemd" -eq 1 ] || ! is_interactive_terminal; then
    return 0
  fi
  local use_host_codex default_use
  default_use=1
  if is_macos; then
    default_use=0
  fi
  prompt_yes_no use_host_codex "Use this machine's Codex CLI for coding agents" "$default_use"
  if [ "$use_host_codex" = "1" ]; then
    ORKESTR_ENABLE_HOST_CODEX=1
    export ORKESTR_ENABLE_HOST_CODEX
    if have codex; then
      ORKESTR_CODEX_BIN="${ORKESTR_CODEX_BIN:-$(command -v codex)}"
      export ORKESTR_CODEX_BIN
      if codex --version >/dev/null 2>&1; then
        echo "Codex CLI: $(codex --version 2>/dev/null | head -1)"
        run_codex_login_if_requested
      else
        cat >&2 <<'EOF'
Codex CLI exists, but macOS or the shell could not run it.
Open a terminal and verify it manually with:
  codex --version
  codex login status
Then rerun the installer with Codex enabled.
EOF
      fi
    else
      echo "Codex CLI was not found. You can connect Codex later from /setup."
    fi
  else
    ORKESTR_ENABLE_HOST_CODEX=0
    export ORKESTR_ENABLE_HOST_CODEX
  fi
}

normalize_bool() {
  local normalized
  normalized="$(printf "%s" "${1:-}" | tr '[:upper:]' '[:lower:]')"
  case "$normalized" in
    1|true|yes|on)
      echo 1
      ;;
    0|false|no|off)
      echo 0
      ;;
    *)
      echo "$1"
      ;;
  esac
}

apply_install_defaults() {
  if [ "$systemd" -eq 1 ]; then
    install_dir="${install_dir:-/opt/orkestr/app}"
    data_dir="${data_dir:-/opt/orkestr/data}"
    workspace_dir="${workspace_dir:-/opt/orkestr/workspace}"
    env_file="${env_file:-/etc/orkestr/orkestr.env}"
  else
    install_dir="${install_dir:-$HOME/.orkestr-src/orkestr-oss}"
    data_dir="${data_dir:-$HOME/.orkestr}"
    workspace_dir="${workspace_dir:-$data_dir/workspaces}"
    local_env_file="${local_env_file:-$data_dir/orkestr.env}"
  fi
  if [ -z "$start_after_install" ]; then
    start_after_install=1
  fi
  if [ -z "$local_service" ]; then
    if [ "$systemd" -eq 1 ]; then
      local_service=0
    else
      local_service=1
    fi
  fi
  if [ "$foreground_serve" -eq 1 ]; then
    local_service=0
  fi
}

run_install_wizard() {
  local yolo_mode install_service start_after default_workspace
  echo "Orkestr installer"
  echo
  echo "This installs Orkestr locally, keeps it private on this machine, and starts the web UI."
  echo "Default URL: http://$host:$port/setup"
  if [ "$advanced_install" = "1" ]; then
    echo "Advanced mode: the installer will also ask for URL, folder, service, and host Codex settings."
  else
    echo "Using safe defaults for local URL, folders, service install, and startup."
    echo "Run with --advanced to change them."
  fi
  echo
  echo "Press Enter to accept the suggested answer."
  prompt_yes_no yolo_mode "ENABLE YOLO MODE for Codex: skip approval prompts and sandbox limits" "0"
  if [ "$yolo_mode" = "1" ]; then
    ORKESTR_CODEX_SANDBOX="${ORKESTR_CODEX_SANDBOX:-danger-full-access}"
    ORKESTR_CODEX_APPROVAL_POLICY="${ORKESTR_CODEX_APPROVAL_POLICY:-never}"
  else
    ORKESTR_CODEX_SANDBOX="${ORKESTR_CODEX_SANDBOX:-workspace-write}"
    ORKESTR_CODEX_APPROVAL_POLICY="${ORKESTR_CODEX_APPROVAL_POLICY:-on-request}"
  fi
  if [ "$advanced_install" != "1" ]; then
    return 0
  fi
  configure_codex_interactively
  prompt_default host "Private bind host" "$host"
  prompt_default port "Web UI port" "$port"
  default_workspace="$workspace_dir"
  prompt_default data_dir "Data directory" "$data_dir"
  if [ "$workspace_dir" = "$default_workspace" ] && [ "$systemd" -ne 1 ]; then
    workspace_dir="$data_dir/workspaces"
  fi
  prompt_default workspace_dir "Workspace directory" "$workspace_dir"
  if [ "$systemd" -ne 1 ]; then
    prompt_yes_no install_service "Install Orkestr as a user service" "$local_service"
    local_service="$install_service"
    ORKESTR_INSTALL_LOCAL_SERVICE="$local_service"
    if [ "$local_service" = "1" ]; then
      prompt_yes_no start_after "Start the Orkestr service after installing" "$start_after_install"
      start_after_install="$start_after"
      ORKESTR_START_AFTER_INSTALL="$start_after_install"
    else
      prompt_yes_no start_after "Start Orkestr in the foreground after installing" "$foreground_serve"
      foreground_serve="$start_after"
      start_after_install="$start_after"
      ORKESTR_START_AFTER_INSTALL="$start_after_install"
    fi
  fi
}

apt_install() {
  if [ "${ORKESTR_SKIP_SYSTEM_PACKAGES:-0}" = "1" ]; then
    return 0
  fi
  if ! have apt-get; then
    echo "Automatic system package install only supports apt-based hosts." >&2
    echo "Install Node 22, npm, git, tmux, ripgrep, runuser, sqlite3, Chromium, and Codex CLI manually, then rerun with ORKESTR_SKIP_SYSTEM_PACKAGES=1." >&2
    exit 1
  fi
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y --no-install-recommends "$@"
}

node_major() {
  node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || echo 0
}

install_node_22() {
  if [ "${ORKESTR_SKIP_SYSTEM_PACKAGES:-0}" = "1" ]; then
    return 0
  fi
  apt_install ca-certificates curl gnupg
  mkdir -p /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" \
    > /etc/apt/sources.list.d/nodesource.list
  apt-get update
  apt-get install -y --no-install-recommends nodejs
}

ensure_node() {
  if [ "$(node_major)" -ge 22 ]; then
    return 0
  fi
  if [ "$systemd" -eq 1 ]; then
    install_node_22
  fi
  if [ "$(node_major)" -lt 22 ]; then
    echo "Node.js 22 or newer is required. Found: $(node --version 2>/dev/null || echo missing)" >&2
    exit 1
  fi
}

configure_bubblewrap_apparmor() {
  local source_profile target_profile
  source_profile="/usr/share/apparmor/extra-profiles/bwrap-userns-restrict"
  target_profile="/etc/apparmor.d/bwrap-userns-restrict"
  if [ "${ORKESTR_SKIP_SYSTEM_PACKAGES:-0}" = "1" ] || [ ! -r "$source_profile" ]; then
    return 0
  fi
  if ! have apparmor_parser; then
    echo "Warning: AppArmor parser is missing; Codex bubblewrap user namespace setup was not applied." >&2
    return 0
  fi
  install -m 0644 "$source_profile" "$target_profile"
  apparmor_parser -r "$target_profile" || echo "Warning: could not load Codex bubblewrap AppArmor profile: $target_profile" >&2
}

install_system_packages() {
  if [ "$systemd" -ne 1 ] || [ "${ORKESTR_SKIP_SYSTEM_PACKAGES:-0}" = "1" ]; then
    return 0
  fi
  apt_install apparmor-profiles apparmor-utils bubblewrap ca-certificates curl git openssh-client procps ripgrep sqlite3 tmux util-linux
  configure_bubblewrap_apparmor
  install_browser_package
  install_desktop_packages
}

install_desktop_packages() {
  apt_install dbus-x11 novnc openbox websockify x11vnc xauth xvfb
}

install_local_runtime_tools() {
  if [ "$systemd" -eq 1 ]; then
    return 0
  fi
  export PATH="$(local_runtime_path)"
  local missing_packages=()
  if ! have git; then missing_packages+=("git"); fi
  if ! have tmux; then missing_packages+=("tmux"); fi
  if ! have rg; then missing_packages+=("ripgrep"); fi
  if [ "${#missing_packages[@]}" -gt 0 ] && [ "${ORKESTR_SKIP_SYSTEM_PACKAGES:-0}" != "1" ]; then
    local install_missing missing_text
    missing_text="$(join_words "${missing_packages[@]}")"
    if is_macos; then
      local brew
      if [ "${ORKESTR_ALLOW_MACOS_BREW_INSTALL:-0}" = "1" ] && brew="$(brew_command)" && homebrew_install_without_admin "$brew"; then
        if is_interactive_terminal; then
          prompt_yes_no install_missing "Install missing local runtime tools with Homebrew: $missing_text" "1"
          if [ "$install_missing" != "1" ]; then
            echo "Install cancelled. Missing tools: $missing_text" >&2
            exit 1
          fi
        fi
        HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_ENV_HINTS=1 HOMEBREW_NO_INSTALL_CLEANUP=1 "$brew" install "${missing_packages[@]}"
        export PATH="$(local_runtime_path)"
      else
        cat >&2 <<'EOF'
Missing local runtime tools, but Orkestr will not ask your terminal app for administrator access.

Install the tools manually, then rerun the installer:
  brew install git tmux ripgrep

Set ORKESTR_ALLOW_MACOS_BREW_INSTALL=1 to let Orkestr try Homebrew automatically.
If Homebrew asks for administrator access, cancel it and install the tools
manually or fix the Homebrew installation ownership first.
EOF
        exit 1
      fi
    elif have apt-get && have sudo; then
      if is_interactive_terminal; then
        prompt_yes_no install_missing "Install missing local runtime tools: $missing_text" "1"
        if [ "$install_missing" != "1" ]; then
          echo "Install cancelled. Missing tools: $missing_text" >&2
          exit 1
        fi
      fi
      sudo apt-get update
      sudo apt-get install -y "${missing_packages[@]}"
    fi
  fi
  for cmd in git tmux rg; do
    if ! have "$cmd"; then
      cat >&2 <<EOF
Missing required local runtime command: $cmd

Install git, tmux, and ripgrep, then rerun the installer. On macOS:
  brew install git tmux ripgrep
EOF
      exit 1
    fi
  done
}

browser_command_is_usable() {
  local cmd
  cmd="$1"
  if ! have "$cmd"; then
    return 1
  fi
  timeout 15 "$cmd" --version >/dev/null 2>&1
}

have_usable_browser() {
  browser_command_is_usable google-chrome \
    || browser_command_is_usable google-chrome-stable \
    || browser_command_is_usable chromium \
    || browser_command_is_usable chromium-browser
}

install_google_chrome() {
  apt_install ca-certificates curl gnupg
  mkdir -p /etc/apt/keyrings
  curl -fsSL https://dl.google.com/linux/linux_signing_key.pub \
    | gpg --dearmor -o /etc/apt/keyrings/google-chrome.gpg
  echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/google-chrome.gpg] http://dl.google.com/linux/chrome/deb/ stable main" \
    > /etc/apt/sources.list.d/google-chrome.list
  apt-get update
  apt-get install -y --no-install-recommends google-chrome-stable
}

install_browser_package() {
  if have_usable_browser; then
    return 0
  fi
  local arch
  arch="$(dpkg --print-architecture 2>/dev/null || uname -m)"
  if [ "$arch" = "amd64" ]; then
    install_google_chrome
  else
    apt_install chromium
  fi
  if ! have_usable_browser; then
    echo "A usable Chrome/Chromium browser was not found after installation." >&2
    echo "Install google-chrome, chromium, or chromium-browser manually and rerun." >&2
    exit 1
  fi
}

install_codex() {
  if [ "$systemd" -ne 1 ] || [ "${ORKESTR_INSTALL_CODEX:-1}" = "0" ]; then
    return 0
  fi
  local command version
  command="${ORKESTR_CODEX_BIN:-codex}"
  version="$(codex_cli_version)"
  if codex_command_supports_app_server "$command"; then
    return 0
  fi
  if is_macos && [ "${ORKESTR_ALLOW_MACOS_ADMIN:-0}" != "1" ]; then
    echo "Refusing global Codex install on macOS. Local macOS installs use a private Codex CLI." >&2
    exit 1
  fi
  npm install -g "@openai/codex@$version"
  hash -r 2>/dev/null || true
  if codex_command_supports_app_server "$command"; then
    return 0
  fi
  cat >&2 <<EOF
Codex CLI is still not usable after installation:
  $command

It must run both:
  codex --version
  codex app-server --help
EOF
  exit 1
}

install_local_codex_cli() {
  if [ "$systemd" -eq 1 ] || ! is_macos || [ "${ORKESTR_INSTALL_CODEX:-1}" = "0" ]; then
    return 0
  fi
  if [ -n "${ORKESTR_CODEX_BIN:-}" ] && [ "$ORKESTR_CODEX_BIN" != "__orkestr_codex_disabled_on_macos__" ]; then
    if codex_command_supports_app_server "$ORKESTR_CODEX_BIN"; then
      return 0
    fi
    cat >&2 <<EOF
Configured ORKESTR_CODEX_BIN is not usable for Orkestr:
  $ORKESTR_CODEX_BIN

It must run both:
  codex --version
  codex app-server --help
EOF
    exit 1
  fi
  if [ "${ORKESTR_ENABLE_HOST_CODEX:-0}" = "1" ] && have codex && codex_command_supports_app_server "$(command -v codex)"; then
    ORKESTR_CODEX_BIN="$(command -v codex)"
    export ORKESTR_CODEX_BIN
    return 0
  fi

  local prefix bin version
  prefix="$(local_codex_prefix)"
  bin="$(local_codex_bin)"
  version="$(codex_cli_version)"
  if ! codex_command_supports_app_server "$bin"; then
    echo "Installing private Codex CLI for Orkestr: @openai/codex@$version"
    mkdir -p "$prefix"
    npm install --prefix "$prefix" --omit=dev --no-audit --no-fund "@openai/codex@$version"
  fi
  if ! codex_command_supports_app_server "$bin"; then
    cat >&2 <<EOF
Private Codex CLI install did not produce a usable app-server runtime:
  $bin

Try reinstalling with:
  rm -rf $(shell_quote "$prefix")
  ORKESTR_CODEX_VERSION=$version scripts/install.sh --local
EOF
    exit 1
  fi
  ORKESTR_CODEX_BIN="$bin"
  export ORKESTR_CODEX_BIN
}

chrome_path() {
  local cmd path
  for cmd in google-chrome google-chrome-stable chromium chromium-browser; do
    if browser_command_is_usable "$cmd"; then
      path="$(command -v "$cmd" 2>/dev/null || true)"
      if [ -n "$path" ]; then
        echo "$path"
        return 0
      fi
    fi
  done
  true
}

checkout_git_ref() {
  if git -C "$repo_dir" fetch origin "$git_ref"; then
    git -C "$repo_dir" checkout --detach FETCH_HEAD
    return 0
  fi
  git -C "$repo_dir" fetch origin
  git -C "$repo_dir" checkout --detach "$git_ref"
}

write_env_file() {
  local chrome
  chrome="$(chrome_path)"
  local codex_command codex_sandbox codex_approval codex_app_server_mode codex_app_server_socket codex_app_server_service runtime_settings_file desktop_mode browserctl_path primary_domain public_site_url app_host auth_host public_url auth_url cookie_domain public_https_url wa_bridge_mode wa_external_enabled wa_bridge_url wa_autostart
  codex_command="${ORKESTR_RUNTIME_CODEX_COMMAND:-$(codex_command_default)}"
  codex_sandbox="${ORKESTR_CODEX_SANDBOX:-$(codex_sandbox_default)}"
  codex_approval="${ORKESTR_CODEX_APPROVAL_POLICY:-$(codex_approval_default)}"
  codex_app_server_mode="${ORKESTR_CODEX_APP_SERVER_MODE:-external}"
  codex_app_server_socket="$(codex_app_server_socket_default)"
  codex_app_server_service="$(codex_app_server_service_name)"
  runtime_settings_file="${ORKESTR_RUNTIME_SETTINGS_FILE:-$data_dir/runtime-settings.json}"
  desktop_mode="${ORKESTR_BROWSER_DESKTOP_MODE:-browserctl}"
  browserctl_path="${ORKESTR_BROWSERCTL_PATH:-/usr/local/bin/orkestr-browserctl}"
  primary_domain="${ORKESTR_PRIMARY_DOMAIN:-${ORKESTR_DOMAIN:-}}"
  public_site_url="${ORKESTR_PUBLIC_SITE_URL:-}"
  if [ -z "$public_site_url" ] && [ -n "$primary_domain" ]; then
    public_site_url="https://$primary_domain"
  fi
  app_host="${ORKESTR_APP_HOST:-}"
  auth_host="${ORKESTR_AUTH_HOST:-}"
  if [ -n "$primary_domain" ]; then
    app_host="${app_host:-app.$primary_domain}"
    auth_host="${auth_host:-auth.$primary_domain}"
  fi
  public_url="${ORKESTR_PUBLIC_URL:-${ORKESTR_APP_URL:-}}"
  auth_url="${ORKESTR_AUTH_URL:-}"
  if [ -n "$app_host" ] && [ -z "$public_url" ]; then
    public_url="https://$app_host"
  fi
  if [ -n "$auth_host" ] && [ -z "$auth_url" ]; then
    auth_url="https://$auth_host"
  fi
  cookie_domain="${ORKESTR_COOKIE_DOMAIN:-}"
  if [ -z "$cookie_domain" ] && [ -n "$primary_domain" ] && [ -n "$app_host" ] && [ -n "$auth_host" ] && [ "$app_host" != "$auth_host" ]; then
    cookie_domain="$primary_domain"
  fi
  public_https_url="${ORKESTR_PUBLIC_HTTPS_URL:-$public_url}"
  if [ "$(normalize_bool "${ORKESTR_INSTALL_CONNECTORS_MCP:-${ORKESTR_INSTALL_WA_SERVICE:-0}}")" = "1" ]; then
    wa_bridge_mode="${WHATSAPP_BRIDGE_MODE:-external}"
    wa_external_enabled="${ORKESTR_WHATSAPP_EXTERNAL_BRIDGE_ENABLED:-1}"
    wa_bridge_url="${WHATSAPP_BRIDGE_URL:-http://127.0.0.1:${ORKESTR_CONNECTORS_MCP_PORT:-18914}}"
    wa_autostart="${ORKESTR_WHATSAPP_AUTOSTART:-0}"
  elif [ "$(normalize_bool "${ORKESTR_INSTALL_WA_SERVICE:-0}")" = "1" ]; then
    wa_bridge_mode="${WHATSAPP_BRIDGE_MODE:-external}"
    wa_external_enabled="${ORKESTR_WHATSAPP_EXTERNAL_BRIDGE_ENABLED:-1}"
    wa_bridge_url="${WHATSAPP_BRIDGE_URL:-http://127.0.0.1:${ORKESTR_WA_SERVICE_PORT:-18914}}"
    wa_autostart="${ORKESTR_WHATSAPP_AUTOSTART:-0}"
  else
    wa_bridge_mode="${WHATSAPP_BRIDGE_MODE:-local}"
    wa_external_enabled="${ORKESTR_WHATSAPP_EXTERNAL_BRIDGE_ENABLED:-0}"
    wa_bridge_url="${WHATSAPP_BRIDGE_URL:-}"
    wa_autostart="${ORKESTR_WHATSAPP_AUTOSTART:-1}"
  fi
  if [ -f "$env_file" ]; then
    echo "Keeping existing environment file and applying safe defaults: $env_file"
    migrate_systemd_env_file "$desktop_mode" "$browserctl_path"
    return 0
  fi
  mkdir -p "$(dirname "$env_file")"
  cat > "$env_file" <<EOF
# Orkestr host-native environment.
# Edit this file for OpenAI keys, OAuth credentials, Caddy/Tailscale URLs, and private overlay paths.
ORKESTR_APP_DIR=$repo_dir
ORKESTR_HOME=$data_dir
ORKESTR_RUNTIME_SETTINGS_FILE=$runtime_settings_file
ORKESTR_RUN_USER=$run_user
ORKESTR_HOST=$host
ORKESTR_PORT=$port
ORKESTR_AUTH_REQUIRED=${ORKESTR_AUTH_REQUIRED:-1}
ORKESTR_COOKIE_SECURE=${ORKESTR_COOKIE_SECURE:-0}
ORKESTR_PRIMARY_DOMAIN=$primary_domain
ORKESTR_PUBLIC_SITE_URL=$public_site_url
ORKESTR_APP_HOST=$app_host
ORKESTR_AUTH_HOST=$auth_host
ORKESTR_PUBLIC_URL=$public_url
ORKESTR_AUTH_URL=$auth_url
ORKESTR_COOKIE_DOMAIN=$cookie_domain
ORKESTR_PUBLIC_HTTPS_URL=$public_https_url
# Public OAuth broker base for external users, for example https://connect.example.com.
# When set, OAuth callbacks use this public base instead of the private Orkestr UI URL.
ORKESTR_CONNECT_PUBLIC_URL=${ORKESTR_CONNECT_PUBLIC_URL:-}
ORKESTR_TAILSCALE_HTTPS_NAME=${ORKESTR_TAILSCALE_HTTPS_NAME:-}
ORKESTR_CADDY_ENABLED=${ORKESTR_CADDY_ENABLED:-0}
ORKESTR_MTLS_ENABLED=${ORKESTR_MTLS_ENABLED:-0}
ORKESTR_MTLS_CA_CERT=${ORKESTR_MTLS_CA_CERT:-}
ORKESTR_MTLS_MODE=${ORKESTR_MTLS_MODE:-require_and_verify}
ORKESTR_AUTO_UPDATE=${ORKESTR_AUTO_UPDATE:-$auto_update}
ORKESTR_UPDATE_REF=${ORKESTR_UPDATE_REF:-$update_ref}
ORKESTR_UPDATE_INTERVAL_SECONDS=${ORKESTR_UPDATE_INTERVAL_SECONDS:-$update_interval_seconds}
ORKESTR_RELEASE_DEPLOY=${ORKESTR_RELEASE_DEPLOY:-$release_update}
ORKESTR_DEPLOY_CHANNEL=${ORKESTR_DEPLOY_CHANNEL:-$deploy_channel}
ORKESTR_DEPLOY_TAGS_ONLY=${ORKESTR_DEPLOY_TAGS_ONLY:-$deploy_tags_only}
ORKESTR_DEPLOY_ROOT=${ORKESTR_DEPLOY_ROOT:-/opt/orkestr}
ORKESTR_CURRENT_LINK=${ORKESTR_CURRENT_LINK:-/opt/orkestr/current}
ORKESTR_RESET_ON_UPDATE=${ORKESTR_RESET_ON_UPDATE:-0}
ORKESTR_RESET_OVERLAY=${ORKESTR_RESET_OVERLAY:-0}
ORKESTR_RUNTIME_WORKSPACE_ROOT=$workspace_dir
ORKESTR_REDACT_LOCAL_FILE_PATHS=${ORKESTR_REDACT_LOCAL_FILE_PATHS:-0}
ORKESTR_CODEX_BIN=${ORKESTR_CODEX_BIN:-$(codex_bin_default)}
ORKESTR_CODEX_SANDBOX=$codex_sandbox
ORKESTR_CODEX_APPROVAL_POLICY=$codex_approval
ORKESTR_RUNTIME_CODEX_COMMAND="$codex_command"
ORKESTR_CODEX_APP_SERVER_MODE=$codex_app_server_mode
ORKESTR_CODEX_APP_SERVER_SOCKET=$codex_app_server_socket
ORKESTR_CODEX_APP_SERVER_SERVICE_NAME=$codex_app_server_service
ORKESTR_RUNTIME_SUBMIT_KEYS=${ORKESTR_RUNTIME_SUBMIT_KEYS:-C-m}
ORKESTR_RUNTIME_SUBMIT_DELAY_MS=${ORKESTR_RUNTIME_SUBMIT_DELAY_MS:-250}
ORKESTR_WAKE_READY_TIMEOUT_MS=${ORKESTR_WAKE_READY_TIMEOUT_MS:-60000}
CODEX_HOME=${CODEX_HOME:-$data_dir/codex}
PUPPETEER_EXECUTABLE_PATH=${PUPPETEER_EXECUTABLE_PATH:-$chrome}
WA_CHROME_PATH=${WA_CHROME_PATH:-$chrome}
ORKESTR_CHROME_PATH=${ORKESTR_CHROME_PATH:-$chrome}
ORKESTR_BROWSER_DESKTOP_MODE=$desktop_mode
ORKESTR_BROWSERCTL_PATH=$browserctl_path
ORKESTR_DEFAULT_DESKTOP_SLUG=${ORKESTR_DEFAULT_DESKTOP_SLUG:-desktop}
ORKESTR_GMAIL_AUTH_DESKTOP_SLUG=${ORKESTR_GMAIL_AUTH_DESKTOP_SLUG:-gmail}
ORKESTR_MANUAL_INTERVENTION_DESKTOP_SLUG=${ORKESTR_MANUAL_INTERVENTION_DESKTOP_SLUG:-desktop}
ORKESTR_OVERLAY_DIR=${ORKESTR_OVERLAY_DIR:-/opt/orkestr/overlay}
WHATSAPP_BRIDGE_MODE=$wa_bridge_mode
ORKESTR_WHATSAPP_SENDER_ROLE=${ORKESTR_WHATSAPP_SENDER_ROLE:-sender}
ORKESTR_WHATSAPP_RESPONDER_ROLE=${ORKESTR_WHATSAPP_RESPONDER_ROLE:-responder}
ORKESTR_WHATSAPP_EXTERNAL_BRIDGE_ENABLED=$wa_external_enabled
WHATSAPP_BRIDGE_URL=$wa_bridge_url
ORKESTR_CONNECTORS_MCP_URL=${ORKESTR_CONNECTORS_MCP_URL:-http://127.0.0.1:18914/mcp}
# ORKESTR_CONNECTORS_MCP_TOKEN=replace-with-private-operator-token
ORKESTR_WHATSAPP_AUTOSTART=$wa_autostart
WHATSAPP_LOCAL_AUTOSTART=$wa_autostart
OPENAI_API_KEY=
OPENAI_BASE_URL=
OPENAI_MODEL=
GMAIL_OAUTH_CLIENT_ID=
GMAIL_OAUTH_CLIENT_SECRET=
GMAIL_OAUTH_REDIRECT_URI=
OUTLOOK_OAUTH_CLIENT_ID=
OUTLOOK_OAUTH_TENANT_ID=common
OUTLOOK_OAUTH_SCOPES="offline_access User.Read Mail.Read"
JIRA_OAUTH_CLIENT_ID=
JIRA_OAUTH_CLIENT_SECRET=
JIRA_OAUTH_REDIRECT_URI=
JIRA_OAUTH_SCOPES="read:jira-user read:jira-work offline_access"
SHOPIFY_OAUTH_CLIENT_ID=
SHOPIFY_OAUTH_CLIENT_SECRET=
SHOPIFY_OAUTH_REDIRECT_URI=
SHOPIFY_OAUTH_SCOPES="read_products,read_orders"
EOF
  chmod 0640 "$env_file"
}

ensure_overlay_file() {
  local overlay_dir overlay_file
  overlay_dir="${ORKESTR_OVERLAY_DIR:-/opt/orkestr/overlay}"
  overlay_file="$overlay_dir/overlay.json"
  mkdir -p "$overlay_dir"
  if [ ! -e "$overlay_file" ]; then
    cat > "$overlay_file" <<'EOF'
{
  "name": "Private Orkestr",
  "connectors": {},
  "executors": {
    "default": "noop",
    "modules": []
  },
  "agents": [],
  "timers": []
}
EOF
  fi
  chown -R "$run_user:$run_group" "$overlay_dir"
}

env_file_value() {
  local name value
  name="$1"
  value="$(sed -n "s/^${name}=//p" "$env_file" 2>/dev/null | tail -1)"
  value="${value%\"}"
  value="${value#\"}"
  value="${value%\'}"
  value="${value#\'}"
  printf '%s' "$value"
}

named_env_file_value() {
  local file name value
  file="$1"
  name="$2"
  value="$(sed -n "s/^${name}=//p" "$file" 2>/dev/null | tail -1)"
  value="${value%\"}"
  value="${value#\"}"
  value="${value%\'}"
  value="${value#\'}"
  printf '%s' "$value"
}

set_named_env_assignment() {
  local file name value escaped
  file="$1"
  name="$2"
  value="$3"
  escaped="$(sed_replacement_value "$value")"
  if grep -q "^${name}=" "$file" 2>/dev/null; then
    sed -i "s|^${name}=.*|${name}=${escaped}|" "$file"
  else
    printf '%s=%s\n' "$name" "$value" >> "$file"
  fi
}

random_private_token() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    node -e 'console.log(require("node:crypto").randomBytes(32).toString("hex"))'
  fi
}

sed_replacement_value() {
  printf '%s' "$1" | sed 's/[&|]/\\&/g'
}

set_env_assignment() {
  local name value escaped
  name="$1"
  value="$2"
  escaped="$(sed_replacement_value "$value")"
  if grep -q "^${name}=" "$env_file" 2>/dev/null; then
    sed -i "s|^${name}=.*|${name}=${escaped}|" "$env_file"
  else
    printf '%s=%s\n' "$name" "$value" >> "$env_file"
  fi
}

ensure_env_assignment() {
  local name value
  name="$1"
  value="$2"
  if ! grep -q "^${name}=" "$env_file" 2>/dev/null; then
    printf '%s=%s\n' "$name" "$value" >> "$env_file"
  fi
}

migrate_systemd_env_file() {
  local desktop_mode browserctl_path current_mode primary_domain public_site_url app_host auth_host public_url auth_url cookie_domain public_https_url
  desktop_mode="$1"
  browserctl_path="$2"
  primary_domain="${ORKESTR_PRIMARY_DOMAIN:-${ORKESTR_DOMAIN:-}}"
  public_site_url="${ORKESTR_PUBLIC_SITE_URL:-}"
  if [ -z "$public_site_url" ] && [ -n "$primary_domain" ]; then
    public_site_url="https://$primary_domain"
  fi
  app_host="${ORKESTR_APP_HOST:-}"
  auth_host="${ORKESTR_AUTH_HOST:-}"
  if [ -n "$primary_domain" ]; then
    app_host="${app_host:-app.$primary_domain}"
    auth_host="${auth_host:-auth.$primary_domain}"
  fi
  public_url="${ORKESTR_PUBLIC_URL:-${ORKESTR_APP_URL:-}}"
  auth_url="${ORKESTR_AUTH_URL:-}"
  if [ -n "$app_host" ] && [ -z "$public_url" ]; then
    public_url="https://$app_host"
  fi
  if [ -n "$auth_host" ] && [ -z "$auth_url" ]; then
    auth_url="https://$auth_host"
  fi
  cookie_domain="${ORKESTR_COOKIE_DOMAIN:-}"
  if [ -z "$cookie_domain" ] && [ -n "$primary_domain" ] && [ -n "$app_host" ] && [ -n "$auth_host" ] && [ "$app_host" != "$auth_host" ]; then
    cookie_domain="$primary_domain"
  fi
  public_https_url="${ORKESTR_PUBLIC_HTTPS_URL:-$public_url}"
  current_mode="$(env_file_value ORKESTR_BROWSER_DESKTOP_MODE)"
  if [ -z "$current_mode" ] || [ "$current_mode" = "profiles" ]; then
    set_env_assignment ORKESTR_BROWSER_DESKTOP_MODE "$desktop_mode"
  fi
  ensure_env_assignment ORKESTR_BROWSERCTL_PATH "$browserctl_path"
  ensure_env_assignment ORKESTR_DEFAULT_DESKTOP_SLUG "${ORKESTR_DEFAULT_DESKTOP_SLUG:-desktop}"
  ensure_env_assignment ORKESTR_GMAIL_AUTH_DESKTOP_SLUG "${ORKESTR_GMAIL_AUTH_DESKTOP_SLUG:-gmail}"
  ensure_env_assignment ORKESTR_MANUAL_INTERVENTION_DESKTOP_SLUG "${ORKESTR_MANUAL_INTERVENTION_DESKTOP_SLUG:-desktop}"
  ensure_env_assignment ORKESTR_CODEX_APP_SERVER_MODE "${ORKESTR_CODEX_APP_SERVER_MODE:-external}"
  ensure_env_assignment ORKESTR_CODEX_APP_SERVER_SOCKET "$(codex_app_server_socket_default)"
  ensure_env_assignment ORKESTR_CODEX_APP_SERVER_SERVICE_NAME "$(codex_app_server_service_name)"
  ensure_env_assignment ORKESTR_RUNTIME_WORKSPACE_ROOT "$workspace_dir"
  ensure_env_assignment ORKESTR_REDACT_LOCAL_FILE_PATHS "${ORKESTR_REDACT_LOCAL_FILE_PATHS:-0}"
  if [ -n "$primary_domain" ]; then ensure_env_assignment ORKESTR_PRIMARY_DOMAIN "$primary_domain"; fi
  if [ -n "$public_site_url" ]; then ensure_env_assignment ORKESTR_PUBLIC_SITE_URL "$public_site_url"; fi
  if [ -n "$app_host" ]; then ensure_env_assignment ORKESTR_APP_HOST "$app_host"; fi
  if [ -n "$auth_host" ]; then ensure_env_assignment ORKESTR_AUTH_HOST "$auth_host"; fi
  if [ -n "$public_url" ]; then ensure_env_assignment ORKESTR_PUBLIC_URL "$public_url"; fi
  if [ -n "$auth_url" ]; then ensure_env_assignment ORKESTR_AUTH_URL "$auth_url"; fi
  if [ -n "$cookie_domain" ]; then ensure_env_assignment ORKESTR_COOKIE_DOMAIN "$cookie_domain"; fi
  if [ -n "$public_https_url" ]; then ensure_env_assignment ORKESTR_PUBLIC_HTTPS_URL "$public_https_url"; fi
  chmod 0640 "$env_file" || true
}

local_service_name() {
  echo "${ORKESTR_LOCAL_SERVICE_NAME:-orkestr}"
}

local_service_label() {
  echo "${ORKESTR_LOCAL_SERVICE_LABEL:-com.orkestr.oss}"
}

local_log_dir() {
  echo "${ORKESTR_LOCAL_LOG_DIR:-$data_dir/logs}"
}

local_pid_file() {
  echo "${ORKESTR_LOCAL_PID_FILE:-$data_dir/orkestr.pid}"
}

local_tmux_session() {
  echo "${ORKESTR_LOCAL_TMUX_SESSION:-orkestr-service}"
}

local_server_wrapper() {
  echo "${ORKESTR_LOCAL_SERVER_WRAPPER:-$data_dir/bin/orkestr-server}"
}

local_app_dir() {
  if [ -n "${repo_dir:-}" ]; then
    echo "$repo_dir"
  elif [ "$local_mode" -eq 1 ]; then
    pwd
  else
    echo "$install_dir"
  fi
}

local_server_process_path() {
  echo "$(local_app_dir)/dist/server/apps/server/src/server.js"
}

local_cli_bin() {
  local bin_dir
  bin_dir="${ORKESTR_LOCAL_BIN_DIR:-$HOME/.local/bin}"
  echo "${ORKESTR_LOCAL_CLI_BIN:-$bin_dir/orkestr}"
}

local_service_file() {
  case "$1" in
    launchd)
      echo "$HOME/Library/LaunchAgents/$(local_service_label).plist"
      ;;
    systemd-user)
      echo "$HOME/.config/systemd/user/$(local_service_name).service"
      ;;
    cron)
      echo "$data_dir/cron-service"
      ;;
    background)
      echo "$data_dir/background-service"
      ;;
    *)
      echo ""
      ;;
  esac
}

xml_escape() {
  node -e 'process.stdout.write(String(process.argv[1] || "").replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "\"": "&quot;" }[c])))' "$1"
}

local_service_manager() {
  if is_macos; then
    echo "background"
    return 0
  fi
  if have systemctl && systemctl --user list-units >/dev/null 2>&1; then
    echo "systemd-user"
    return 0
  fi
  if have crontab; then
    echo "cron"
    return 0
  fi
  echo "none"
}

effective_local_service_manager() {
  local manager
  manager="${ORKESTR_LOCAL_SERVICE_MANAGER:-$(local_service_manager)}"
  if is_macos && [ "$manager" = "launchd" ] && [ "${ORKESTR_ALLOW_MACOS_LAUNCHD:-0}" != "1" ]; then
    echo "background"
    return 0
  fi
  echo "$manager"
}

write_local_server_wrapper() {
  local wrapper node_bin
  wrapper="$(local_server_wrapper)"
  node_bin="$(command -v node)"
  mkdir -p "$(dirname "$wrapper")" "$(local_log_dir)"
  cat > "$wrapper" <<EOF
#!/usr/bin/env bash
set -euo pipefail
env_file=$(shell_quote "$local_env_file")
if [ -r "\$env_file" ]; then
  set -a
  # shellcheck disable=SC1090
  . "\$env_file"
  set +a
fi
cd $(shell_quote "$repo_dir")
exec $(shell_quote "$node_bin") $(shell_quote "$repo_dir/dist/server/apps/server/src/server.js")
EOF
  chmod 0755 "$wrapper"
}

write_local_cli_wrapper() {
  local wrapper node_bin
  wrapper="$(local_cli_bin)"
  node_bin="$(command -v node)"
  mkdir -p "$(dirname "$wrapper")"
  cat > "$wrapper" <<EOF
#!/usr/bin/env bash
set -euo pipefail
env_file=$(shell_quote "$local_env_file")
if [ -r "\$env_file" ]; then
  set -a
  # shellcheck disable=SC1090
  . "\$env_file"
  set +a
fi
cd $(shell_quote "$repo_dir")
exec $(shell_quote "$node_bin") $(shell_quote "$repo_dir/apps/cli/bin/orkestr-oss.js") "\$@"
EOF
  chmod 0755 "$wrapper"
}

install_launchd_service() {
  local plist label domain out_log err_log wrapper
  plist="$(local_service_file launchd)"
  label="$(local_service_label)"
  domain="gui/$(id -u)"
  out_log="$(local_log_dir)/orkestr.out.log"
  err_log="$(local_log_dir)/orkestr.err.log"
  wrapper="$(local_server_wrapper)"
  mkdir -p "$(dirname "$plist")" "$(local_log_dir)"
  cat > "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$(xml_escape "$label")</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(xml_escape "$wrapper")</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$(xml_escape "$repo_dir")</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$(xml_escape "$out_log")</string>
  <key>StandardErrorPath</key>
  <string>$(xml_escape "$err_log")</string>
</dict>
</plist>
EOF
  launchctl bootout "$domain/$label" >/dev/null 2>&1 || launchctl bootout "$domain" "$plist" >/dev/null 2>&1 || true
  if [ "$start_after_install" = "1" ]; then
    launchctl bootstrap "$domain" "$plist"
    launchctl kickstart -k "$domain/$label"
  fi
}

install_systemd_user_service() {
  local unit unit_file wrapper
  unit="$(local_service_name).service"
  unit_file="$(local_service_file systemd-user)"
  wrapper="$(local_server_wrapper)"
  mkdir -p "$(dirname "$unit_file")" "$(local_log_dir)"
  cat > "$unit_file" <<EOF
[Unit]
Description=Orkestr local user service
Documentation=https://github.com/otcan/orkestr
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$repo_dir
Environment=ORKESTR_ENV_FILE=$local_env_file
ExecStart=$wrapper
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable "$unit"
  if [ "$start_after_install" = "1" ]; then
    systemctl --user restart "$unit"
  fi
}

install_cron_service() {
  local wrapper out_log err_log pid_file tmp marker
  wrapper="$(local_server_wrapper)"
  out_log="$(local_log_dir)/orkestr.out.log"
  err_log="$(local_log_dir)/orkestr.err.log"
  pid_file="$(local_pid_file)"
  marker="# orkestr local service"
  tmp="$(mktemp)"
  mkdir -p "$(local_log_dir)"
  crontab -l 2>/dev/null | grep -vF "$marker" > "$tmp" || true
  printf "@reboot %s >> %s 2>> %s %s\n" "$(shell_quote "$wrapper")" "$(shell_quote "$out_log")" "$(shell_quote "$err_log")" "$marker" >> "$tmp"
  crontab "$tmp"
  rm -f "$tmp"
  if [ "$start_after_install" = "1" ]; then
    start_local_background_process
  fi
}

start_local_background_process() {
  local wrapper out_log err_log pid_file session command
  wrapper="$(local_server_wrapper)"
  out_log="$(local_log_dir)/orkestr.out.log"
  err_log="$(local_log_dir)/orkestr.err.log"
  pid_file="$(local_pid_file)"
  session="$(local_tmux_session)"
  mkdir -p "$(local_log_dir)"
  if [ -f "$pid_file" ] && kill -0 "$(cat "$pid_file")" >/dev/null 2>&1; then
    return 0
  fi
  if have tmux; then
    tmux kill-session -t "$session" >/dev/null 2>&1 || true
    command="exec $(shell_quote "$wrapper") >> $(shell_quote "$out_log") 2>> $(shell_quote "$err_log")"
    if tmux new-session -d -s "$session" "$command"; then
      tmux display-message -p -t "$session" '#{pane_pid}' > "$pid_file" 2>/dev/null || true
      return 0
    fi
  fi
  nohup "$wrapper" >> "$out_log" 2>> "$err_log" &
  echo "$!" > "$pid_file"
}

install_background_service() {
  local marker_file
  marker_file="$(local_service_file background)"
  mkdir -p "$(local_log_dir)" "$(dirname "$marker_file")"
  cat > "$marker_file" <<EOF
Orkestr local background service.
Use $(local_cli_bin) service start|stop|restart|status|logs.
EOF
  if [ "$start_after_install" = "1" ]; then
    start_local_background_process
  fi
}

install_local_service() {
  local manager
  manager="$1"
  if is_macos && [ "$manager" = "launchd" ] && [ "${ORKESTR_ALLOW_MACOS_LAUNCHD:-0}" != "1" ]; then
    echo "Ignoring ORKESTR_LOCAL_SERVICE_MANAGER=launchd on macOS because ORKESTR_ALLOW_MACOS_LAUNCHD is not 1. Using background service."
    manager="background"
  fi
  case "$manager" in
    launchd)
      install_launchd_service
      ;;
    systemd-user)
      install_systemd_user_service
      ;;
    cron)
      install_cron_service
      ;;
    background)
      install_background_service
      ;;
    *)
      cat >&2 <<EOF
No supported local service manager was found.

Install systemd user services, launchd, or cron, or rerun:
  ./scripts/install.sh --no-service --serve
EOF
      exit 1
      ;;
  esac
}

safe_remove_path() {
  local path
  path="${1:-}"
  [ -n "$path" ] || return 0
  case "$path" in
    "/"|"$HOME"|"$HOME/"|"/home"|"/Users"|"/root"|"/opt"|"/usr"|"/usr/local")
      echo "Refusing to remove unsafe path during fresh install: $path" >&2
      exit 1
      ;;
  esac
  rm -rf "$path"
}

remove_local_cron_entry() {
  local tmp marker
  if is_macos; then
    return 0
  fi
  if ! have crontab; then
    return 0
  fi
  marker="# orkestr local service"
  tmp="$(mktemp)"
  crontab -l 2>/dev/null | grep -vF "$marker" > "$tmp" || true
  crontab "$tmp" 2>/dev/null || true
  rm -f "$tmp"
}

stop_local_server_processes() {
  local wrapper server_js session
  session="$(local_tmux_session)"
  if have tmux; then
    tmux kill-session -t "$session" >/dev/null 2>&1 || true
  fi
  if ! have pkill; then
    return 0
  fi
  wrapper="$(local_server_wrapper)"
  server_js="$(local_server_process_path)"
  [ -n "$wrapper" ] && pkill -f "$wrapper" >/dev/null 2>&1 || true
  [ -n "$server_js" ] && pkill -f "$server_js" >/dev/null 2>&1 || true
}

stop_local_service_if_present() {
  local label domain plist unit unit_file pid_file pid
  label="$(local_service_label)"
  plist="$(local_service_file launchd)"
  unit="$(local_service_name).service"
  unit_file="$(local_service_file systemd-user)"
  pid_file="$(local_pid_file)"
  if is_macos && have launchctl && [ "${ORKESTR_ALLOW_MACOS_LAUNCHD:-0}" = "1" ]; then
    domain="gui/$(id -u)"
    launchctl bootout "$domain/$label" >/dev/null 2>&1 || launchctl bootout "$domain" "$plist" >/dev/null 2>&1 || true
    rm -f "$plist"
  fi
  if have systemctl; then
    systemctl --user disable --now "$unit" >/dev/null 2>&1 || true
    rm -f "$unit_file"
    systemctl --user daemon-reload >/dev/null 2>&1 || true
  fi
  remove_local_cron_entry
  if [ -r "$pid_file" ]; then
    pid="$(cat "$pid_file" 2>/dev/null || true)"
    if [ -n "$pid" ]; then
      kill "$pid" >/dev/null 2>&1 || true
    fi
    rm -f "$pid_file"
  fi
  stop_local_server_processes
}

fresh_reset_local_install() {
  if [ "$systemd" -eq 1 ]; then
    echo "--fresh is only supported for local installs. For VPS resets, use orkestr-reset-state." >&2
    exit 2
  fi
  echo "Fresh local install requested: stopping Orkestr and removing local runtime state."
  stop_local_service_if_present
  rm -f "$(local_cli_bin)" "$(local_service_file launchd)" "$(local_service_file systemd-user)" "$(local_service_file cron)"
  safe_remove_path "$data_dir"
  if [ "$local_mode" -ne 1 ]; then
    safe_remove_path "$install_dir"
  fi
}

write_local_env_file() {
  local primary_domain public_site_url app_host auth_host public_url auth_url cookie_domain public_https_url
  primary_domain="${ORKESTR_PRIMARY_DOMAIN:-${ORKESTR_DOMAIN:-}}"
  public_site_url="${ORKESTR_PUBLIC_SITE_URL:-}"
  if [ -z "$public_site_url" ] && [ -n "$primary_domain" ]; then
    public_site_url="https://$primary_domain"
  fi
  app_host="${ORKESTR_APP_HOST:-}"
  auth_host="${ORKESTR_AUTH_HOST:-}"
  if [ -n "$primary_domain" ]; then
    app_host="${app_host:-app.$primary_domain}"
    auth_host="${auth_host:-auth.$primary_domain}"
  fi
  public_url="${ORKESTR_PUBLIC_URL:-${ORKESTR_APP_URL:-}}"
  auth_url="${ORKESTR_AUTH_URL:-}"
  if [ -n "$app_host" ] && [ -z "$public_url" ]; then
    public_url="https://$app_host"
  fi
  if [ -n "$auth_host" ] && [ -z "$auth_url" ]; then
    auth_url="https://$auth_host"
  fi
  cookie_domain="${ORKESTR_COOKIE_DOMAIN:-}"
  if [ -z "$cookie_domain" ] && [ -n "$primary_domain" ] && [ -n "$app_host" ] && [ -n "$auth_host" ] && [ "$app_host" != "$auth_host" ]; then
    cookie_domain="$primary_domain"
  fi
  public_https_url="${ORKESTR_PUBLIC_HTTPS_URL:-$public_url}"
  mkdir -p "$(dirname "$local_env_file")"
  {
    echo "# Orkestr local environment."
    echo "# Source this file before running Orkestr manually from the checkout."
    write_env_var PATH "$(local_runtime_path)"
    write_env_var ORKESTR_APP_DIR "$repo_dir"
    write_env_var ORKESTR_HOME "$data_dir"
    write_env_var ORKESTR_HOST "$host"
    write_env_var ORKESTR_PORT "$port"
    write_env_var ORKESTR_PRIMARY_DOMAIN "$primary_domain"
    write_env_var ORKESTR_PUBLIC_SITE_URL "$public_site_url"
    write_env_var ORKESTR_APP_HOST "$app_host"
    write_env_var ORKESTR_AUTH_HOST "$auth_host"
    write_env_var ORKESTR_PUBLIC_URL "$public_url"
    write_env_var ORKESTR_AUTH_URL "$auth_url"
    write_env_var ORKESTR_COOKIE_DOMAIN "$cookie_domain"
    write_env_var ORKESTR_PUBLIC_HTTPS_URL "$public_https_url"
    write_env_var ORKESTR_INSTALL_PROFILE "$install_profile"
    write_env_var ORKESTR_INSTALL_LOCAL_SERVICE "$local_service"
    write_env_var ORKESTR_START_AFTER_INSTALL "$start_after_install"
    write_env_var ORKESTR_RUNTIME_SETTINGS_FILE "${ORKESTR_RUNTIME_SETTINGS_FILE:-$data_dir/runtime-settings.json}"
    write_env_var ORKESTR_RUNTIME_WORKSPACE_ROOT "$workspace_dir"
    write_env_var ORKESTR_REDACT_LOCAL_FILE_PATHS "${ORKESTR_REDACT_LOCAL_FILE_PATHS:-0}"
    write_env_var ORKESTR_CODEX_BIN "${ORKESTR_CODEX_BIN:-$(codex_bin_default)}"
    write_env_var ORKESTR_RUNTIME_CODEX_COMMAND "${ORKESTR_RUNTIME_CODEX_COMMAND:-$(codex_command_default)}"
    write_env_var CODEX_HOME "${CODEX_HOME:-$(local_codex_home_default)}"
    write_env_var ORKESTR_LOCAL_SERVICE_MANAGER "${ORKESTR_LOCAL_SERVICE_MANAGER:-}"
    write_env_var ORKESTR_LOCAL_SERVICE_NAME "$(local_service_name)"
    write_env_var ORKESTR_LOCAL_SERVICE_LABEL "$(local_service_label)"
    write_env_var ORKESTR_LOCAL_SERVICE_FILE "${ORKESTR_LOCAL_SERVICE_FILE:-$(local_service_file "${ORKESTR_LOCAL_SERVICE_MANAGER:-}")}"
    write_env_var ORKESTR_LOCAL_SERVER_WRAPPER "$(local_server_wrapper)"
    write_env_var ORKESTR_LOCAL_LOG_DIR "$(local_log_dir)"
    write_env_var ORKESTR_LOCAL_PID_FILE "$(local_pid_file)"
    write_env_var ORKESTR_LOCAL_TMUX_SESSION "$(local_tmux_session)"
    write_env_var ORKESTR_LOCAL_CLI_BIN "$(local_cli_bin)"
  } > "$local_env_file"
  chmod 0600 "$local_env_file"
}

write_runtime_settings_file() {
  local runtime_settings_file codex_command codex_sandbox codex_approval codex_app_server_mode codex_app_server_socket codex_app_server_service desktop_mode default_desktop gmail_desktop manual_desktop desktop_provisioned desktop_enabled wa_sender wa_responder wa_mode gmail_enabled outlook_enabled
  runtime_settings_file="${ORKESTR_RUNTIME_SETTINGS_FILE:-$data_dir/runtime-settings.json}"
  codex_command="${ORKESTR_RUNTIME_CODEX_COMMAND:-$(codex_command_default)}"
  codex_sandbox="${ORKESTR_CODEX_SANDBOX:-$(codex_sandbox_default)}"
  codex_approval="${ORKESTR_CODEX_APPROVAL_POLICY:-$(codex_approval_default)}"
  codex_app_server_mode="${ORKESTR_CODEX_APP_SERVER_MODE:-$([ "$systemd" -eq 1 ] && echo external || echo stdio)}"
  codex_app_server_socket="$(codex_app_server_socket_default)"
  codex_app_server_service="$(codex_app_server_service_name)"
  if [ "$systemd" -eq 1 ]; then
    desktop_mode="${ORKESTR_BROWSER_DESKTOP_MODE:-browserctl}"
  else
    desktop_mode="${ORKESTR_BROWSER_DESKTOP_MODE:-profiles}"
  fi
  default_desktop="${ORKESTR_DEFAULT_DESKTOP_SLUG:-desktop}"
  gmail_desktop="${ORKESTR_GMAIL_AUTH_DESKTOP_SLUG:-gmail}"
  manual_desktop="${ORKESTR_MANUAL_INTERVENTION_DESKTOP_SLUG:-desktop}"
  desktop_provisioned=true
  case "${ORKESTR_INSTANCE_DESKTOPS_PROVISIONED:-}" in
    0|false|False|FALSE|no|No|NO|off|Off|OFF|disabled|Disabled|DISABLED) desktop_provisioned=false ;;
  esac
  desktop_enabled=true
  case "$desktop_mode" in
    disabled|none|off) desktop_enabled=false ;;
  esac
  if [ "$desktop_provisioned" = "false" ]; then
    desktop_enabled=false
  fi
  wa_sender="${ORKESTR_WHATSAPP_SENDER_ROLE:-sender}"
  wa_responder="${ORKESTR_WHATSAPP_RESPONDER_ROLE:-responder}"
  wa_mode="${WHATSAPP_BRIDGE_MODE:-local}"
  gmail_enabled="${ORKESTR_GMAIL_ENABLED:-0}"
  outlook_enabled="${ORKESTR_OUTLOOK_ENABLED:-0}"
  jira_enabled="${ORKESTR_JIRA_ENABLED:-0}"
  shopify_enabled="${ORKESTR_SHOPIFY_ENABLED:-0}"
  if [ -n "${GMAIL_OAUTH_CLIENT_ID:-}" ]; then
    gmail_enabled=1
  fi
  if [ -n "${OUTLOOK_OAUTH_CLIENT_ID:-${MICROSOFT_OAUTH_CLIENT_ID:-}}" ]; then
    outlook_enabled=1
  fi
  if [ -n "${JIRA_OAUTH_CLIENT_ID:-${ATLASSIAN_OAUTH_CLIENT_ID:-}}" ]; then
    jira_enabled=1
  fi
  if [ -n "${SHOPIFY_OAUTH_CLIENT_ID:-${SHOPIFY_CLIENT_ID:-${SHOPIFY_API_KEY:-}}}" ]; then
    shopify_enabled=1
  fi
  mkdir -p "$(dirname "$runtime_settings_file")"
  cat > "$runtime_settings_file" <<EOF
{
  "schemaVersion": 1,
  "generatedBy": "scripts/install.sh",
  "updatedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
EOF
  if [ -n "$install_profile" ]; then
    printf '  "profile": %s,\n' "$(json_string "$install_profile")" >> "$runtime_settings_file"
  fi
  cat >> "$runtime_settings_file" <<EOF
  "codex": {
    "command": $(json_string "$codex_command"),
    "sandbox": $(json_string "$codex_sandbox"),
    "approvalPolicy": $(json_string "$codex_approval"),
    "appServer": {
      "mode": $(json_string "$codex_app_server_mode"),
      "socket": $(json_string "$codex_app_server_socket"),
      "serviceName": $(json_string "$codex_app_server_service")
    },
    "bypassApprovalsAndSandbox": $(codex_bypasses_approvals "$codex_command" "$codex_sandbox" "$codex_approval" && echo true || echo false),
    "permissionPrompts": {
      "mirrorToWhatsApp": $(codex_bypasses_approvals "$codex_command" "$codex_sandbox" "$codex_approval" && echo false || echo true),
      "approveReplies": ["/approve", "approve", "approved", "yes", "y", "allow", "go", "proceed"],
      "denyReplies": ["/deny", "deny", "no", "n", "reject", "stop", "cancel"],
      "alwaysApprove": {
        "enabled": false,
        "requiresExplicitScope": true,
        "allowedScopes": ["this-thread", "session"]
      }
    }
  },
  "desktops": {
    "enabled": $desktop_enabled,
    "provisioned": $desktop_provisioned,
    "mode": $(json_string "$desktop_mode"),
    "default": $(json_string "$default_desktop"),
    "gmailAuth": $(json_string "$gmail_desktop"),
    "manualIntervention": $(json_string "$manual_desktop")
  },
  "connectors": {
    "whatsapp": {
      "enabled": true,
      "bridgeMode": $(json_string "$wa_mode"),
      "senderRole": $(json_string "$wa_sender"),
      "responderRole": $(json_string "$wa_responder")
    },
    "gmail": {
      "enabled": $([ "$gmail_enabled" = "1" ] && echo true || echo false),
      "authDesktop": $(json_string "$gmail_desktop"),
      "needsAuthAction": "gmail.oauth.start"
    },
    "outlook": {
      "enabled": $([ "$outlook_enabled" = "1" ] && echo true || echo false),
      "needsAuthAction": "outlook.device.start"
    },
    "jira": {
      "enabled": $([ "$jira_enabled" = "1" ] && echo true || echo false),
      "needsAuthAction": "jira.oauth.start"
    },
    "shopify": {
      "enabled": $([ "$shopify_enabled" = "1" ] && echo true || echo false),
      "needsAuthAction": "shopify.oauth.start"
    }
  },
  "intervention": {
    "manualDesktop": $(json_string "$manual_desktop"),
    "states": {
      "codex": {
        "awaitingApproval": "Reply approve or deny in WhatsApp, or use the Orkestr UI approval control."
      },
      "gmail": {
        "needsAuth": "Open the configured Gmail auth desktop and reconnect Gmail OAuth."
      },
      "outlook": {
        "needsDeviceCode": "Start Outlook device sign-in and approve the Microsoft device code."
      },
      "desktop": {
        "needsManualIntervention": $(json_string "Use the $manual_desktop managed desktop for manual browser steps.")
      }
    }
  }
}
EOF
  chmod 0644 "$runtime_settings_file"
}

write_cli_wrapper() {
  cat > /usr/local/bin/orkestr <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
env_file="${ORKESTR_ENV_FILE:-/etc/orkestr/orkestr.env}"
if [ -r "$env_file" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$env_file"
  set +a
fi
app_dir="${ORKESTR_APP_DIR:-/opt/orkestr/app}"
current_link="${ORKESTR_CURRENT_LINK:-/opt/orkestr/current}"
if [ "${ORKESTR_RELEASE_DEPLOY:-0}" = "1" ] && [ -e "$current_link" ]; then
  app_dir="$current_link"
fi
cd "$app_dir"
run_user="${ORKESTR_RUN_USER:-}"
if [ -z "$run_user" ] && command -v systemctl >/dev/null 2>&1; then
  run_user="$(systemctl show -p User --value "${ORKESTR_SERVICE_NAME:-orkestr}.service" 2>/dev/null || true)"
fi
run_user="${run_user:-orkestr}"
case "${1:-}" in
  update)
    exec node "$app_dir/apps/cli/bin/orkestr-oss.js" "$@"
    ;;
esac
if [ "$(id -u)" -eq 0 ] && [ "${ORKESTR_CLI_RUN_AS_ROOT:-0}" != "1" ] && id "$run_user" >/dev/null 2>&1; then
  if ! command -v runuser >/dev/null 2>&1; then
    echo "Missing required command: runuser" >&2
    exit 1
  fi
  run_home="$(getent passwd "$run_user" | cut -d: -f6)"
  export HOME="${run_home:-${ORKESTR_HOME:-/opt/orkestr/home}}"
  export USER="$run_user"
  export LOGNAME="$run_user"
  exec runuser -u "$run_user" --preserve-environment -- node "$app_dir/apps/cli/bin/orkestr-oss.js" "$@"
fi
exec node "$app_dir/apps/cli/bin/orkestr-oss.js" "$@"
EOF
  chmod 0755 /usr/local/bin/orkestr
}

write_update_wrapper() {
  cat > /usr/local/bin/orkestr-update <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
env_file="${ORKESTR_ENV_FILE:-/etc/orkestr/orkestr.env}"
if [ -r "$env_file" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$env_file"
  set +a
fi
app_dir="${ORKESTR_APP_DIR:-/opt/orkestr/app}"
current_link="${ORKESTR_CURRENT_LINK:-/opt/orkestr/current}"
if [ "${ORKESTR_RELEASE_DEPLOY:-0}" = "1" ] && [ -e "$current_link" ]; then
  app_dir="$current_link"
fi
cd "$app_dir"
exec bash "$app_dir/scripts/update-watch.sh" "$@"
EOF
  chmod 0755 /usr/local/bin/orkestr-update
}

write_deploy_wrapper() {
  cat > /usr/local/bin/orkestr-deploy <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
env_file="${ORKESTR_ENV_FILE:-/etc/orkestr/orkestr.env}"
if [ -r "$env_file" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$env_file"
  set +a
fi
app_dir="${ORKESTR_APP_DIR:-/opt/orkestr/app}"
current_link="${ORKESTR_CURRENT_LINK:-/opt/orkestr/current}"
if [ "${ORKESTR_RELEASE_DEPLOY:-0}" = "1" ] && [ -e "$current_link" ]; then
  app_dir="$current_link"
fi
cd "$app_dir"
exec bash "$app_dir/scripts/deploy-git-release.sh" "$@"
EOF
  chmod 0755 /usr/local/bin/orkestr-deploy
}

write_reset_wrapper() {
  cat > /usr/local/bin/orkestr-reset-state <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
env_file="${ORKESTR_ENV_FILE:-/etc/orkestr/orkestr.env}"
if [ -r "$env_file" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$env_file"
  set +a
fi
app_dir="${ORKESTR_APP_DIR:-/opt/orkestr/app}"
current_link="${ORKESTR_CURRENT_LINK:-/opt/orkestr/current}"
if [ "${ORKESTR_RELEASE_DEPLOY:-0}" = "1" ] && [ -e "$current_link" ]; then
  app_dir="$current_link"
fi
cd "$app_dir"
exec bash "$app_dir/scripts/reset-vps-state.sh" "$@"
EOF
  chmod 0755 /usr/local/bin/orkestr-reset-state
}

write_browserctl_wrapper() {
  cat > /usr/local/bin/orkestr-browserctl <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
env_file="${ORKESTR_ENV_FILE:-/etc/orkestr/orkestr.env}"
if [ -r "$env_file" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$env_file"
  set +a
fi
app_dir="${ORKESTR_APP_DIR:-/opt/orkestr/app}"
current_link="${ORKESTR_CURRENT_LINK:-/opt/orkestr/current}"
if [ "${ORKESTR_RELEASE_DEPLOY:-0}" = "1" ] && [ -e "$current_link" ]; then
  app_dir="$current_link"
fi
cd "$app_dir"
run_user="${ORKESTR_RUN_USER:-}"
if [ -z "$run_user" ] && command -v systemctl >/dev/null 2>&1; then
  run_user="$(systemctl show -p User --value "${ORKESTR_SERVICE_NAME:-orkestr}.service" 2>/dev/null || true)"
fi
run_user="${run_user:-orkestr}"
if [ "$(id -u)" -eq 0 ] && [ "${ORKESTR_BROWSERCTL_RUN_AS_ROOT:-0}" != "1" ] && id "$run_user" >/dev/null 2>&1; then
  if ! command -v runuser >/dev/null 2>&1; then
    echo "Missing required command: runuser" >&2
    exit 1
  fi
  run_home="$(getent passwd "$run_user" | cut -d: -f6)"
  export HOME="${run_home:-${ORKESTR_HOME:-/opt/orkestr/home}}"
  export USER="$run_user"
  export LOGNAME="$run_user"
  exec runuser -u "$run_user" --preserve-environment -- node "$app_dir/scripts/browserctl.mjs" "$@"
fi
exec node "$app_dir/scripts/browserctl.mjs" "$@"
EOF
  chmod 0755 /usr/local/bin/orkestr-browserctl
}

prepare_default_desktop_profiles() {
  if [ "${ORKESTR_PREPARE_DEFAULT_DESKTOPS:-1}" = "0" ]; then
    return 0
  fi
  if [ "${ORKESTR_BROWSER_DESKTOP_MODE:-browserctl}" != "browserctl" ]; then
    return 0
  fi
  local seen_slugs slug
  seen_slugs=""
  for slug in "${ORKESTR_DEFAULT_DESKTOP_SLUG:-desktop}" "${ORKESTR_MANUAL_INTERVENTION_DESKTOP_SLUG:-desktop}"; do
    if [ -z "$slug" ] || printf '%s\n' "$seen_slugs" | grep -qx "$slug"; then
      continue
    fi
    seen_slugs="${seen_slugs}${slug}
"
    ORKESTR_HOME="$data_dir" /usr/local/bin/orkestr-browserctl health "$slug" >/dev/null
  done
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

write_systemd_codex_app_server_service() {
  local service_name group_name
  service_name="$(codex_app_server_service_name)"
  group_name="$(id -gn "$run_user")"
  cat > "/etc/systemd/system/${service_name}.service" <<EOF
[Unit]
Description=Orkestr Codex app-server runtime
Documentation=https://github.com/otcan/orkestr
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$run_user
Group=$group_name
WorkingDirectory=$repo_dir
EnvironmentFile=-$env_file
ExecStart=/usr/local/bin/orkestr-codex-app-server
Restart=on-failure
RestartSec=3
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable "${service_name}.service"
  systemctl restart "${service_name}.service"
}

write_systemd_service() {
  local service_name group_name codex_service_name timeout_stop_sec
  service_name="$(systemd_service_name)"
  codex_service_name="$(codex_app_server_service_name)"
  timeout_stop_sec="${ORKESTR_SERVICE_TIMEOUT_STOP_SEC:-15s}"
  group_name="$(id -gn "$run_user")"
  cat > "/etc/systemd/system/${service_name}.service" <<EOF
[Unit]
Description=Orkestr host-native service
Documentation=https://github.com/otcan/orkestr
After=network-online.target ${codex_service_name}.service
Wants=network-online.target ${codex_service_name}.service

[Service]
Type=simple
User=$run_user
Group=$group_name
WorkingDirectory=$repo_dir
EnvironmentFile=-$env_file
ExecStart=/usr/local/bin/orkestr serve
Restart=on-failure
RestartSec=5
TimeoutStopSec=$timeout_stop_sec
KillMode=process
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable "${service_name}.service"
  systemctl restart "${service_name}.service"
}

write_systemd_wa_service() {
  local service_name group_name wa_home wa_env_file timeout_stop_sec node_bin
  service_name="$(wa_service_name)"
  group_name="$(id -gn "$run_user")"
  wa_home="${ORKESTR_WA_SERVICE_HOME:-$data_dir/wa-service}"
  wa_env_file="${ORKESTR_WA_SERVICE_ENV_FILE:-/etc/orkestr/orkestr-wa.env}"
  timeout_stop_sec="${ORKESTR_WA_SERVICE_TIMEOUT_STOP_SEC:-30s}"
  node_bin="$(command -v node || echo /usr/bin/node)"
  mkdir -p "$wa_home" "$(dirname "$wa_env_file")"
  chown -R "$run_user:$group_name" "$wa_home"
  if [ ! -f "$wa_env_file" ]; then
    cat > "$wa_env_file" <<EOF
# Orkestr standalone WhatsApp service environment.
# Keep account client ids, session roots, service tokens, and policy JSON in this private file.
ORKESTR_HOME=$wa_home
ORKESTR_WA_SERVICE_HOST=${ORKESTR_WA_SERVICE_HOST:-127.0.0.1}
ORKESTR_WA_SERVICE_PORT=${ORKESTR_WA_SERVICE_PORT:-18914}
ORKESTR_WHATSAPP_AUTOSTART=1
ORKESTR_WHATSAPP_AUTOSTART_ACCOUNT_IDS=${ORKESTR_WHATSAPP_AUTOSTART_ACCOUNT_IDS:-sender,responder}
ORKESTR_WHATSAPP_ACCOUNT_IDS=${ORKESTR_WHATSAPP_ACCOUNT_IDS:-sender,responder}
# ORKESTR_WA_SERVICE_TOKEN=
# ORKESTR_WA_SERVICE_POLICY_JSON=
# ORKESTR_WHATSAPP_ACCOUNT_CLIENT_IDS=
# ORKESTR_WHATSAPP_ACCOUNT_SESSION_ROOTS=
EOF
    chmod 0600 "$wa_env_file"
    chgrp "$group_name" "$wa_env_file" || true
  fi
  cat > "/etc/systemd/system/${service_name}.service" <<EOF
[Unit]
Description=Orkestr standalone WhatsApp bridge
Documentation=https://github.com/otcan/orkestr
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$run_user
Group=$group_name
WorkingDirectory=$repo_dir
EnvironmentFile=-$wa_env_file
ExecStart=$node_bin scripts/orkestr-wa-service.mjs
Restart=on-failure
RestartSec=5
TimeoutStopSec=$timeout_stop_sec
KillMode=mixed
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable "${service_name}.service"
  systemctl restart "${service_name}.service"
}

write_systemd_connectors_services() {
  local gateway_service worker_service group_name connectors_env node_bin timeout_stop_sec mcp_token worker_token event_token
  gateway_service="$(connectors_mcp_service_name)"
  worker_service="$(wa_worker_service_name)"
  group_name="$(id -gn "$run_user")"
  connectors_env="${ORKESTR_CONNECTORS_ENV_FILE:-/etc/orkestr/orkestr-connectors.env}"
  node_bin="$(command -v node || echo /usr/bin/node)"
  timeout_stop_sec="${ORKESTR_CONNECTORS_TIMEOUT_STOP_SEC:-30s}"
  mkdir -p "$(dirname "$connectors_env")" "$data_dir/connectors" "$data_dir/wa-worker"
  chown -R "$run_user:$group_name" "$data_dir/connectors" "$data_dir/wa-worker"
  if [ ! -f "$connectors_env" ]; then
    cat > "$connectors_env" <<EOF
# Private Orkestr connector gateway and WhatsApp worker environment.
ORKESTR_HOME=$data_dir
ORKESTR_CONNECTORS_MCP_HOST=127.0.0.1
ORKESTR_CONNECTORS_MCP_PORT=18914
ORKESTR_WA_WORKER_SOCKET=/run/orkestr-wa/sender.sock
ORKESTR_WA_WORKER_EVENT_SINK_URL=http://127.0.0.1:18914/internal/whatsapp/inbound
ORKESTR_WHATSAPP_AUTOSTART=1
ORKESTR_WHATSAPP_AUTOSTART_ACCOUNT_IDS=sender
ORKESTR_WHATSAPP_ACCOUNT_IDS=sender
# ORKESTR_CONNECTORS_MCP_TOKENS_JSON=
# ORKESTR_WA_SERVICE_POLICY_JSON=
EOF
    chmod 0600 "$connectors_env"
    chgrp "$group_name" "$connectors_env" || true
  fi
  mcp_token="$(named_env_file_value "$connectors_env" ORKESTR_CONNECTORS_MCP_TOKEN)"
  worker_token="$(named_env_file_value "$connectors_env" ORKESTR_WA_WORKER_TOKEN)"
  event_token="$(named_env_file_value "$connectors_env" ORKESTR_WA_WORKER_EVENT_TOKEN)"
  [ -n "$mcp_token" ] || mcp_token="$(random_private_token)"
  [ -n "$worker_token" ] || worker_token="$(random_private_token)"
  [ -n "$event_token" ] || event_token="$(random_private_token)"
  set_named_env_assignment "$connectors_env" ORKESTR_CONNECTORS_MCP_TOKEN "$mcp_token"
  set_named_env_assignment "$connectors_env" ORKESTR_WA_SERVICE_TOKEN "$mcp_token"
  set_named_env_assignment "$connectors_env" ORKESTR_WA_WORKER_TOKEN "$worker_token"
  set_named_env_assignment "$connectors_env" ORKESTR_WA_WORKER_EVENT_TOKEN "$event_token"
  set_env_assignment ORKESTR_CONNECTORS_MCP_URL "http://127.0.0.1:18914/mcp"
  set_env_assignment ORKESTR_CONNECTORS_MCP_TOKEN "$mcp_token"
  set_env_assignment WHATSAPP_BRIDGE_MODE "external"
  set_env_assignment ORKESTR_WHATSAPP_EXTERNAL_BRIDGE_ENABLED "1"
  set_env_assignment WHATSAPP_BRIDGE_URL "http://127.0.0.1:18914"
  set_env_assignment WHATSAPP_BRIDGE_TOKEN "$mcp_token"
  cat > "/etc/systemd/system/${gateway_service}.service" <<EOF
[Unit]
Description=Orkestr connector MCP gateway
Documentation=https://github.com/otcan/orkestr
After=network-online.target ${worker_service}@sender.service
Wants=network-online.target ${worker_service}@sender.service

[Service]
Type=simple
User=$run_user
Group=$group_name
WorkingDirectory=$repo_dir
EnvironmentFile=-$env_file
EnvironmentFile=-$connectors_env
ExecStart=$node_bin scripts/orkestr-connectors-mcp.mjs
Restart=on-failure
RestartSec=5
TimeoutStopSec=$timeout_stop_sec
KillMode=mixed
PrivateTmp=true
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF
  cat > "/etc/systemd/system/${worker_service}@.service" <<EOF
[Unit]
Description=Orkestr WhatsApp worker (%i)
Documentation=https://github.com/otcan/orkestr
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$run_user
Group=$group_name
WorkingDirectory=$repo_dir
EnvironmentFile=-$connectors_env
Environment=ORKESTR_WA_WORKER_SOCKET=/run/orkestr-wa/%i.sock
Environment=ORKESTR_WHATSAPP_AUTOSTART_ACCOUNT_IDS=%i
Environment=ORKESTR_WHATSAPP_ACCOUNT_IDS=%i
ExecStart=$node_bin scripts/orkestr-wa-worker.mjs
Restart=on-failure
RestartSec=5
TimeoutStopSec=$timeout_stop_sec
KillMode=mixed
RuntimeDirectory=orkestr-wa
RuntimeDirectoryMode=0750
PrivateTmp=true
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF
  cat > "/etc/systemd/system/${gateway_service}-doctor.service" <<EOF
[Unit]
Description=Orkestr connector health and bounded repair
After=${gateway_service}.service ${worker_service}@sender.service

[Service]
Type=oneshot
User=root
WorkingDirectory=$repo_dir
EnvironmentFile=-$env_file
EnvironmentFile=-$connectors_env
Environment=ORKESTR_CONNECTORS_MCP_SYSTEMD_SERVICE=$gateway_service
Environment=ORKESTR_WA_WORKER_SYSTEMD_SERVICE=${worker_service}@sender
ExecStart=$node_bin scripts/orkestr-connectors-doctor.mjs --repair
EOF
  cat > "/etc/systemd/system/${gateway_service}-doctor.timer" <<EOF
[Unit]
Description=Check Orkestr connector services every minute

[Timer]
OnBootSec=60s
OnUnitActiveSec=60s
Unit=${gateway_service}-doctor.service

[Install]
WantedBy=timers.target
EOF
  systemctl daemon-reload
  systemctl enable "${worker_service}@sender.service" "${gateway_service}.service" "${gateway_service}-doctor.timer"
  systemctl restart "${worker_service}@sender.service"
  systemctl restart "${gateway_service}.service"
  systemctl restart "${gateway_service}-doctor.timer"
}

write_systemd_personal_connectors_services() {
  local gateway_service worker_service group_name personal_env personal_home node_bin mcp_token worker_token event_token
  gateway_service="$(personal_connectors_mcp_service_name)"
  worker_service="$(personal_wa_worker_service_name)"
  group_name="$(id -gn "$run_user")"
  personal_env="${ORKESTR_PERSONAL_CONNECTORS_ENV_FILE:-/etc/orkestr/orkestr-connectors-personal.env}"
  personal_home="${ORKESTR_PERSONAL_CONNECTORS_HOME:-$data_dir/personal-connectors}"
  node_bin="$(command -v node || echo /usr/bin/node)"
  mkdir -p "$personal_home" "$(dirname "$personal_env")"
  chown -R "$run_user:$group_name" "$personal_home"
  if [ ! -f "$personal_env" ]; then
    cat > "$personal_env" <<EOF
# Isolated personal connector deployment. Do not reuse main Orkestr tokens or state paths here.
ORKESTR_HOME=$personal_home
ORKESTR_CONNECTORS_MCP_HOST=127.0.0.1
ORKESTR_CONNECTORS_MCP_PORT=${ORKESTR_PERSONAL_CONNECTORS_MCP_PORT:-18749}
ORKESTR_WA_WORKER_SOCKET=/run/orkestr-wa-personal/personal-49.sock
ORKESTR_WA_WORKER_EVENT_SINK_URL=http://127.0.0.1:${ORKESTR_PERSONAL_CONNECTORS_MCP_PORT:-18749}/internal/whatsapp/inbound
ORKESTR_WHATSAPP_AUTOSTART=1
ORKESTR_WHATSAPP_AUTOSTART_ACCOUNT_IDS=personal-49
ORKESTR_WHATSAPP_ACCOUNT_IDS=personal-49
ORKESTR_CONNECTORS_REQUIRED_WA_ACCOUNTS=personal-49
# ORKESTR_CONNECTORS_MCP_TOKENS_JSON=
# ORKESTR_WA_SERVICE_POLICY_JSON=
EOF
    chmod 0600 "$personal_env"
    chgrp "$group_name" "$personal_env" || true
  fi
  mcp_token="$(named_env_file_value "$personal_env" ORKESTR_CONNECTORS_MCP_TOKEN)"
  worker_token="$(named_env_file_value "$personal_env" ORKESTR_WA_WORKER_TOKEN)"
  event_token="$(named_env_file_value "$personal_env" ORKESTR_WA_WORKER_EVENT_TOKEN)"
  [ -n "$mcp_token" ] || mcp_token="$(random_private_token)"
  [ -n "$worker_token" ] || worker_token="$(random_private_token)"
  [ -n "$event_token" ] || event_token="$(random_private_token)"
  set_named_env_assignment "$personal_env" ORKESTR_CONNECTORS_MCP_TOKEN "$mcp_token"
  set_named_env_assignment "$personal_env" ORKESTR_WA_SERVICE_TOKEN "$mcp_token"
  set_named_env_assignment "$personal_env" ORKESTR_WA_WORKER_TOKEN "$worker_token"
  set_named_env_assignment "$personal_env" ORKESTR_WA_WORKER_EVENT_TOKEN "$event_token"
  cat > "/etc/systemd/system/${worker_service}.service" <<EOF
[Unit]
Description=Orkestr isolated personal +49 WhatsApp worker
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$run_user
Group=$group_name
WorkingDirectory=$repo_dir
EnvironmentFile=-$personal_env
ExecStart=$node_bin scripts/orkestr-wa-worker.mjs
Restart=on-failure
RestartSec=5
KillMode=mixed
RuntimeDirectory=orkestr-wa-personal
RuntimeDirectoryMode=0750
PrivateTmp=true
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF
  cat > "/etc/systemd/system/${gateway_service}.service" <<EOF
[Unit]
Description=Orkestr isolated personal connector MCP gateway
After=network-online.target ${worker_service}.service
Wants=network-online.target ${worker_service}.service

[Service]
Type=simple
User=$run_user
Group=$group_name
WorkingDirectory=$repo_dir
EnvironmentFile=-$personal_env
ExecStart=$node_bin scripts/orkestr-connectors-mcp.mjs
Restart=on-failure
RestartSec=5
KillMode=mixed
PrivateTmp=true
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable "${worker_service}.service" "${gateway_service}.service"
  systemctl restart "${worker_service}.service"
  systemctl restart "${gateway_service}.service"
}

register_codex_connectors_mcp() {
  local codex_command codex_home mcp_url bearer_env
  codex_command="${ORKESTR_CODEX_BIN:-$(codex_bin_default)}"
  codex_home="${CODEX_HOME:-$data_dir/codex}"
  mcp_url="${ORKESTR_CONNECTORS_MCP_URL:-$(env_file_value ORKESTR_CONNECTORS_MCP_URL)}"
  [ -n "$mcp_url" ] || return 0
  bearer_env="${ORKESTR_CONNECTORS_MCP_BEARER_ENV_VAR:-ORKESTR_CONNECTORS_MCP_TOKEN}"
  if [ -n "${ORKESTR_CONNECTORS_MCP_BEARER_TOKEN:-$(env_file_value ORKESTR_CONNECTORS_MCP_BEARER_TOKEN)}" ]; then
    bearer_env="ORKESTR_CONNECTORS_MCP_BEARER_TOKEN"
  fi
  [ -x "$codex_command" ] || command -v "$codex_command" >/dev/null 2>&1 || return 0
  runuser -u "$run_user" -- env CODEX_HOME="$codex_home" "$codex_command" mcp remove orkestr_connectors >/dev/null 2>&1 || true
  runuser -u "$run_user" -- env CODEX_HOME="$codex_home" "$codex_command" mcp add orkestr_connectors \
    --url "$mcp_url" \
    --bearer-token-env-var "$bearer_env" >/dev/null
}

run_initial_release_deploy() {
  if [ "${ORKESTR_RELEASE_DEPLOY:-$release_update}" != "1" ]; then
    return 0
  fi
  local deploy_args
  deploy_args=(install --ref "${ORKESTR_UPDATE_REF:-$update_ref}" --channel "${ORKESTR_DEPLOY_CHANNEL:-$deploy_channel}")
  case "${ORKESTR_DEPLOY_TAGS_ONLY:-$deploy_tags_only}" in
    1) deploy_args+=(--require-tagged-releases) ;;
    0) deploy_args+=(--allow-untagged-releases) ;;
  esac
  echo "Activating initial versioned Orkestr release."
  /usr/local/bin/orkestr-deploy "${deploy_args[@]}"
}

bootstrap_tenant_vm_profile() {
  local profile bootstrap_cmd
  profile="${ORKESTR_TENANT_BOOTSTRAP_PROFILE:-$(env_file_value ORKESTR_TENANT_BOOTSTRAP_PROFILE)}"
  if [ -z "$profile" ]; then
    return 0
  fi
  if [ ! -r "$profile" ]; then
    echo "Warning: tenant bootstrap profile is not readable: $profile" >&2
    return 0
  fi
  echo "Bootstrapping tenant VM first thread from $profile"
  bootstrap_cmd="set -a; [ -r $(shell_quote "$env_file") ] && . $(shell_quote "$env_file"); set +a; cd $(shell_quote "$repo_dir"); node scripts/bootstrap-tenant-vm.mjs"
  if [ "$(id -u)" -eq 0 ] && id "$run_user" >/dev/null 2>&1; then
    if ! runuser -u "$run_user" --preserve-environment -- bash -lc "$bootstrap_cmd"; then
      echo "Warning: tenant VM bootstrap did not complete. Check journalctl -u ${ORKESTR_SERVICE_NAME:-orkestr} and rerun scripts/bootstrap-tenant-vm.mjs." >&2
    fi
    return 0
  fi
  if ! bash -lc "$bootstrap_cmd"; then
    echo "Warning: tenant VM bootstrap did not complete. Rerun scripts/bootstrap-tenant-vm.mjs after fixing runtime auth." >&2
  fi
}

write_update_units() {
  local service_name interval
  service_name="${ORKESTR_UPDATE_SERVICE_NAME:-orkestr-update}"
  interval="${ORKESTR_UPDATE_INTERVAL_SECONDS:-$update_interval_seconds}"
  cat > "/etc/systemd/system/${service_name}.service" <<EOF
[Unit]
Description=Orkestr host-native update watcher
Documentation=https://github.com/otcan/orkestr
Wants=network-online.target
After=network-online.target

[Service]
Type=oneshot
EnvironmentFile=-$env_file
ExecStart=/usr/local/bin/orkestr-update
EOF

  cat > "/etc/systemd/system/${service_name}.timer" <<EOF
[Unit]
Description=Run the Orkestr update watcher

[Timer]
OnBootSec=2min
OnUnitActiveSec=${interval}s
AccuracySec=15s
Persistent=true

[Install]
WantedBy=timers.target
EOF

  systemctl daemon-reload
  systemctl enable --now "${service_name}.timer"
}

install_systemd_runtime() {
  local run_group codex_home
  if ! run_as_root; then
    echo "--systemd requires root. Use: curl -fsSL https://raw.githubusercontent.com/otcan/orkestr/main/scripts/install.sh | sudo bash -s -- --systemd" >&2
    exit 1
  fi
  if ! id "$run_user" >/dev/null 2>&1; then
    useradd --system --home "$data_dir" --shell /bin/bash "$run_user"
  else
    usermod --shell /bin/bash "$run_user"
  fi
  run_group="$(id -gn "$run_user")"
  codex_home="${CODEX_HOME:-$data_dir/codex}"
  if ! codex_command_supports_external_app_server "${ORKESTR_CODEX_BIN:-$(codex_bin_default)}"; then
    cat >&2 <<EOF
Codex CLI does not support the durable external app-server runtime.

It must run:
  codex app-server proxy --help

Update Codex or set ORKESTR_CODEX_BIN to a newer Codex CLI before installing.
EOF
    exit 1
  fi
  mkdir -p "$data_dir" "$data_dir/run" "$workspace_dir"
  chown -R "$run_user:$run_group" "$data_dir" "$workspace_dir"
  ensure_overlay_file
  mkdir -p "$codex_home"
  chown -R "$run_user:$run_group" "$codex_home"
  chmod 0700 "$codex_home"
  write_env_file
  write_runtime_settings_file
  chown "$run_user:$run_group" "${ORKESTR_RUNTIME_SETTINGS_FILE:-$data_dir/runtime-settings.json}" || true
  chgrp "$run_group" "$env_file" || true
  write_cli_wrapper
  write_update_wrapper
  write_deploy_wrapper
  write_reset_wrapper
  write_browserctl_wrapper
  prepare_default_desktop_profiles
  write_codex_app_server_wrapper
  write_systemd_codex_app_server_service
  case "$(normalize_bool "${ORKESTR_INSTALL_CONNECTORS_MCP:-${ORKESTR_INSTALL_WA_SERVICE:-0}}")" in
    1) write_systemd_connectors_services ;;
    *)
      case "$(normalize_bool "${ORKESTR_INSTALL_WA_SERVICE:-0}")" in
        1) write_systemd_wa_service ;;
      esac
      ;;
  esac
  case "$(normalize_bool "${ORKESTR_INSTALL_PERSONAL_CONNECTORS_MCP:-0}")" in
    1) write_systemd_personal_connectors_services ;;
  esac
  write_systemd_service
  register_codex_connectors_mcp
  run_initial_release_deploy
  bootstrap_tenant_vm_profile
  if [ "${ORKESTR_AUTO_UPDATE:-$auto_update}" = "1" ]; then
    write_update_units
  fi
}

if [ "$local_mode" -eq 0 ] && [ "$systemd" -ne 1 ] && [ "${ORKESTR_INSTALL_REEXECED:-0}" != "1" ] && in_orkestr_checkout; then
  local_mode=1
fi

apply_install_defaults

advanced_install="$(normalize_bool "$advanced_install")"
if [ "$advanced_install" != "0" ] && [ "$advanced_install" != "1" ]; then
  echo "Invalid ORKESTR_INSTALL_ADVANCED value: $advanced_install" >&2
  echo "Use 1/0, yes/no, true/false, or on/off." >&2
  exit 2
fi

if [ "$install_json_config_loaded" -eq 0 ] && [ "${ORKESTR_NONINTERACTIVE:-0}" != "1" ] && [ "$systemd" -ne 1 ] && is_interactive_terminal; then
  run_install_wizard
fi

if is_macos && [ "$systemd" -ne 1 ] && [ "${ORKESTR_ALLOW_MACOS_ADMIN:-0}" != "1" ]; then
  enable_macos_local_admin_guard
fi

start_after_install="$(normalize_bool "$start_after_install")"
if [ "$start_after_install" != "0" ] && [ "$start_after_install" != "1" ]; then
  echo "Invalid ORKESTR_START_AFTER_INSTALL value: $start_after_install" >&2
  echo "Use 1/0, yes/no, true/false, or on/off." >&2
  exit 2
fi
local_service="$(normalize_bool "$local_service")"
if [ "$local_service" != "0" ] && [ "$local_service" != "1" ]; then
  echo "Invalid ORKESTR_INSTALL_LOCAL_SERVICE value: $local_service" >&2
  echo "Use 1/0, yes/no, true/false, or on/off." >&2
  exit 2
fi
if [ "$foreground_serve" -eq 1 ]; then
  echo "Warning: --serve is a development shortcut. Normal installs use the local service." >&2
fi
fresh_install="$(normalize_bool "$fresh_install")"
if [ "$fresh_install" != "0" ] && [ "$fresh_install" != "1" ]; then
  echo "Invalid ORKESTR_FRESH_INSTALL value: $fresh_install" >&2
  echo "Use 1/0, yes/no, true/false, or on/off." >&2
  exit 2
fi
if [ "$fresh_install" = "1" ]; then
  fresh_reset_local_install
fi

install_system_packages
ensure_node
need npm
if [ "$systemd" -ne 1 ]; then
  install_local_runtime_tools
fi
install_codex
install_local_codex_cli
export ORKESTR_CODEX_BIN="${ORKESTR_CODEX_BIN:-$(codex_bin_default)}"
export ORKESTR_RUNTIME_CODEX_COMMAND="${ORKESTR_RUNTIME_CODEX_COMMAND:-$(codex_command_default)}"

repo_dir="$install_dir"
if [ "$local_mode" -eq 1 ]; then
  repo_dir="$(pwd)"
else
  need git
  repo_url="${ORKESTR_REPO_URL:-https://github.com/otcan/orkestr.git}"
  git_ref="${ORKESTR_GIT_REF:-}"
  if [ -d "$repo_dir/.git" ]; then
    git -C "$repo_dir" remote set-url origin "$repo_url"
    if [ -n "$git_ref" ]; then
      git -C "$repo_dir" fetch --prune origin
      checkout_git_ref
    else
      git -C "$repo_dir" pull --ff-only
    fi
  else
    mkdir -p "$(dirname "$repo_dir")"
    if [ -n "$git_ref" ]; then
      git clone --no-checkout "$repo_url" "$repo_dir"
      checkout_git_ref
    else
      git clone "$repo_url" "$repo_dir"
    fi
  fi
fi

cd "$repo_dir"

bash scripts/install-runtime-deps.sh
npm run build:runtime
npm prune --omit=dev

if [ "$systemd" -eq 1 ]; then
  install_systemd_runtime
  cat <<EOF

Orkestr host-native service installed.

Service:
  systemctl status ${ORKESTR_SERVICE_NAME:-orkestr}
  $([ "$(normalize_bool "${ORKESTR_INSTALL_WA_SERVICE:-0}")" = "1" ] && echo "systemctl status $(wa_service_name)" || true)
  $([ "$(normalize_bool "${ORKESTR_INSTALL_CONNECTORS_MCP:-${ORKESTR_INSTALL_WA_SERVICE:-0}}")" = "1" ] && echo "systemctl status $(connectors_mcp_service_name) $(wa_worker_service_name)@sender" || true)
  journalctl -u ${ORKESTR_SERVICE_NAME:-orkestr} -f
  $([ "$(normalize_bool "${ORKESTR_INSTALL_WA_SERVICE:-0}")" = "1" ] && echo "journalctl -u $(wa_service_name) -f" || true)
  journalctl -u ${ORKESTR_UPDATE_SERVICE_NAME:-orkestr-update} -f

CLI:
  orkestr --help
  orkestr security approve <challenge-id>
  orkestr-update
  orkestr-deploy status

Config:
  $env_file

Open locally or through your reverse proxy:
  http://$host:$port/setup

EOF
  exit 0
fi

export ORKESTR_HOST="$host"
export ORKESTR_PORT="$port"
export ORKESTR_HOME="${ORKESTR_HOME:-$data_dir}"
export ORKESTR_RUNTIME_SETTINGS_FILE="${ORKESTR_RUNTIME_SETTINGS_FILE:-$data_dir/runtime-settings.json}"
mkdir -p "$data_dir" "$workspace_dir"
if [ "$local_service" = "1" ]; then
  export ORKESTR_LOCAL_SERVICE_MANAGER="$(effective_local_service_manager)"
else
  export ORKESTR_LOCAL_SERVICE_MANAGER="${ORKESTR_LOCAL_SERVICE_MANAGER:-}"
fi
write_local_env_file
write_runtime_settings_file
write_local_server_wrapper
write_local_cli_wrapper
if [ "$local_service" = "1" ]; then
  install_local_service "$ORKESTR_LOCAL_SERVICE_MANAGER"
fi

cat <<EOF

Orkestr installed.

Open:
  http://$ORKESTR_HOST:$ORKESTR_PORT/setup

Runtime settings:
  $ORKESTR_RUNTIME_SETTINGS_FILE

Local env:
  $local_env_file

CLI:
  $(local_cli_bin) --help
  $(local_cli_bin) service status
  $(local_cli_bin) service start
  $(local_cli_bin) service stop
  $(local_cli_bin) service logs

EOF

if [ "$local_service" = "1" ]; then
  cat <<EOF
Local service:
  manager: $ORKESTR_LOCAL_SERVICE_MANAGER
  file: $(local_service_file "$ORKESTR_LOCAL_SERVICE_MANAGER")
  started: $start_after_install

EOF
else
  cat <<EOF
Manual start:
  cd $repo_dir
  set -a; . "$local_env_file"; set +a; npm start

EOF
fi

if is_macos; then
  cat <<EOF

VPS service installs are for Linux hosts. Do not use sudo or --systemd for this
local Mac install.

EOF
else
  cat <<EOF

For a VPS service install, rerun as root:
  sudo scripts/install.sh --systemd

EOF
fi

if [ "$foreground_serve" -eq 1 ]; then
  set -a
  # shellcheck disable=SC1090
  . "$local_env_file"
  set +a
  npm start
fi
