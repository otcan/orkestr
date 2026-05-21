#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Bootstrap a fresh VPS for Orkestr.

Recommended image:
  Ubuntu 24.04 LTS Server x64

Usage:
  scripts/bootstrap-vps.sh [options]
  curl -fsSL https://raw.githubusercontent.com/otcan/orkestr/main/scripts/bootstrap-vps.sh | sudo bash

Options:
  --repo URL                 Git repository to install. Defaults to https://github.com/otcan/orkestr.git.
  --ref REF                  Branch, tag, or commit. Defaults to main.
  --port PORT                Local Orkestr port. Defaults to 19812.
  --host HOST                Local bind host. Defaults to 127.0.0.1.
  --no-auto-update           Do not install the on-box update timer.
  --demo                     Disposable demo mode: reset Orkestr runtime state after successful updates.
  --with-whatsapp            Prefer the local WhatsApp bridge mode in /etc/orkestr/orkestr.env.
  --tailscale                Install Tailscale and configure serve when connected. Default.
  --no-tailscale             Skip Tailscale install and serve setup.
  --tailscale-up             Run tailscale up if the node is not connected. Use TS_AUTHKEY for unattended setup.
  --tailscale-hostname NAME  Hostname to pass to tailscale up. Defaults to orkestr.
  --tailscale-https-port N   Tailscale HTTPS port. Defaults to 443.
  --domain DOMAIN            Configure Caddy public HTTPS for this domain.
  --force                    Continue on non-recommended Ubuntu versions.
  --help                     Show this help.

Environment:
  TS_AUTHKEY                 Optional Tailscale auth key. Prefer setting it interactively, not in shell history.
  ORKESTR_INSTALL_SCRIPT_URL Override the installer URL used by this bootstrap script.
USAGE
}

repo_url="${ORKESTR_REPO_URL:-https://github.com/otcan/orkestr.git}"
git_ref="${ORKESTR_GIT_REF:-main}"
host="${ORKESTR_HOST:-127.0.0.1}"
port="${ORKESTR_PORT:-19812}"
auto_update=1
demo=0
with_whatsapp=0
tailscale=1
tailscale_up=0
tailscale_hostname="${ORKESTR_TAILSCALE_HOSTNAME:-orkestr}"
tailscale_https_port="${ORKESTR_TAILSCALE_HTTPS_PORT:-443}"
domain="${ORKESTR_DOMAIN:-}"
force=0
env_file="${ORKESTR_ENV_FILE:-/etc/orkestr/orkestr.env}"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --repo)
      repo_url="${2:-}"
      shift 2
      ;;
    --ref)
      git_ref="${2:-}"
      shift 2
      ;;
    --port)
      port="${2:-}"
      shift 2
      ;;
    --host)
      host="${2:-}"
      shift 2
      ;;
    --no-auto-update)
      auto_update=0
      shift
      ;;
    --demo)
      demo=1
      shift
      ;;
    --with-whatsapp)
      with_whatsapp=1
      shift
      ;;
    --tailscale)
      tailscale=1
      shift
      ;;
    --no-tailscale)
      tailscale=0
      shift
      ;;
    --tailscale-up)
      tailscale=1
      tailscale_up=1
      shift
      ;;
    --tailscale-hostname)
      tailscale_hostname="${2:-}"
      shift 2
      ;;
    --tailscale-https-port)
      tailscale_https_port="${2:-}"
      shift 2
      ;;
    --domain)
      domain="${2:-}"
      shift 2
      ;;
    --force)
      force=1
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

log() {
  printf '[orkestr-bootstrap] %s\n' "$*"
}

warn() {
  printf '[orkestr-bootstrap] warning: %s\n' "$*" >&2
}

die() {
  printf '[orkestr-bootstrap] error: %s\n' "$*" >&2
  exit 1
}

have() {
  command -v "$1" >/dev/null 2>&1
}

require_root() {
  if [ "$(id -u)" -ne 0 ]; then
    die "Run as root. Use: curl -fsSL https://raw.githubusercontent.com/otcan/orkestr/main/scripts/bootstrap-vps.sh | sudo bash"
  fi
}

apt_install() {
  export DEBIAN_FRONTEND=noninteractive
  apt-get install -y --no-install-recommends "$@"
}

ensure_base_packages() {
  have apt-get || die "This bootstrap script expects an apt-based Ubuntu Server host. Use Ubuntu 24.04 LTS Server x64."
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt_install ca-certificates curl gnupg lsb-release procps
}

