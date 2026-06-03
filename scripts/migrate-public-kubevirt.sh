#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Migrate and operate the public app.orkestr.de Orkestr instance on a KubeVirt VM.

Usage:
  scripts/migrate-public-kubevirt.sh status [options]
  scripts/migrate-public-kubevirt.sh ensure-ssh [options]
  scripts/migrate-public-kubevirt.sh backup-host-state [options]
  scripts/migrate-public-kubevirt.sh backup-vm-state [options]
  scripts/migrate-public-kubevirt.sh copy-public-state [options]
  scripts/migrate-public-kubevirt.sh update-vm --ref REF [options]
  scripts/migrate-public-kubevirt.sh smoke [options]
  scripts/migrate-public-kubevirt.sh cutover [options]
  scripts/migrate-public-kubevirt.sh rollback [options]

Defaults match the public orkestr.de deployment on a single-node k3s/KubeVirt host.

Options:
  --kubeconfig FILE       k3s kubeconfig. Defaults to KUBECONFIG or /etc/rancher/k3s/k3s.yaml.
  --namespace NS          KubeVirt namespace. Defaults to orkestr-de.
  --vm VM                 KubeVirt VM name. Defaults to orkestr-de.
  --service SERVICE       Kubernetes Service name. Defaults to orkestr-de-app.
  --service-port PORT     Kubernetes Service port. Defaults to 19812.
  --host-home DIR         Current host public ORKESTR_HOME. Defaults to /home/openclaw/.orkestr-public.
  --vm-home DIR           Public ORKESTR_HOME inside the VM. Defaults to /opt/orkestr/data.
  --vm-api URL            Public API base inside the VM. Defaults to http://127.0.0.1:19812.
  --host-api URL          Current host public API. Defaults to http://127.0.0.1:19812.
  --ssh-user USER         VM SSH user. Defaults to orkestr.
  --ssh-key FILE          Operator SSH key. Defaults to /root/.ssh/orkestr-de-operator.
  --known-hosts FILE      virtctl SSH known_hosts file. Defaults to /root/.ssh/orkestr-de-known-hosts.
  --caddyfile FILE        Caddyfile to edit. Defaults to /etc/caddy/Caddyfile.
  --backup-dir DIR        Backup root. Defaults to /var/backups/orkestr-public-kubevirt.
  --ref REF               Git ref for update-vm.
  --channel NAME          Orkestr release channel for update-vm. Defaults to orkestr-de.
  --dry-run               Print planned Caddy cutover/rollback changes without writing them.
  --help                  Show this help.

Smoke checks:
  - VM Service /api/health and /api/version are reachable.
  - VM-local orkestr list works over authorized operator SSH.
  - VM-local orkestr attach --print works when a thread exists.
  - External unauthenticated attach remains blocked with browser_pairing_required.
  - The VM cannot read known personal host paths or host container sockets.
USAGE
}

log() {
  printf '[orkestr-public-kubevirt] %s\n' "$*"
}

die() {
  printf '[orkestr-public-kubevirt] error: %s\n' "$*" >&2
  exit 1
}

need() {
  command -v "$1" >/dev/null 2>&1 || die "Missing required command: $1"
}

action="${1:-status}"
if [ "$action" = "--help" ] || [ "$action" = "-h" ]; then
  usage
  exit 0
fi
case "$action" in
  status|ensure-ssh|backup-host-state|backup-vm-state|copy-public-state|update-vm|smoke|cutover|rollback)
    shift || true
    ;;
  *)
    usage >&2
    die "Unknown action: $action"
    ;;
esac

