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
  --track-main               Track main with versioned releases. Default for fresh VPS bootstraps.
  --in-place-updates         Use the legacy in-place checkout updater instead of versioned releases.
  --release-updates          Use versioned release directories for updater deploys.
  --channel NAME             Deployment channel label. Defaults to main for versioned main tracking.
  --demo                     Disposable demo mode: reset Orkestr runtime state after successful updates.
  --with-whatsapp            Prefer the local WhatsApp bridge mode in /etc/orkestr/orkestr.env.
  --tenant-bootstrap-profile FILE
                             Persist a public-safe tenant bootstrap profile path in Orkestr env.
  --tailscale                Install Tailscale and configure serve when connected. Default.
  --no-tailscale             Skip Tailscale install and serve setup.
  --tailscale-up             Run tailscale up if the node is not connected. Use TS_AUTHKEY for unattended setup.
  --tailscale-hostname NAME  Hostname to pass to tailscale up. Defaults to orkestr.
  --tailscale-https-port N   Tailscale HTTPS port. Defaults to 443.
  --domain DOMAIN            Configure Caddy public HTTPS for this domain.
  --public-site-url URL      Public landing/legal site URL. Defaults to https://DOMAIN.
  --app-host HOST            Public app hostname, for example app.example.com.
  --auth-host HOST           Public auth/pairing hostname, for example auth.example.com.
  --email EMAIL              ACME account email for Caddy certificate issuance.
  --mtls-ca FILE             Optional client CA certificate for Caddy mTLS.
  --mtls-mode MODE           Caddy client auth mode. Defaults to require_and_verify.
  --force                    Continue on non-recommended Ubuntu versions.
  --help                     Show this help.

Environment:
  TS_AUTHKEY                 Optional Tailscale auth key. Prefer setting it interactively, not in shell history.
  ORKESTR_ACME_EMAIL         Optional ACME account email used by Caddy.
  ORKESTR_TENANT_BOOTSTRAP_PROFILE
                             Optional public-safe tenant bootstrap profile JSON path.
  ORKESTR_INSTALL_SCRIPT_URL Override the installer URL used by this bootstrap script.
USAGE
}

repo_url="${ORKESTR_REPO_URL:-https://github.com/otcan/orkestr.git}"
git_ref="${ORKESTR_GIT_REF:-main}"
host="${ORKESTR_HOST:-127.0.0.1}"
port="${ORKESTR_PORT:-19812}"
auto_update=1
release_update="${ORKESTR_RELEASE_DEPLOY:-1}"
deploy_channel="${ORKESTR_DEPLOY_CHANNEL:-main}"
deploy_tags_only="${ORKESTR_DEPLOY_TAGS_ONLY:-0}"
track_main=0
demo=0
with_whatsapp=0
tenant_bootstrap_profile="${ORKESTR_TENANT_BOOTSTRAP_PROFILE:-}"
tailscale=1
tailscale_up=0
tailscale_hostname="${ORKESTR_TAILSCALE_HOSTNAME:-orkestr}"
tailscale_https_port="${ORKESTR_TAILSCALE_HTTPS_PORT:-443}"
primary_domain="${ORKESTR_PRIMARY_DOMAIN:-${ORKESTR_DOMAIN:-}}"
domain="${ORKESTR_DOMAIN:-$primary_domain}"
public_site_url="${ORKESTR_PUBLIC_SITE_URL:-}"
app_host="${ORKESTR_APP_HOST:-}"
auth_host="${ORKESTR_AUTH_HOST:-}"
public_url="${ORKESTR_PUBLIC_URL:-}"
auth_url="${ORKESTR_AUTH_URL:-}"
cookie_domain="${ORKESTR_COOKIE_DOMAIN:-}"
acme_email="${ORKESTR_ACME_EMAIL:-}"
mtls_ca="${ORKESTR_MTLS_CA_CERT:-}"
mtls_mode="${ORKESTR_MTLS_MODE:-require_and_verify}"
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
    --track-main)
      track_main=1
      auto_update=1
      release_update=1
      git_ref=main
      deploy_channel=main
      deploy_tags_only=0
      shift
      ;;
    --release-updates|--versioned-updates)
      release_update=1
      shift
      ;;
    --in-place-updates)
      release_update=0
      shift
      ;;
    --channel)
      deploy_channel="${2:-}"
      shift 2
      ;;
    --allow-untagged-releases)
      deploy_tags_only=0
      shift
      ;;
    --require-tagged-releases)
      deploy_tags_only=1
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
    --tenant-bootstrap-profile)
      tenant_bootstrap_profile="${2:-}"
      shift 2
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
      primary_domain="${2:-}"
      shift 2
      ;;
    --public-site-url)
      public_site_url="${2:-}"
      shift 2
      ;;
    --app-host)
      app_host="${2:-}"
      shift 2
      ;;
    --auth-host)
      auth_host="${2:-}"
      shift 2
      ;;
    --email|--acme-email)
      acme_email="${2:-}"
      shift 2
      ;;
    --mtls-ca|--client-ca)
      mtls_ca="${2:-}"
      shift 2
      ;;
    --mtls-mode)
      mtls_mode="${2:-}"
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