check_os() {
  local id version pretty
  if [ ! -r /etc/os-release ]; then
    [ "$force" -eq 1 ] && return 0
    die "Cannot read /etc/os-release. Use Ubuntu 24.04 LTS Server x64, or pass --force."
  fi
  # shellcheck disable=SC1091
  . /etc/os-release
  id="${ID:-}"
  version="${VERSION_ID:-}"
  pretty="${PRETTY_NAME:-unknown Linux}"
  if [ "$id" != "ubuntu" ]; then
    [ "$force" -eq 1 ] || die "Unsupported OS: $pretty. Recommended: Ubuntu 24.04 LTS Server x64."
    warn "Continuing on unsupported OS because --force was supplied: $pretty"
    return 0
  fi
  case "$version" in
    24.04)
      log "OS check passed: $pretty"
      ;;
    26.04)
      warn "Ubuntu 26.04 LTS is accepted, but Ubuntu 24.04 LTS is still the recommended Orkestr VPS image."
      ;;
    *)
      [ "$force" -eq 1 ] || die "Unsupported Ubuntu version: $pretty. Recommended: Ubuntu 24.04 LTS Server x64."
      warn "Continuing on non-recommended Ubuntu version because --force was supplied: $pretty"
      ;;
  esac
}

check_resources() {
  local mem_mb disk_mb arch
  arch="$(uname -m)"
  case "$arch" in
    x86_64|aarch64|arm64)
      ;;
    *)
      warn "Untested CPU architecture: $arch. x86_64 is recommended for the easiest VPS path."
      ;;
  esac
  mem_mb="$(awk '/MemTotal/ { printf "%d", $2 / 1024 }' /proc/meminfo 2>/dev/null || echo 0)"
  disk_mb="$(df -Pm / | awk 'NR == 2 { print $4 }' 2>/dev/null || echo 0)"
  if [ "${mem_mb:-0}" -lt 3500 ]; then
    warn "Detected ${mem_mb:-0} MB RAM. Orkestr works best with at least 4 GB; 8 GB is better for browsers."
  fi
  if [ "${disk_mb:-0}" -lt 30000 ]; then
    warn "Detected ${disk_mb:-0} MB free disk on /. Use at least 60 GB for browser profiles and workspaces."
  fi
}

install_tailscale() {
  [ "$tailscale" -eq 1 ] || return 0
  if ! have tailscale; then
    log "Installing Tailscale"
    curl -fsSL https://tailscale.com/install.sh | sh
  fi
}

tailscale_connected() {
  have tailscale || return 1
  tailscale status >/dev/null 2>&1
}

bring_up_tailscale_if_requested() {
  [ "$tailscale" -eq 1 ] || return 0
  tailscale_connected && return 0
  if [ -n "${TS_AUTHKEY:-}" ]; then
    log "Connecting Tailscale with TS_AUTHKEY"
    tailscale up --auth-key "$TS_AUTHKEY" --ssh --hostname "$tailscale_hostname"
    return 0
  fi
  if [ "$tailscale_up" -eq 1 ]; then
    log "Starting interactive Tailscale login"
    tailscale up --ssh --hostname "$tailscale_hostname"
    return 0
  fi
  warn "Tailscale is installed but not connected. Run: sudo tailscale up --ssh --hostname $tailscale_hostname"
}

set_env_value() {
  local key value file tmp
  key="$1"
  value="$2"
  file="$3"
  mkdir -p "$(dirname "$file")"
  touch "$file"
  tmp="$(mktemp)"
  awk -v key="$key" -v value="$value" '
    BEGIN { done = 0 }
    $0 ~ "^" key "=" {
      print key "=" value
      done = 1
      next
    }
    { print }
    END {
      if (!done) print key "=" value
    }
  ' "$file" > "$tmp"
  cat "$tmp" > "$file"
  rm -f "$tmp"
}

run_install_script() {
  local install_args installer_url script_dir local_install
  install_args=(--systemd --host "$host" --port "$port")
  if [ "$auto_update" -eq 1 ]; then
    install_args+=(--auto-update)
  else
    install_args+=(--no-auto-update)
  fi

  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
  local_install="$script_dir/install.sh"
  export ORKESTR_REPO_URL="$repo_url"
  export ORKESTR_GIT_REF="$git_ref"
  export ORKESTR_HOST="$host"
  export ORKESTR_PORT="$port"
  export ORKESTR_AUTO_UPDATE="$auto_update"
  if [ "$demo" -eq 1 ]; then
    export ORKESTR_RESET_ON_UPDATE=1
    export ORKESTR_RESET_OVERLAY=1
  fi

  if [ -x "$local_install" ]; then
    log "Running local installer: $local_install"
    bash "$local_install" "${install_args[@]}"
    return 0
  fi

  installer_url="${ORKESTR_INSTALL_SCRIPT_URL:-https://raw.githubusercontent.com/otcan/orkestr/${git_ref}/scripts/install.sh}"
  log "Running installer from $installer_url"
  curl -fsSL "$installer_url" | bash -s -- "${install_args[@]}"
}