kubeconfig="${KUBECONFIG:-/etc/rancher/k3s/k3s.yaml}"
namespace="${ORKESTR_PUBLIC_KUBEVIRT_NAMESPACE:-orkestr-de}"
vm="${ORKESTR_PUBLIC_KUBEVIRT_VM:-orkestr-de}"
service="${ORKESTR_PUBLIC_KUBEVIRT_SERVICE:-orkestr-de-app}"
service_port="${ORKESTR_PUBLIC_KUBEVIRT_SERVICE_PORT:-19812}"
host_home="${ORKESTR_PUBLIC_HOST_HOME:-/home/openclaw/.orkestr-public}"
vm_home="${ORKESTR_PUBLIC_VM_HOME:-/opt/orkestr/data}"
vm_api="${ORKESTR_PUBLIC_VM_API:-http://127.0.0.1:19812}"
host_api="${ORKESTR_PUBLIC_HOST_API:-http://127.0.0.1:19812}"
ssh_user="${ORKESTR_PUBLIC_VM_SSH_USER:-orkestr}"
ssh_key="${ORKESTR_PUBLIC_VM_SSH_KEY:-/root/.ssh/orkestr-de-operator}"
known_hosts="${ORKESTR_PUBLIC_VM_KNOWN_HOSTS:-/root/.ssh/orkestr-de-known-hosts}"
caddyfile="${ORKESTR_PUBLIC_CADDYFILE:-/etc/caddy/Caddyfile}"
backup_dir="${ORKESTR_PUBLIC_BACKUP_DIR:-/var/backups/orkestr-public-kubevirt}"
ref="${ORKESTR_PUBLIC_DEPLOY_REF:-}"
channel="${ORKESTR_PUBLIC_DEPLOY_CHANNEL:-orkestr-de}"
dry_run=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --kubeconfig)
      kubeconfig="${2:-}"
      shift 2
      ;;
    --namespace)
      namespace="${2:-}"
      shift 2
      ;;
    --vm)
      vm="${2:-}"
      shift 2
      ;;
    --service)
      service="${2:-}"
      shift 2
      ;;
    --service-port)
      service_port="${2:-}"
      shift 2
      ;;
    --host-home)
      host_home="${2:-}"
      shift 2
      ;;
    --vm-home)
      vm_home="${2:-}"
      shift 2
      ;;
    --vm-api)
      vm_api="${2:-}"
      shift 2
      ;;
    --host-api)
      host_api="${2:-}"
      shift 2
      ;;
    --ssh-user)
      ssh_user="${2:-}"
      shift 2
      ;;
    --ssh-key)
      ssh_key="${2:-}"
      shift 2
      ;;
    --known-hosts)
      known_hosts="${2:-}"
      shift 2
      ;;
    --caddyfile)
      caddyfile="${2:-}"
      shift 2
      ;;
    --backup-dir)
      backup_dir="${2:-}"
      shift 2
      ;;
    --ref)
      ref="${2:-}"
      shift 2
      ;;
    --channel)
      channel="${2:-}"
      shift 2
      ;;
    --dry-run)
      dry_run=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      die "Unknown option: $1"
      ;;
  esac
done

[ -n "$namespace" ] || die "--namespace is required"
[ -n "$vm" ] || die "--vm is required"
[ -n "$service" ] || die "--service is required"
[ -n "$service_port" ] || die "--service-port is required"

need curl
need jq
need kubectl
need virtctl

kubectl_k3s() {
  KUBECONFIG="$kubeconfig" kubectl "$@"
}

virtctl_k3s() {
  KUBECONFIG="$kubeconfig" virtctl "$@"
}

service_ip() {
  kubectl_k3s get service -n "$namespace" "$service" -o jsonpath='{.spec.clusterIP}'
}

service_url() {
  printf 'http://%s:%s' "$(service_ip)" "$service_port"
}

vm_pod_ip() {
  kubectl_k3s get pod -n "$namespace" -l "kubevirt.io/domain=$vm" -o jsonpath='{.items[0].status.podIP}'
}

wait_vm_ready() {
  local deadline
  deadline=$((SECONDS + 240))
  while [ "$SECONDS" -le "$deadline" ]; do
    if kubectl_k3s get vmi -n "$namespace" "$vm" -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null | grep -q True; then
      return 0
    fi
    sleep 3
  done
  die "VM did not become Ready: $namespace/$vm"
}

wait_vm_ssh() {
  local deadline
  deadline=$((SECONDS + 180))
  while [ "$SECONDS" -le "$deadline" ]; do
    if vm_ssh 'true' >/dev/null 2>&1; then
      return 0
    fi
    sleep 4
  done
  die "VM SSH did not become ready: $namespace/$vm"
}

ssh_common_args() {
  printf '%s\n' \
    -i "$ssh_key" \
    -o "StrictHostKeyChecking=no" \
    -o "UserKnownHostsFile=$known_hosts" \
    -o "ConnectTimeout=8"
}

vm_ssh() {
  local args=() ip
  ip="$(vm_pod_ip)"
  [ -n "$ip" ] || die "Could not determine VM pod IP for $namespace/$vm"
  mapfile -t args < <(ssh_common_args)
  ssh "${args[@]}" "$ssh_user@$ip" "$1"
}

vm_scp_to() {
  local args=() ip
  ip="$(vm_pod_ip)"
  [ -n "$ip" ] || die "Could not determine VM pod IP for $namespace/$vm"
  mapfile -t args < <(ssh_common_args)
  scp "${args[@]}" "$1" "$ssh_user@$ip:$2"
}

