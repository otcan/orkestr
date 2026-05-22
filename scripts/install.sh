#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Install Orkestr.

Usage:
  scripts/install.sh [--local] [--serve]
  scripts/install.sh --systemd [--auto-update] [--install-dir DIR] [--data-dir DIR] [--workspace-dir DIR] [--env-file FILE] [--user USER]

Modes:
  default       Clone/update the repo, install dependencies, build, and print a start command.
  --local       Use the current checkout instead of cloning.
  --systemd     Install a host-native VPS service. Requires root.
  --auto-update Install a host-local update watcher timer in --systemd mode.
  --serve       Start npm after a non-systemd install.

Environment:
  ORKESTR_REPO_URL          Git repository to clone. Defaults to https://github.com/otcan/orkestr.git.
  ORKESTR_GIT_REF           Git branch, tag, or commit to deploy. Defaults to the repository default branch.
  ORKESTR_INSTALL_DIR       Install directory. Defaults to ~/.orkestr-src/orkestr-oss, or /opt/orkestr/app with --systemd.
  ORKESTR_HOME              Data directory. Defaults to /opt/orkestr/data with --systemd.
  ORKESTR_WORKSPACE_DIR     Workspace root. Defaults to /opt/orkestr/workspace with --systemd.
  ORKESTR_ENV_FILE          Environment file. Defaults to /etc/orkestr/orkestr.env with --systemd.
  ORKESTR_RUN_USER          Service user. Defaults to orkestr with --systemd.
  ORKESTR_HOST              Bind host. Defaults to 127.0.0.1.
  ORKESTR_PORT              Bind port. Defaults to 19812.
  ORKESTR_AUTO_UPDATE       Install and enable the update watcher. Defaults to 0.
  ORKESTR_UPDATE_REF        Git branch, tag, or commit watched by the updater. Defaults to main.
  ORKESTR_UPDATE_INTERVAL_SECONDS  Update check interval. Defaults to 120.
  ORKESTR_RELEASE_DEPLOY    Use versioned release directories for updates. Defaults to 0.
  ORKESTR_DEPLOY_CHANNEL    Deployment channel label. Defaults to production for release deploys.
  ORKESTR_DEPLOY_ROOT       Versioned release root. Defaults to /opt/orkestr.
  ORKESTR_CURRENT_LINK      Active release symlink. Defaults to /opt/orkestr/current.
  ORKESTR_RESET_ON_UPDATE   Reset runtime state after successful updates. Defaults to 0.
  ORKESTR_RESET_OVERLAY     Also reset ORKESTR_OVERLAY_DIR when reset is enabled. Defaults to 0.
  ORKESTR_INSTALL_CODEX     Install Codex CLI globally in --systemd mode. Defaults to 1.
  ORKESTR_CODEX_VERSION     Codex CLI version. Defaults to 0.130.0.
  ORKESTR_SKIP_SYSTEM_PACKAGES  Skip apt package installation when set to 1.
USAGE
}

local_mode=0
serve=0
systemd=0
install_dir="${ORKESTR_INSTALL_DIR:-}"
data_dir="${ORKESTR_HOME:-}"
workspace_dir="${ORKESTR_WORKSPACE_DIR:-}"
env_file="${ORKESTR_ENV_FILE:-}"
run_user="${ORKESTR_RUN_USER:-orkestr}"
host="${ORKESTR_HOST:-127.0.0.1}"
port="${ORKESTR_PORT:-19812}"
auto_update="${ORKESTR_AUTO_UPDATE:-0}"
update_interval_seconds="${ORKESTR_UPDATE_INTERVAL_SECONDS:-120}"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --local)
      local_mode=1
      shift
      ;;
    --serve)
      serve=1
      shift
      ;;
    --systemd|--vps)
      systemd=1
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
    --skip-system-packages)
      ORKESTR_SKIP_SYSTEM_PACKAGES=1
      shift
      ;;
    --skip-codex)
      ORKESTR_INSTALL_CODEX=0
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

need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

have() {
  command -v "$1" >/dev/null 2>&1
}

