#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Smoke test a public Orkestr Caddy/TLS deployment.

Usage:
  scripts/smoke-public-domain.sh --domain DOMAIN [--host PUBLIC_IP] [--ssh root@PUBLIC_IP]

Required:
  --domain DOMAIN            Public HTTPS hostname configured with bootstrap-vps.sh --domain.

Options:
  --host PUBLIC_IP           Public host IP. Defaults to the first public A record.
  --ssh TARGET               SSH target used to approve and revoke browser pairing. Defaults to root@PUBLIC_IP.
  --port PORT                Raw Orkestr port that must not be publicly reachable. Defaults to 19812.
  --protected-path PATH      Protected API route used for auth checks. Defaults to /api/connectors/whatsapp/status.
  --keep-session             Keep the paired browser session created by this smoke.
  --skip-pair                Skip pairing-cookie checks. Not recommended for release validation.
  --skip-dns-check           Do not require public DNS to resolve DOMAIN to --host.
  --help                     Show this help.

The smoke verifies:
  - public DNS points DOMAIN at the host
  - http://DOMAIN/setup redirects to https://DOMAIN/setup
  - https://DOMAIN/setup returns 200 with a valid certificate
  - raw Orkestr port is not reachable publicly
  - protected API routes return 401 before pairing
  - browser pairing works through HTTPS after SSH approval
  - protected API routes work with the paired cookie and still reject no-cookie requests
USAGE
}

domain=""
host_ip=""
ssh_target=""
port=19812
protected_path="/api/connectors/whatsapp/status"
keep_session=0
skip_pair=0
skip_dns_check=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --domain)
      domain="${2:-}"
      shift 2
      ;;
    --host|--ip)
      host_ip="${2:-}"
      shift 2
      ;;
    --ssh)
      ssh_target="${2:-}"
      shift 2
      ;;
    --port)
      port="${2:-}"
      shift 2
      ;;
    --protected-path)
      protected_path="${2:-}"
      shift 2
      ;;
    --keep-session)
      keep_session=1
      shift
      ;;
    --skip-pair)
      skip_pair=1
      shift
      ;;
    --skip-dns-check)
      skip_dns_check=1
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
  printf '[orkestr-public-smoke] %s\n' "$*"
}

fail() {
  printf '[orkestr-public-smoke] error: %s\n' "$*" >&2
  exit 1
}

need() {
  command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"
}

json_field() {
  local expr="$1"
  node -e "const fs=require('node:fs'); const j=JSON.parse(fs.readFileSync(0,'utf8')); const v=($expr); process.stdout.write(v == null ? '' : String(v));"
}

public_a_records() {
  if command -v dig >/dev/null 2>&1; then
    dig @1.1.1.1 +short "$domain" A | sed '/^$/d'
  else
    getent ahostsv4 "$domain" | awk '{print $1}' | sed '/^$/d' | sort -u
  fi
}

expect_http_code() {
  local label="$1"
  local expected="$2"
  local actual="$3"
  [ "$actual" = "$expected" ] || fail "$label returned HTTP ${actual:-none}, expected $expected"
}

need curl
need node
need openssl

[ -n "$domain" ] || fail "--domain is required"

records="$(public_a_records || true)"
if [ -z "$host_ip" ]; then
  host_ip="$(printf '%s\n' "$records" | head -n 1)"
fi
[ -n "$host_ip" ] || fail "could not resolve $domain; pass --host PUBLIC_IP"

if [ "$skip_dns_check" -eq 0 ]; then
  printf '%s\n' "$records" | grep -Fx "$host_ip" >/dev/null || {
    printf '%s\n' "$records" >&2
    fail "public DNS for $domain does not include $host_ip"
  }
fi

if [ "$skip_pair" -eq 0 ]; then
  need ssh
  ssh_target="${ssh_target:-root@$host_ip}"
fi

base_url="https://$domain"
work_dir="$(mktemp -d /tmp/orkestr-public-smoke.XXXXXX)"
cookie_file="$work_dir/cookie.txt"
trap 'rm -rf "$work_dir"' EXIT

log "domain=$domain host=$host_ip"

log "checking HTTP to HTTPS redirect"
http_code="$(curl --resolve "$domain:80:$host_ip" -sS -o "$work_dir/http-body" -D "$work_dir/http-headers" -w '%{http_code}' "http://$domain/setup" --max-time 20 || true)"
expect_http_code "HTTP redirect" "308" "$http_code"
grep -Fi "Location: https://$domain/setup" "$work_dir/http-headers" >/dev/null || fail "HTTP redirect location did not point to HTTPS /setup"