vm_scp_from() {
  local args=() ip
  ip="$(vm_pod_ip)"
  [ -n "$ip" ] || die "Could not determine VM pod IP for $namespace/$vm"
  mapfile -t args < <(ssh_common_args)
  scp "${args[@]}" "$ssh_user@$ip:$1" "$2"
}

json_health() {
  curl -fsS "$1/api/health" | jq -e '.ok == true' >/dev/null
}

assert_kubevirt_service_ready() {
  local ready endpoints pod_status deadline
  deadline=$((SECONDS + 180))
  while [ "$SECONDS" -le "$deadline" ]; do
    ready="$(kubectl_k3s get vmi -n "$namespace" "$vm" -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null || true)"
    pod_status="$(kubectl_k3s get pod -n "$namespace" -l "kubevirt.io/domain=$vm" -o jsonpath='{range .items[*]}{.metadata.name} {.status.phase} {.status.containerStatuses[*].ready}{" "}{end}' 2>/dev/null || true)"
    endpoints="$(kubectl_k3s get endpointslice -n "$namespace" -l "kubernetes.io/service-name=$service" -o json 2>/dev/null | jq '[.items[].endpoints[]? | select((.conditions.ready // true) == true and (.conditions.serving // true) == true) | .addresses[]?] | length' 2>/dev/null || printf '0')"
    if [ "$ready" = "True" ] && grep -Eq ' Running .*true' <<<"$pod_status" && [ "${endpoints:-0}" -gt 0 ]; then
      return 0
    fi
    sleep 3
  done
  [ "$ready" = "True" ] || die "VMI $namespace/$vm is not Ready (Ready=$ready)"
  grep -Eq ' Running .*true' <<<"$pod_status" || die "VMI launcher pod is not serving: ${pod_status:-missing}"
  [ "${endpoints:-0}" -gt 0 ] || die "Service $namespace/$service has no ready EndpointSlice addresses"
}

ensure_ssh() {
  mkdir -p "$(dirname "$ssh_key")" "$(dirname "$known_hosts")"
  if [ ! -r "$ssh_key" ]; then
    log "Generating operator key: $ssh_key"
    ssh-keygen -t ed25519 -N "" -C "orkestr-public-kubevirt-operator" -f "$ssh_key" >/dev/null
  fi
  if vm_ssh 'true' >/dev/null 2>&1; then
    log "VM SSH already works."
    return 0
  fi
  log "Adding operator SSH key through QEMU guest-agent."
  virtctl_k3s credentials add-ssh-key --namespace "$namespace" --user "$ssh_user" --file "$ssh_key.pub" --force "$vm" >/dev/null
  sleep 5
  if ! vm_ssh 'true' >/dev/null 2>&1; then
    log "Restarting VM so the access credential is applied."
    virtctl_k3s restart --namespace "$namespace" "$vm" >/dev/null
    wait_vm_ready
  fi
  wait_vm_ssh
  log "VM SSH is ready."
}

backup_host_state() {
  local stamp backup_path
  [ -d "$host_home" ] || die "Host public home not found: $host_home"
  mkdir -p "$backup_dir"
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  backup_path="$backup_dir/host-public-state-$stamp.tar.gz"
  log "Backing up $host_home to $backup_path"
  tar -C "$host_home" \
    --exclude './browsers' \
    --exclude './codex-home' \
    --exclude './run' \
    --exclude './tmp' \
    --exclude './workspaces' \
    --exclude './whatsapp-bridge' \
    -czf "$backup_path" .
  printf '%s\n' "$backup_path"
}

copy_public_state() {
  local backup_path remote_path
  ensure_ssh
  backup_vm_state >/dev/null
  backup_path="$(backup_host_state | tail -n 1)"
  remote_path="/tmp/$(basename "$backup_path")"
  log "Copying public-only state backup into VM."
  vm_scp_to "$backup_path" "$remote_path"
  vm_ssh "set -euo pipefail; sudo systemctl stop orkestr.service 2>/dev/null || sudo systemctl stop orkestr 2>/dev/null || true; sudo mkdir -p '$vm_home'; sudo tar -C '$vm_home' -xzf '$remote_path'; sudo chown -R orkestr:orkestr '$vm_home'; sudo systemctl start orkestr.service 2>/dev/null || sudo systemctl start orkestr 2>/dev/null || true"
  log "Public-only state copied into $namespace/$vm:$vm_home"
}