run_as_root() {
  [ "$(id -u)" -eq 0 ]
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
  if have codex; then
    return 0
  fi
  npm install -g "@openai/codex@${ORKESTR_CODEX_VERSION:-0.130.0}"
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
  cat > "$env_file" <<EOF
# Orkestr host-native environment.
# Edit this file for OpenAI keys, OAuth credentials, Caddy/Tailscale URLs, and private overlay paths.
ORKESTR_APP_DIR=$repo_dir
ORKESTR_HOME=$data_dir
ORKESTR_RUN_USER=$run_user
ORKESTR_HOST=$host
ORKESTR_PORT=$port
ORKESTR_AUTH_REQUIRED=${ORKESTR_AUTH_REQUIRED:-1}
ORKESTR_COOKIE_SECURE=${ORKESTR_COOKIE_SECURE:-0}
ORKESTR_PUBLIC_HTTPS_URL=${ORKESTR_PUBLIC_HTTPS_URL:-}
ORKESTR_TAILSCALE_HTTPS_NAME=${ORKESTR_TAILSCALE_HTTPS_NAME:-}
ORKESTR_CADDY_ENABLED=${ORKESTR_CADDY_ENABLED:-0}
ORKESTR_AUTO_UPDATE=${ORKESTR_AUTO_UPDATE:-$auto_update}
ORKESTR_UPDATE_REF=${ORKESTR_UPDATE_REF:-main}
ORKESTR_UPDATE_INTERVAL_SECONDS=${ORKESTR_UPDATE_INTERVAL_SECONDS:-$update_interval_seconds}
ORKESTR_RELEASE_DEPLOY=${ORKESTR_RELEASE_DEPLOY:-0}
ORKESTR_DEPLOY_CHANNEL=${ORKESTR_DEPLOY_CHANNEL:-production}
ORKESTR_DEPLOY_ROOT=${ORKESTR_DEPLOY_ROOT:-/opt/orkestr}
ORKESTR_CURRENT_LINK=${ORKESTR_CURRENT_LINK:-/opt/orkestr/current}
ORKESTR_RESET_ON_UPDATE=${ORKESTR_RESET_ON_UPDATE:-0}
ORKESTR_RESET_OVERLAY=${ORKESTR_RESET_OVERLAY:-0}
ORKESTR_RUNTIME_WORKSPACE_ROOT=$workspace_dir
ORKESTR_CODEX_BIN=${ORKESTR_CODEX_BIN:-codex}
ORKESTR_RUNTIME_CODEX_COMMAND="${ORKESTR_RUNTIME_CODEX_COMMAND:-codex --dangerously-bypass-approvals-and-sandbox}"
ORKESTR_RUNTIME_SUBMIT_KEYS=${ORKESTR_RUNTIME_SUBMIT_KEYS:-C-m}
ORKESTR_RUNTIME_SUBMIT_DELAY_MS=${ORKESTR_RUNTIME_SUBMIT_DELAY_MS:-250}
ORKESTR_WAKE_READY_TIMEOUT_MS=${ORKESTR_WAKE_READY_TIMEOUT_MS:-60000}
CODEX_HOME=${CODEX_HOME:-$data_dir/codex}
PUPPETEER_EXECUTABLE_PATH=${PUPPETEER_EXECUTABLE_PATH:-$chrome}
WA_CHROME_PATH=${WA_CHROME_PATH:-$chrome}
ORKESTR_CHROME_PATH=${ORKESTR_CHROME_PATH:-$chrome}
ORKESTR_OVERLAY_DIR=${ORKESTR_OVERLAY_DIR:-/opt/orkestr/overlay}
WHATSAPP_BRIDGE_MODE=${WHATSAPP_BRIDGE_MODE:-local}
OPENAI_API_KEY=
OPENAI_BASE_URL=
OPENAI_MODEL=
GMAIL_OAUTH_CLIENT_ID=
GMAIL_OAUTH_CLIENT_SECRET=
GMAIL_OAUTH_REDIRECT_URI=
EOF
  chmod 0640 "$env_file"
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

if [ "$systemd" -eq 1 ]; then
  install_dir="${install_dir:-/opt/orkestr/app}"
  data_dir="${data_dir:-/opt/orkestr/data}"
  workspace_dir="${workspace_dir:-/opt/orkestr/workspace}"
  env_file="${env_file:-/etc/orkestr/orkestr.env}"
else
  install_dir="${install_dir:-$HOME/.orkestr-src/orkestr-oss}"
fi

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

cat <<EOF

Orkestr installed.

Start:
  cd $repo_dir
  ORKESTR_HOST=$ORKESTR_HOST ORKESTR_PORT=$ORKESTR_PORT npm start

Open:
  http://$ORKESTR_HOST:$ORKESTR_PORT/setup

For a VPS service install, rerun as root:
  sudo scripts/install.sh --systemd

EOF

if [ "$serve" -eq 1 ]; then
  npm start
fi
