#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Install Orkestr.

Usage:
  scripts/install.sh [--local] [--no-start] [--no-service] [--serve] [--profile local-safe|local-trusted] [--enable-host-codex]
  scripts/install.sh --systemd [--auto-update] [--track-main|--release-updates] [--install-dir DIR] [--data-dir DIR] [--workspace-dir DIR] [--env-file FILE] [--user USER]

Modes:
  default       Use the current checkout when run from one, install dependencies, build, install a local service, and start Orkestr.
  --systemd     Install a host-native VPS service. Requires root.
  --auto-update Install a host-local update watcher timer in --systemd mode.
  --track-main  Track origin/main with versioned releases. Implies --auto-update, --release-updates, --update-ref main, --channel main, and --allow-untagged-releases.
  --release-updates Use versioned release directories for updater deploys.

Unattended installs:
  Create ./orkestr.install.env or ./.orkestr.install.env before running this script.
  The file is sourced by Bash, so use KEY=value lines with shell quoting when needed.

Deprecated compatibility flags:
  --local       Force using the current checkout.
  --serve       Dev shortcut: skip local service installation and run npm in the foreground.
  --no-serve    Alias for --no-start.
  --profile     Legacy alias for choosing Codex safety defaults. Prefer explicit ORKESTR_CODEX_* settings.
  --enable-host-codex  Allow a local macOS install to probe/use a verified host codex binary.

Environment:
  ORKESTR_INSTALL_MODE      local or service. service is equivalent to --systemd.
  ORKESTR_INSTALL_LOCAL_SERVICE Install a local user service for non-systemd installs. Defaults to 1 locally.
  ORKESTR_START_AFTER_INSTALL  Start the installed service after install. Defaults to 1 locally.
  ORKESTR_LOCAL_SERVICE_NAME  Local Linux service name. Defaults to orkestr.
  ORKESTR_LOCAL_SERVICE_LABEL Local macOS launchd label. Defaults to com.orkestr.oss.
  ORKESTR_LOCAL_BIN_DIR      Local CLI wrapper directory. Defaults to ~/.local/bin.
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
  ORKESTR_ENABLE_HOST_CODEX Allow local macOS installs to probe/use the host codex binary. Defaults to 0 on macOS.
  ORKESTR_CODEX_VERSION     Codex CLI version. Defaults to 0.133.0.
  ORKESTR_LOCAL_ENV_FILE    Local env file written for non-systemd installs. Defaults to $ORKESTR_HOME/orkestr.env.
  ORKESTR_SKIP_SYSTEM_PACKAGES  Skip apt package installation when set to 1.
USAGE
}

initial_arg_count=$#
install_config_loaded=0
install_config_file="${ORKESTR_INSTALL_CONFIG:-}"
if [ -z "$install_config_file" ]; then
  for candidate in ./orkestr.install.env ./.orkestr.install.env; do
    if [ -f "$candidate" ]; then
      install_config_file="$candidate"
      break
    fi
  done
fi
if [ -n "$install_config_file" ]; then
  if [ ! -r "$install_config_file" ]; then
    echo "Cannot read Orkestr install config: $install_config_file" >&2
    exit 1
  fi
  set -a
  # shellcheck disable=SC1090
  . "$install_config_file"
  set +a
  install_config_loaded=1
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
  if should_disable_macos_runtime_codex; then
    echo "__orkestr_codex_disabled_on_macos__"
    return 0
  fi
  local codex_bin
  codex_bin="${ORKESTR_CODEX_BIN:-codex}"
  if profile_is_trusted "$install_profile"; then
    echo "$codex_bin --dangerously-bypass-approvals-and-sandbox"
  else
    echo "$codex_bin --sandbox workspace-write --ask-for-approval on-request --no-alt-screen"
  fi
}

codex_bin_default() {
  if should_disable_macos_codex_bin; then
    echo "__orkestr_codex_disabled_on_macos__"
  else
    echo "codex"
  fi
}