backup_vm_state() {
  local stamp remote_path backup_path
  ensure_ssh
  mkdir -p "$backup_dir"
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  remote_path="/tmp/vm-public-state-$stamp.tar.gz"
  backup_path="$backup_dir/vm-public-state-$stamp.tar.gz"
  log "Backing up VM $namespace/$vm:$vm_home to $backup_path"
  vm_ssh "set -euo pipefail; sudo tar -C '$vm_home' --exclude './browsers' --exclude './codex-home' --exclude './run' --exclude './tmp' --exclude './workspaces' --exclude './whatsapp-bridge' -czf '$remote_path' .; sudo chown '$ssh_user:$ssh_user' '$remote_path'"
  vm_scp_from "$remote_path" "$backup_path"
  vm_ssh "rm -f '$remote_path'"
  printf '%s\n' "$backup_path"
}

update_vm() {
  [ -n "$ref" ] || die "update-vm requires --ref REF"
  ensure_ssh
  log "Updating VM Orkestr to $ref on channel $channel."
  vm_ssh "set -euo pipefail; sudo env ORKESTR_HOME='$vm_home' ORKESTR_API_BASE='$vm_api' orkestr update --release --ref '$ref' --channel '$channel' --allow-interrupt --no-smoke"
}

smoke() {
  local svc_url code thread_id attach_output
  ensure_ssh
  svc_url="$(service_url)"
  log "Checking KubeVirt service endpoints."
  assert_kubevirt_service_ready
  log "Checking VM Service health at $svc_url."
  json_health "$svc_url"
  curl -fsS "$svc_url/api/version" | jq '{version, commit, tag, releaseId, dirty}'

  log "Checking VM-local CLI list."
  vm_ssh "ORKESTR_HOME='$vm_home' ORKESTR_API_BASE='$vm_api' orkestr list --json >/tmp/orkestr-list.json && jq '{count:(.threads | length)}' /tmp/orkestr-list.json"

  log "Checking VM default managed desktop."
  vm_ssh "set -euo pipefail; slug=\$(set -a; . /etc/orkestr/orkestr.env; set +a; printf '%s' \"\${ORKESTR_DEFAULT_DESKTOP_SLUG:-desktop}\"); ORKESTR_HOME='$vm_home' orkestr-browserctl health \"\$slug\" >/tmp/orkestr-default-desktop.json; jq -e --arg slug \"\$slug\" '.ok == true and .session.slug == \$slug and (.session.status == \"prepared\" or .session.status == \"running\") and ((.session.desk_url // \"\") | test(\"^/desktop/\"))' /tmp/orkestr-default-desktop.json >/dev/null; jq '{slug:.session.slug,status:.session.status,url:.session.desk_url}' /tmp/orkestr-default-desktop.json"

  thread_id="$(vm_ssh "ORKESTR_HOME='$vm_home' ORKESTR_API_BASE='$vm_api' orkestr list --json" | jq -r '.threads[0].id // empty' | tail -n 1)"
  if [ -n "$thread_id" ]; then
    log "Checking VM-local attach --print for $thread_id."
    if attach_output="$(vm_ssh "ORKESTR_HOME='$vm_home' ORKESTR_API_BASE='$vm_api' orkestr attach --print '$thread_id'" 2>&1)"; then
      printf '%s\n' "$attach_output" | grep -E 'tmux|attach|codex|thread' >/dev/null || die "Unexpected attach output"
    elif printf '%s\n' "$attach_output" | grep -q 'Codex is not signed in'; then
      log "Attach reached the VM-local operator path but skipped: public Codex runtime is not configured."
    else
      printf '%s\n' "$attach_output" >&2
      die "VM-local attach --print failed"
    fi
  else
    log "No VM thread exists; skipping attach --print positive check."
  fi

  log "Checking external attach remains protected."
  code="$(curl -sS -o /tmp/orkestr-public-attach-denied.json -w '%{http_code}' -X POST "$svc_url/api/threads/not-a-real-thread/attach" || true)"
  [ "$code" = "401" ] || die "Expected 401 from unauthenticated attach, got $code"
  grep -q 'browser_pairing_required' /tmp/orkestr-public-attach-denied.json || die "Attach denial did not include browser_pairing_required"

  log "Checking containment from inside VM."
  vm_ssh "set -euo pipefail; for p in /home/openclaw/.orkestr-production /home/openclaw/.codex-ops /var/run/docker.sock /run/podman/podman.sock /root/.codex/auth.json /root/.codex/config.toml /root/.codex/history.jsonl; do if sudo test -e \"\$p\"; then echo \"unexpected visible private state: \$p\" >&2; exit 20; fi; done"
  log "Smoke passed."
}