configure_runtime_env() {
  if [ "$demo" -eq 1 ]; then
    set_env_value ORKESTR_RESET_ON_UPDATE 1 "$env_file"
    set_env_value ORKESTR_RESET_OVERLAY 1 "$env_file"
  fi
  if [ "$with_whatsapp" -eq 1 ]; then
    set_env_value WHATSAPP_BRIDGE_MODE local "$env_file"
  fi
}

configure_tailscale_serve() {
  [ "$tailscale" -eq 1 ] || return 0
  tailscale_connected || return 0
  log "Configuring Tailscale Serve for Orkestr"
  if [ "$tailscale_https_port" = "443" ]; then
    tailscale serve --bg 443 "http://127.0.0.1:$port" || {
      warn "Could not configure Tailscale Serve automatically. Run: sudo tailscale serve --bg 443 http://127.0.0.1:$port"
      return 0
    }
  else
    tailscale serve --bg --https "$tailscale_https_port" "http://127.0.0.1:$port" || {
      warn "Could not configure Tailscale Serve automatically. Run: sudo tailscale serve --bg --https $tailscale_https_port http://127.0.0.1:$port"
      return 0
    }
  fi
  set_env_value ORKESTR_COOKIE_SECURE 1 "$env_file"
  if [ -n "${ORKESTR_PUBLIC_HTTPS_URL:-}" ]; then
    set_env_value ORKESTR_PUBLIC_HTTPS_URL "$ORKESTR_PUBLIC_HTTPS_URL" "$env_file"
  fi
  if [ -n "${ORKESTR_TAILSCALE_HTTPS_NAME:-}" ]; then
    set_env_value ORKESTR_TAILSCALE_HTTPS_NAME "$ORKESTR_TAILSCALE_HTTPS_NAME" "$env_file"
  fi
}

configure_caddy() {
  [ -n "$domain" ] || return 0
  log "Installing and configuring Caddy for https://$domain"
  apt_install caddy
  mkdir -p /etc/caddy/conf.d
  touch /etc/caddy/Caddyfile
  if ! grep -q '^import /etc/caddy/conf\.d/\*\.caddy$' /etc/caddy/Caddyfile; then
    printf '\nimport /etc/caddy/conf.d/*.caddy\n' >> /etc/caddy/Caddyfile
  fi
  cat > /etc/caddy/conf.d/orkestr.caddy <<EOF
$domain {
  encode zstd gzip
  reverse_proxy 127.0.0.1:$port
}
EOF
  caddy validate --config /etc/caddy/Caddyfile
  systemctl enable --now caddy
  systemctl reload caddy || systemctl restart caddy
  set_env_value ORKESTR_CADDY_ENABLED 1 "$env_file"
  set_env_value ORKESTR_COOKIE_SECURE 1 "$env_file"
  set_env_value ORKESTR_PUBLIC_HTTPS_URL "https://$domain" "$env_file"
}

restart_orkestr() {
  systemctl restart orkestr.service
}

run_doctor() {
  if have orkestr; then
    log "Running Orkestr doctor"
    orkestr doctor || true
  fi
}

print_summary() {
  local tailscale_status domain_url
  tailscale_status="not installed"
  if have tailscale; then
    if tailscale_connected; then
      tailscale_status="connected; run 'tailscale serve status' to see the HTTPS URL"
    else
      tailscale_status="installed, not connected"
    fi
  fi
  domain_url=""
  if [ -n "$domain" ]; then
    domain_url="https://$domain/setup"
  fi
  cat <<EOF

Orkestr VPS bootstrap complete.

Recommended next steps:
  1. Open setup locally through SSH tunnel if needed:
     ssh -L $port:127.0.0.1:$port root@<vps-ip>
     http://127.0.0.1:$port/setup
  2. If using Tailscale, connect the node if needed:
     sudo tailscale up --ssh --hostname $tailscale_hostname
     sudo tailscale serve --bg 443 http://127.0.0.1:$port
  3. Open /setup, approve browser pairing, connect Codex, then add WhatsApp/Gmail/browsers as needed.

Service:
  systemctl status orkestr
  journalctl -u orkestr -f

Config:
  $env_file

Access:
  Local: http://127.0.0.1:$port/setup
  Tailscale: $tailscale_status
  Domain: ${domain_url:-not configured}

EOF
}

main() {
  require_root
  check_os
  ensure_base_packages
  check_resources
  install_tailscale
  bring_up_tailscale_if_requested
  run_install_script
  configure_runtime_env
  configure_tailscale_serve
  configure_caddy
  restart_orkestr
  run_doctor
  print_summary
}

main "$@"