should_disable_macos_codex_bin() {
  is_macos \
    && [ "$systemd" -ne 1 ] \
    && [ "${ORKESTR_ENABLE_HOST_CODEX:-0}" != "1" ] \
    && [ -z "${ORKESTR_CODEX_BIN:-}" ]
}

should_disable_macos_runtime_codex() {
  is_macos \
    && [ "$systemd" -ne 1 ] \
    && [ "${ORKESTR_ENABLE_HOST_CODEX:-0}" != "1" ] \
    && [ -z "${ORKESTR_CODEX_BIN:-}" ] \
    && [ -z "${ORKESTR_RUNTIME_CODEX_COMMAND:-}" ]
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
  local keep_approvals install_service start_after default_workspace
  echo "Orkestr installer"
  echo "Press Enter to accept the suggested value."
  prompt_default host "Bind host" "$host"
  prompt_default port "Bind port" "$port"
  default_workspace="$workspace_dir"
  prompt_default data_dir "Data directory" "$data_dir"
  if [ "$workspace_dir" = "$default_workspace" ] && [ "$systemd" -ne 1 ]; then
    workspace_dir="$data_dir/workspaces"
  fi
  prompt_default workspace_dir "Workspace directory" "$workspace_dir"
  prompt_yes_no keep_approvals "Keep Codex approval prompts enabled" "1"
  if [ "$keep_approvals" = "1" ]; then
    ORKESTR_CODEX_SANDBOX="${ORKESTR_CODEX_SANDBOX:-workspace-write}"
    ORKESTR_CODEX_APPROVAL_POLICY="${ORKESTR_CODEX_APPROVAL_POLICY:-on-request}"
    ORKESTR_RUNTIME_CODEX_COMMAND="${ORKESTR_RUNTIME_CODEX_COMMAND:-codex --sandbox workspace-write --ask-for-approval on-request --no-alt-screen}"
  else
    ORKESTR_CODEX_SANDBOX="${ORKESTR_CODEX_SANDBOX:-danger-full-access}"
    ORKESTR_CODEX_APPROVAL_POLICY="${ORKESTR_CODEX_APPROVAL_POLICY:-never}"
    ORKESTR_RUNTIME_CODEX_COMMAND="${ORKESTR_RUNTIME_CODEX_COMMAND:-codex --dangerously-bypass-approvals-and-sandbox}"
  fi
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

install_system_packages() {
  if [ "$systemd" -ne 1 ] || [ "${ORKESTR_SKIP_SYSTEM_PACKAGES:-0}" = "1" ]; then
    return 0
  fi
  apt_install ca-certificates curl git openssh-client procps ripgrep sqlite3 tmux util-linux
  install_browser_package
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
  if is_macos && [ "${ORKESTR_ENABLE_HOST_CODEX:-0}" != "1" ]; then
    echo "Refusing to install Codex automatically on macOS. Verify Codex manually, then rerun with ORKESTR_ENABLE_HOST_CODEX=1." >&2
    exit 1
  fi
  if have codex; then
    return 0
  fi
  npm install -g "@openai/codex@${ORKESTR_CODEX_VERSION:-0.133.0}"
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
  if [ -f "$env_file" ]; then
    echo "Keeping existing environment file: $env_file"
    return 0
  fi
  mkdir -p "$(dirname "$env_file")"
  local chrome
  chrome="$(chrome_path)"
  local codex_command codex_sandbox codex_approval runtime_settings_file
  codex_command="${ORKESTR_RUNTIME_CODEX_COMMAND:-$(codex_command_default)}"
  codex_sandbox="${ORKESTR_CODEX_SANDBOX:-$(codex_sandbox_default)}"
  codex_approval="${ORKESTR_CODEX_APPROVAL_POLICY:-$(codex_approval_default)}"
  runtime_settings_file="${ORKESTR_RUNTIME_SETTINGS_FILE:-$data_dir/runtime-settings.json}"
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
ORKESTR_PUBLIC_HTTPS_URL=${ORKESTR_PUBLIC_HTTPS_URL:-}
ORKESTR_TAILSCALE_HTTPS_NAME=${ORKESTR_TAILSCALE_HTTPS_NAME:-}
ORKESTR_CADDY_ENABLED=${ORKESTR_CADDY_ENABLED:-0}
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
ORKESTR_CODEX_BIN=${ORKESTR_CODEX_BIN:-$(codex_bin_default)}
ORKESTR_CODEX_SANDBOX=$codex_sandbox
ORKESTR_CODEX_APPROVAL_POLICY=$codex_approval
ORKESTR_RUNTIME_CODEX_COMMAND="$codex_command"
ORKESTR_RUNTIME_SUBMIT_KEYS=${ORKESTR_RUNTIME_SUBMIT_KEYS:-C-m}
ORKESTR_RUNTIME_SUBMIT_DELAY_MS=${ORKESTR_RUNTIME_SUBMIT_DELAY_MS:-250}
ORKESTR_WAKE_READY_TIMEOUT_MS=${ORKESTR_WAKE_READY_TIMEOUT_MS:-60000}
CODEX_HOME=${CODEX_HOME:-$data_dir/codex}
PUPPETEER_EXECUTABLE_PATH=${PUPPETEER_EXECUTABLE_PATH:-$chrome}
WA_CHROME_PATH=${WA_CHROME_PATH:-$chrome}
ORKESTR_CHROME_PATH=${ORKESTR_CHROME_PATH:-$chrome}
ORKESTR_BROWSER_DESKTOP_MODE=${ORKESTR_BROWSER_DESKTOP_MODE:-profiles}
ORKESTR_DEFAULT_DESKTOP_SLUG=${ORKESTR_DEFAULT_DESKTOP_SLUG:-desktop}
ORKESTR_GMAIL_AUTH_DESKTOP_SLUG=${ORKESTR_GMAIL_AUTH_DESKTOP_SLUG:-gmail}
ORKESTR_MANUAL_INTERVENTION_DESKTOP_SLUG=${ORKESTR_MANUAL_INTERVENTION_DESKTOP_SLUG:-desktop}
ORKESTR_OVERLAY_DIR=${ORKESTR_OVERLAY_DIR:-/opt/orkestr/overlay}
WHATSAPP_BRIDGE_MODE=${WHATSAPP_BRIDGE_MODE:-local}
ORKESTR_WHATSAPP_SENDER_ROLE=${ORKESTR_WHATSAPP_SENDER_ROLE:-sender}
ORKESTR_WHATSAPP_RESPONDER_ROLE=${ORKESTR_WHATSAPP_RESPONDER_ROLE:-responder}
ORKESTR_WHATSAPP_EXTERNAL_BRIDGE_ENABLED=${ORKESTR_WHATSAPP_EXTERNAL_BRIDGE_ENABLED:-0}
WHATSAPP_BRIDGE_URL=${WHATSAPP_BRIDGE_URL:-}
OPENAI_API_KEY=
OPENAI_BASE_URL=
OPENAI_MODEL=
GMAIL_OAUTH_CLIENT_ID=
GMAIL_OAUTH_CLIENT_SECRET=
GMAIL_OAUTH_REDIRECT_URI=
EOF
  chmod 0640 "$env_file"
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

local_server_wrapper() {
  echo "${ORKESTR_LOCAL_SERVER_WRAPPER:-$data_dir/bin/orkestr-server}"
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
    echo "launchd"
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
    if [ -f "$pid_file" ] && kill -0 "$(cat "$pid_file")" >/dev/null 2>&1; then
      return 0
    fi
    nohup "$wrapper" >> "$out_log" 2>> "$err_log" &
    echo "$!" > "$pid_file"
  fi
}

install_local_service() {
  local manager
  manager="$1"
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

write_local_env_file() {
  mkdir -p "$(dirname "$local_env_file")"
  {
    echo "# Orkestr local environment."
    echo "# Source this file before running Orkestr manually from the checkout."
    write_env_var ORKESTR_APP_DIR "$repo_dir"
    write_env_var ORKESTR_HOME "$data_dir"
    write_env_var ORKESTR_HOST "$host"
    write_env_var ORKESTR_PORT "$port"
    write_env_var ORKESTR_INSTALL_PROFILE "$install_profile"
    write_env_var ORKESTR_INSTALL_LOCAL_SERVICE "$local_service"
    write_env_var ORKESTR_START_AFTER_INSTALL "$start_after_install"
    write_env_var ORKESTR_RUNTIME_SETTINGS_FILE "${ORKESTR_RUNTIME_SETTINGS_FILE:-$data_dir/runtime-settings.json}"
    write_env_var ORKESTR_RUNTIME_WORKSPACE_ROOT "$workspace_dir"
    write_env_var ORKESTR_CODEX_BIN "${ORKESTR_CODEX_BIN:-$(codex_bin_default)}"
    write_env_var ORKESTR_RUNTIME_CODEX_COMMAND "${ORKESTR_RUNTIME_CODEX_COMMAND:-$(codex_command_default)}"
    write_env_var CODEX_HOME "${CODEX_HOME:-$data_dir/codex}"
    write_env_var ORKESTR_LOCAL_SERVICE_MANAGER "${ORKESTR_LOCAL_SERVICE_MANAGER:-}"
    write_env_var ORKESTR_LOCAL_SERVICE_NAME "$(local_service_name)"
    write_env_var ORKESTR_LOCAL_SERVICE_LABEL "$(local_service_label)"
    write_env_var ORKESTR_LOCAL_SERVICE_FILE "${ORKESTR_LOCAL_SERVICE_FILE:-$(local_service_file "${ORKESTR_LOCAL_SERVICE_MANAGER:-}")}"
    write_env_var ORKESTR_LOCAL_SERVER_WRAPPER "$(local_server_wrapper)"
    write_env_var ORKESTR_LOCAL_LOG_DIR "$(local_log_dir)"
    write_env_var ORKESTR_LOCAL_PID_FILE "$(local_pid_file)"
    write_env_var ORKESTR_LOCAL_CLI_BIN "$(local_cli_bin)"
  } > "$local_env_file"
  chmod 0600 "$local_env_file"
}

write_runtime_settings_file() {
  local runtime_settings_file codex_command codex_sandbox codex_approval desktop_mode default_desktop gmail_desktop manual_desktop wa_sender wa_responder wa_mode gmail_enabled outlook_enabled
  runtime_settings_file="${ORKESTR_RUNTIME_SETTINGS_FILE:-$data_dir/runtime-settings.json}"
  codex_command="${ORKESTR_RUNTIME_CODEX_COMMAND:-$(codex_command_default)}"
  codex_sandbox="${ORKESTR_CODEX_SANDBOX:-$(codex_sandbox_default)}"
  codex_approval="${ORKESTR_CODEX_APPROVAL_POLICY:-$(codex_approval_default)}"
  desktop_mode="${ORKESTR_BROWSER_DESKTOP_MODE:-profiles}"
  default_desktop="${ORKESTR_DEFAULT_DESKTOP_SLUG:-desktop}"
  gmail_desktop="${ORKESTR_GMAIL_AUTH_DESKTOP_SLUG:-gmail}"
  manual_desktop="${ORKESTR_MANUAL_INTERVENTION_DESKTOP_SLUG:-desktop}"
  wa_sender="${ORKESTR_WHATSAPP_SENDER_ROLE:-sender}"
  wa_responder="${ORKESTR_WHATSAPP_RESPONDER_ROLE:-responder}"
  wa_mode="${WHATSAPP_BRIDGE_MODE:-local}"
  gmail_enabled="${ORKESTR_GMAIL_ENABLED:-0}"
  outlook_enabled="${ORKESTR_OUTLOOK_ENABLED:-0}"
  if [ -n "${GMAIL_OAUTH_CLIENT_ID:-}" ]; then
    gmail_enabled=1
  fi
  if [ -n "${OUTLOOK_OAUTH_CLIENT_ID:-${MICROSOFT_OAUTH_CLIENT_ID:-}}" ]; then
    outlook_enabled=1
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
    "enabled": true,
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

write_systemd_service() {
  local service_name group_name
  service_name="${ORKESTR_SERVICE_NAME:-orkestr}"
  group_name="$(id -gn "$run_user")"
  cat > "/etc/systemd/system/${service_name}.service" <<EOF
[Unit]
Description=Orkestr host-native service
Documentation=https://github.com/otcan/orkestr
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$run_user
Group=$group_name
WorkingDirectory=$repo_dir
EnvironmentFile=-$env_file
ExecStart=/usr/local/bin/orkestr serve
Restart=on-failure
RestartSec=5
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable "${service_name}.service"
  systemctl restart "${service_name}.service"
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
  if ! run_as_root; then
    echo "--systemd requires root. Use: curl -fsSL https://raw.githubusercontent.com/otcan/orkestr/main/scripts/install.sh | sudo bash -s -- --systemd" >&2
    exit 1
  fi
  if ! id "$run_user" >/dev/null 2>&1; then
    useradd --system --home "$data_dir" --shell /bin/bash "$run_user"
  else
    usermod --shell /bin/bash "$run_user"
  fi
  mkdir -p "$data_dir" "$workspace_dir" /opt/orkestr/overlay
  chown -R "$run_user:$(id -gn "$run_user")" "$data_dir" "$workspace_dir" /opt/orkestr/overlay
  write_env_file
  write_runtime_settings_file
  chown "$run_user:$(id -gn "$run_user")" "${ORKESTR_RUNTIME_SETTINGS_FILE:-$data_dir/runtime-settings.json}" || true
  chgrp "$(id -gn "$run_user")" "$env_file" || true
  write_cli_wrapper
  write_update_wrapper
  write_deploy_wrapper
  write_reset_wrapper
  write_systemd_service
  if [ "${ORKESTR_AUTO_UPDATE:-$auto_update}" = "1" ]; then
    write_update_units
  fi
}

if [ "$local_mode" -eq 0 ] && [ "$systemd" -ne 1 ] && in_orkestr_checkout; then
  local_mode=1
fi

apply_install_defaults

if [ "$install_config_loaded" -eq 0 ] && [ "$initial_arg_count" -eq 0 ]; then
  if is_interactive_terminal; then
    run_install_wizard
  else
    cat >&2 <<'EOF'
Orkestr install needs either an interactive terminal or an unattended config file.

For a normal local setup, run this from a terminal:
  ./scripts/install.sh

For unattended setup, create ./orkestr.install.env first. Start from:
  cp orkestr.install.env.example orkestr.install.env
EOF
    exit 1
  fi
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

print_macos_codex_notice
export ORKESTR_RUNTIME_CODEX_COMMAND="${ORKESTR_RUNTIME_CODEX_COMMAND:-$(codex_command_default)}"
export ORKESTR_CODEX_BIN="${ORKESTR_CODEX_BIN:-$(codex_bin_default)}"
install_system_packages
ensure_node
need npm
if [ "$systemd" -ne 1 ]; then
  need git
fi
install_codex

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

if [ -f package-lock.json ]; then
  npm ci --include=dev
else
  npm install --include=dev
fi

npm run build

if [ "$systemd" -eq 1 ]; then
  npm prune --omit=dev
  install_systemd_runtime
  cat <<EOF

Orkestr host-native service installed.

Service:
  systemctl status ${ORKESTR_SERVICE_NAME:-orkestr}
  journalctl -u ${ORKESTR_SERVICE_NAME:-orkestr} -f
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
  export ORKESTR_LOCAL_SERVICE_MANAGER="${ORKESTR_LOCAL_SERVICE_MANAGER:-$(local_service_manager)}"
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

cat <<EOF

For a VPS service install, rerun as root:
  sudo scripts/install.sh --systemd

EOF

if [ "$foreground_serve" -eq 1 ]; then
  set -a
  # shellcheck disable=SC1090
  . "$local_env_file"
  set +a
  npm start
fi