replace_caddy_upstream() {
  local from="$1"
  local to="$2"
  [ -r "$caddyfile" ] || die "Cannot read Caddyfile: $caddyfile"
  if [ "$dry_run" -eq 1 ]; then
    log "Dry run: would replace public orkestr.de reverse_proxy $from with reverse_proxy $to in $caddyfile"
    return 0
  fi
  cp "$caddyfile" "$backup_dir/Caddyfile.$(date -u +%Y%m%dT%H%M%SZ).bak"
  python3 - "$caddyfile" "$from" "$to" <<'PY'
from pathlib import Path
import sys
path = Path(sys.argv[1])
old = f"reverse_proxy {sys.argv[2]}"
new = f"reverse_proxy {sys.argv[3]}"
targets = {"https://orkestr.de", "https://app.orkestr.de", "https://auth.orkestr.de"}
lines = path.read_text().splitlines(keepends=True)
in_target = False
depth = 0
changed = 0
out = []
for line in lines:
    stripped = line.strip()
    if not in_target and stripped.endswith("{"):
        name = stripped[:-1].strip()
        if name in targets:
            in_target = True
            depth = 0
    if in_target and old in line:
        line = line.replace(old, new)
        changed += 1
    out.append(line)
    if in_target:
        depth += line.count("{") - line.count("}")
        if depth <= 0:
            in_target = False
if changed == 0:
    raise SystemExit(f"missing {old} in public orkestr.de blocks")
path.write_text("".join(out))
PY
  caddy validate --config "$caddyfile" >/dev/null
  systemctl reload caddy
}

cutover() {
  local svc_url
  mkdir -p "$backup_dir"
  svc_url="$(service_url)"
  json_health "$svc_url"
  log "Cutting Caddy over to $svc_url"
  replace_caddy_upstream "127.0.0.1:19812" "${svc_url#http://}"
  if [ "$dry_run" -eq 1 ]; then
    log "Dry run: would disable host orkestr-public.service and run post-cutover smoke."
    return 0
  fi
  if systemctl is-active --quiet orkestr-public.service; then
    log "Stopping host orkestr-public.service after successful Caddy reload."
    systemctl disable --now orkestr-public.service
  fi
  smoke
}

rollback() {
  local svc_url
  mkdir -p "$backup_dir"
  svc_url="$(service_url)"
  log "Rolling Caddy back from $svc_url to host 127.0.0.1:19812"
  if [ "$dry_run" -eq 1 ]; then
    replace_caddy_upstream "${svc_url#http://}" "127.0.0.1:19812"
    log "Dry run: would enable host orkestr-public.service and verify host public health."
    return 0
  fi
  systemctl enable --now orkestr-public.service
  replace_caddy_upstream "${svc_url#http://}" "127.0.0.1:19812"
  json_health "$host_api"
  log "Rollback health passed."
}

status() {
  local svc_url
  svc_url="$(service_url)"
  log "KubeVirt VM:"
  kubectl_k3s get vm,vmi,svc,pvc -n "$namespace" -o wide
  log "KubeVirt launcher pod and endpoints:"
  kubectl_k3s get pod,endpoints,endpointslice -n "$namespace" -l "kubevirt.io/domain=$vm" -o wide || true
  kubectl_k3s get endpoints,endpointslice -n "$namespace" -l "kubernetes.io/service-name=$service" -o wide || true
  log "Host public API:"
  curl -fsS "$host_api/api/version" | jq '{version, commit, releaseId, dirty}' || true
  log "VM public API:"
  curl -fsS "$svc_url/api/version" | jq '{version, commit, releaseId, dirty}' || true
  log "Caddy public upstreams:"
  grep -nE 'app\.orkestr\.de|auth\.orkestr\.de|orkestr\.de|reverse_proxy' "$caddyfile" | grep -A4 -B2 'orkestr.de' || true
}

case "$action" in
  status)
    status
    ;;
  ensure-ssh)
    ensure_ssh
    ;;
  backup-host-state)
    backup_host_state >/dev/null
    ;;
  backup-vm-state)
    backup_vm_state >/dev/null
    ;;
  copy-public-state)
    copy_public_state
    ;;
  update-vm)
    update_vm
    ;;
  smoke)
    smoke
    ;;
  cutover)
    cutover
    ;;
  rollback)
    rollback
    ;;
esac