log "checking HTTPS setup page"
https_code="$(curl --resolve "$domain:443:$host_ip" -sS -o "$work_dir/setup.html" -D "$work_dir/https-headers" -w '%{http_code}' "$base_url/setup" --max-time 30)"
expect_http_code "HTTPS setup" "200" "$https_code"
grep -Fi "server: Caddy" "$work_dir/https-headers" >/dev/null || fail "HTTPS response did not come through Caddy"

log "checking certificate"
cert_text="$(echo | openssl s_client -servername "$domain" -connect "$host_ip:443" 2>/dev/null | openssl x509 -noout -subject -issuer -dates)"
printf '%s\n' "$cert_text" | grep -F "CN = $domain" >/dev/null || fail "certificate subject does not match $domain"
printf '%s\n' "$cert_text" | grep -Ei 'issuer=.*(Let.s Encrypt|ZeroSSL|Caddy)' >/dev/null || fail "certificate issuer was not recognized"

log "checking raw Orkestr port is closed publicly"
set +e
direct_code="$(curl --resolve "$domain:$port:$host_ip" -sS -o "$work_dir/direct-port" -w '%{http_code}' "http://$domain:$port/api/health" --connect-timeout 5 --max-time 8 2>"$work_dir/direct-port.err")"
direct_status="$?"
set -e
if [ "$direct_status" -eq 0 ] && [ "$direct_code" != "000" ]; then
  fail "raw Orkestr port $port was publicly reachable with HTTP $direct_code"
fi

log "checking protected API rejects unpaired/no-cookie requests"
unauth_code="$(curl --resolve "$domain:443:$host_ip" -sS -o "$work_dir/unauth.json" -w '%{http_code}' "$base_url$protected_path" --max-time 20 || true)"
expect_http_code "protected no-cookie route" "401" "$unauth_code"
grep -F "browser_pairing_required" "$work_dir/unauth.json" >/dev/null || fail "protected no-cookie route did not report browser_pairing_required"

if [ "$skip_pair" -eq 0 ]; then
  log "creating pairing challenge"
  challenge_json="$(curl --resolve "$domain:443:$host_ip" -fsS -X POST "$base_url/api/setup/security/challenge" --max-time 20)"
  challenge_id="$(printf '%s' "$challenge_json" | json_field "j.challengeId || j.payload?.challengeId")"
  [ -n "$challenge_id" ] || fail "pairing challenge did not include a challengeId"

  log "approving pairing challenge over SSH"
  ssh -o BatchMode=yes "$ssh_target" "orkestr security approve '$challenge_id'" >/dev/null

  log "pairing browser cookie over HTTPS"
  pair_json="$(curl --resolve "$domain:443:$host_ip" -fsS -c "$cookie_file" -H 'content-type: application/json' -d "{\"challengeId\":\"$challenge_id\"}" "$base_url/api/setup/security/pair" --max-time 20)"
  session_id="$(printf '%s' "$pair_json" | json_field "j.session?.id || j.payload?.session?.id")"
  [ -n "$session_id" ] || fail "pairing response did not include a session id"

  log "checking protected API works with paired cookie"
  paired_code="$(curl --resolve "$domain:443:$host_ip" -sS -b "$cookie_file" -o "$work_dir/paired.json" -w '%{http_code}' "$base_url$protected_path" --max-time 20)"
  expect_http_code "protected paired route" "200" "$paired_code"

  log "checking no-cookie requests remain blocked after pairing"
  post_pair_unauth_code="$(curl --resolve "$domain:443:$host_ip" -sS -o "$work_dir/post-pair-unauth.json" -w '%{http_code}' "$base_url$protected_path" --max-time 20 || true)"
  expect_http_code "protected no-cookie route after pairing" "401" "$post_pair_unauth_code"

  if [ "$keep_session" -eq 0 ]; then
    log "revoking smoke browser session"
    ssh -o BatchMode=yes "$ssh_target" "orkestr security revoke '$session_id'" >/dev/null
  else
    log "keeping smoke browser session $session_id"
  fi
fi

if [ "$skip_pair" -eq 0 ]; then
  log "checking remote services"
  ssh -o BatchMode=yes "$ssh_target" 'systemctl is-active --quiet orkestr && systemctl is-active --quiet caddy'
fi

log "public domain smoke passed"