if [ "$track_main" -eq 1 ]; then
  auto_update=1
  release_update=1
  git_ref=main
  deploy_channel=main
  deploy_tags_only=0
fi

if [ -n "$domain" ] && { [ -n "$app_host" ] || [ -n "$auth_host" ]; }; then
  app_host="${app_host:-app.$domain}"
  auth_host="${auth_host:-auth.$domain}"
  public_site_url="${public_site_url:-https://$domain}"
  public_url="${public_url:-https://$app_host}"
  auth_url="${auth_url:-https://$auth_host}"
  cookie_domain="${cookie_domain:-$domain}"
fi
if [ -z "$public_site_url" ] && [ -n "$primary_domain" ]; then
  public_site_url="https://$primary_domain"
fi

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
  if [ "$release_update" -eq 1 ]; then
    install_args+=(--release-updates --update-ref "$git_ref" --channel "$deploy_channel")
    if [ -n "$deploy_tags_only" ]; then
      if [ "$deploy_tags_only" = "1" ]; then
        install_args+=(--require-tagged-releases)
      else
        install_args+=(--allow-untagged-releases)
      fi
    fi
  else
    install_args+=(--in-place-updates --update-ref "$git_ref")
  fi

  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
  local_install="$script_dir/install.sh"
  export ORKESTR_REPO_URL="$repo_url"
  export ORKESTR_GIT_REF="$git_ref"
  export ORKESTR_HOST="$host"
  export ORKESTR_PORT="$port"
  export ORKESTR_AUTO_UPDATE="$auto_update"
  export ORKESTR_UPDATE_REF="$git_ref"
  export ORKESTR_RELEASE_DEPLOY="$release_update"
  export ORKESTR_DEPLOY_CHANNEL="$deploy_channel"
  export ORKESTR_DEPLOY_TAGS_ONLY="$deploy_tags_only"
  export ORKESTR_PUBLIC_SITE_URL="$public_site_url"
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
  set_env_value ORKESTR_WHATSAPP_EXTERNAL_BRIDGE_ENABLED 0 "$env_file"
  if [ -n "$primary_domain" ]; then
    set_env_value ORKESTR_PRIMARY_DOMAIN "$primary_domain" "$env_file"
  fi
  if [ -n "$public_site_url" ]; then
    set_env_value ORKESTR_PUBLIC_SITE_URL "$public_site_url" "$env_file"
  fi
  if [ -n "$app_host" ]; then
    set_env_value ORKESTR_APP_HOST "$app_host" "$env_file"
  fi
  if [ -n "$auth_host" ]; then
    set_env_value ORKESTR_AUTH_HOST "$auth_host" "$env_file"
  fi
  if [ -n "$public_url" ]; then
    set_env_value ORKESTR_PUBLIC_URL "$public_url" "$env_file"
    set_env_value ORKESTR_PUBLIC_HTTPS_URL "$public_url" "$env_file"
  fi
  if [ -n "$auth_url" ]; then
    set_env_value ORKESTR_AUTH_URL "$auth_url" "$env_file"
  fi
  if [ -n "$cookie_domain" ]; then
    set_env_value ORKESTR_COOKIE_DOMAIN "$cookie_domain" "$env_file"
  fi
  if [ "$demo" -eq 1 ]; then
    set_env_value ORKESTR_RESET_ON_UPDATE 1 "$env_file"
    set_env_value ORKESTR_RESET_OVERLAY 1 "$env_file"
  fi
  if [ "$with_whatsapp" -eq 1 ]; then
    set_env_value WHATSAPP_BRIDGE_MODE local "$env_file"
  fi
  if [ -n "$tenant_bootstrap_profile" ]; then
    if [ ! -r "$tenant_bootstrap_profile" ]; then
      warn "Tenant bootstrap profile is not readable yet: $tenant_bootstrap_profile"
    fi
    set_env_value ORKESTR_TENANT_BOOTSTRAP_PROFILE "$tenant_bootstrap_profile" "$env_file"
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
  local proxy_hosts redirect_block
  proxy_hosts="$domain"
  redirect_block=""
  if [ -n "$app_host" ] || [ -n "$auth_host" ]; then
    proxy_hosts="$app_host"
    if [ -n "$auth_host" ] && [ "$auth_host" != "$app_host" ]; then
      proxy_hosts="$proxy_hosts, $auth_host"
    fi
    if [ -n "$app_host" ] && [ "$domain" != "$app_host" ] && [ "$domain" != "$auth_host" ]; then
      redirect_block="$domain {
  redir https://$app_host{uri} permanent
}

"
    fi
  fi
  log "Installing and configuring Caddy for $proxy_hosts"
  apt_install caddy
  mkdir -p /etc/caddy/conf.d
  if [ -n "$mtls_ca" ]; then
    [ -r "$mtls_ca" ] || die "--mtls-ca file is not readable: $mtls_ca"
    case "$mtls_mode" in
      require_and_verify|verify_if_given)
        ;;
      *)
        die "--mtls-mode must be one of: require_and_verify, verify_if_given"
        ;;
    esac
  fi
  if [ ! -s /etc/caddy/Caddyfile ] || grep -q 'root \* /usr/share/caddy' /etc/caddy/Caddyfile; then
    if [ -n "$acme_email" ]; then
      cat > /etc/caddy/Caddyfile <<EOF
{
  email $acme_email
}

import /etc/caddy/conf.d/*.caddy
EOF
    else
      cat > /etc/caddy/Caddyfile <<'EOF'
import /etc/caddy/conf.d/*.caddy
EOF
    fi
  elif ! grep -q '^import /etc/caddy/conf\.d/\*\.caddy$' /etc/caddy/Caddyfile; then
    printf '\nimport /etc/caddy/conf.d/*.caddy\n' >> /etc/caddy/Caddyfile
  fi
  if [ -n "$app_host" ] || [ -n "$auth_host" ]; then
    if [ -n "$mtls_ca" ]; then
      cat > /etc/caddy/conf.d/orkestr.caddy <<EOF
${redirect_block}
$proxy_hosts {
  encode zstd gzip
  tls {
    client_auth {
      mode $mtls_mode
      trusted_ca_cert_file $mtls_ca
    }
  }
  reverse_proxy 127.0.0.1:$port
}
EOF
    else
      cat > /etc/caddy/conf.d/orkestr.caddy <<EOF
${redirect_block}
$proxy_hosts {
  encode zstd gzip
  reverse_proxy 127.0.0.1:$port
}
EOF
    fi
  elif [ -n "$mtls_ca" ]; then
    cat > /etc/caddy/conf.d/orkestr.caddy <<EOF
$domain {
  encode zstd gzip
  tls {
    client_auth {
      mode $mtls_mode
      trusted_ca_cert_file $mtls_ca
    }
  }
  reverse_proxy 127.0.0.1:$port
}
EOF
  else
    cat > /etc/caddy/conf.d/orkestr.caddy <<EOF
$domain {
  encode zstd gzip
  reverse_proxy 127.0.0.1:$port
}
EOF
  fi
  caddy validate --config /etc/caddy/Caddyfile
  systemctl enable --now caddy
  systemctl reload caddy || systemctl restart caddy
  set_env_value ORKESTR_CADDY_ENABLED 1 "$env_file"
  set_env_value ORKESTR_COOKIE_SECURE 1 "$env_file"
  if [ -n "$public_url" ]; then
    set_env_value ORKESTR_PUBLIC_URL "$public_url" "$env_file"
    set_env_value ORKESTR_PUBLIC_HTTPS_URL "$public_url" "$env_file"
  else
    set_env_value ORKESTR_PUBLIC_HTTPS_URL "https://$domain" "$env_file"
  fi
  if [ -n "$public_site_url" ]; then
    set_env_value ORKESTR_PUBLIC_SITE_URL "$public_site_url" "$env_file"
  fi
  if [ -n "$auth_url" ]; then
    set_env_value ORKESTR_AUTH_URL "$auth_url" "$env_file"
  fi
  if [ -n "$cookie_domain" ]; then
    set_env_value ORKESTR_COOKIE_DOMAIN "$cookie_domain" "$env_file"
  fi
  if [ -n "$mtls_ca" ]; then
    set_env_value ORKESTR_MTLS_ENABLED 1 "$env_file"
    set_env_value ORKESTR_MTLS_CA_CERT "$mtls_ca" "$env_file"
    set_env_value ORKESTR_MTLS_MODE "$mtls_mode" "$env_file"
  else
    set_env_value ORKESTR_MTLS_ENABLED 0 "$env_file"
    set_env_value ORKESTR_MTLS_CA_CERT "" "$env_file"
    set_env_value ORKESTR_MTLS_MODE "$mtls_mode" "$env_file"
  fi
  if [ -n "$acme_email" ]; then
    set_env_value ORKESTR_ACME_EMAIL "$acme_email" "$env_file"
  fi
}

restart_orkestr() {
  systemctl restart orkestr.service
  wait_for_orkestr_http
}

wait_for_orkestr_http() {
  local check_host url
  check_host="$host"
  if [ "$check_host" = "0.0.0.0" ] || [ "$check_host" = "::" ]; then
    check_host="127.0.0.1"
  fi
  url="http://$check_host:$port/api/version"
  log "Waiting for Orkestr HTTP endpoint: $url"
  for _ in $(seq 1 60); do
    if curl -fsS "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  systemctl status orkestr.service --no-pager --lines=80 || true
  die "Orkestr service did not become ready at $url"
}

run_doctor() {
  if have orkestr; then
    log "Running Orkestr doctor"
    local output status
    set +e
    output="$(orkestr doctor 2>&1)"
    status="$?"
    set -e
    if [ "$status" -eq 0 ]; then
      printf '%s\n' "$output"
      return 0
    fi
    if printf '%s\n' "$output" | grep -q 'browser_pairing_required'; then
      warn "Orkestr doctor is deferred until browser pairing is approved. Open /setup, create a pairing challenge, approve it with 'orkestr security approve <challenge-id>', then rerun 'orkestr doctor'."
      return 0
    fi
    printf '%s\n' "$output" >&2
    return 0
  fi
}

print_summary() {
  local tailscale_status domain_url auth_summary mtls_status
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
    domain_url="${public_url:-https://$domain}/setup"
  fi
  auth_summary="${auth_url:-same as app}"
  mtls_status="disabled"
  if [ -n "$mtls_ca" ]; then
    mtls_status="enabled ($mtls_mode)"
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
  Auth: $auth_summary
  mTLS: $mtls_status

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
