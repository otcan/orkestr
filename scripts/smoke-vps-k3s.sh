#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Run Orkestr's installer smoke test inside a disposable KubeVirt VM on an existing k3s cluster.

The script creates a fresh Ubuntu 24.04 VM, waits for SSH through virtctl,
runs scripts/bootstrap-vps.sh inside the VM, runs `npm run smoke`
inside /opt/orkestr/app, and deletes the temporary namespace.

Requirements:
  kubectl, virtctl, ssh, scp, ssh-keygen
  A k3s/KubeVirt cluster with CDI and a default storage class

Usage:
  scripts/smoke-vps-k3s.sh [options]

Options:
  --kubeconfig FILE       Kubeconfig for the k3s cluster. Defaults to KUBECONFIG or /etc/rancher/k3s/k3s.yaml.
  --namespace NAME        Temporary namespace. Defaults to orkestr-vps-smoke-<timestamp>.
  --vm-name NAME          VM name inside the namespace. Defaults to orkestr-smoke.
  --repo URL              Repo installed by bootstrap-vps.sh. Defaults to https://github.com/otcan/orkestr.git.
  --ref REF               Branch, tag, or commit installed by bootstrap-vps.sh. Defaults to main.
  --image-url URL         Ubuntu cloud image URL. Defaults to Ubuntu 24.04 noble amd64.
  --cache-image-locally   Download the VM image to this host and serve it to CDI over local HTTP.
  --storage-size SIZE     Root disk PVC size. Defaults to 40Gi.
  --memory SIZE           VM memory request. Defaults to 4Gi.
  --cpu CORES             VM CPU cores. Defaults to 2.
  --local-bootstrap       Upload local scripts/bootstrap-vps.sh and scripts/install.sh instead of fetching bootstrap URL.
  --keep                  Keep the namespace and generated SSH key after the run.
  --keep-on-failure       Keep the namespace and generated SSH key only when the smoke fails.
  --help                  Show this help.
USAGE
}

log() {
  printf '[orkestr-k3s-vps-smoke] %s\n' "$*"
}

die() {
  printf '[orkestr-k3s-vps-smoke] error: %s\n' "$*" >&2
  exit 1
}

need() {
  command -v "$1" >/dev/null 2>&1 || die "Missing required command: $1"
}

quote_args() {
  local arg
  for arg in "$@"; do
    printf ' %q' "$arg"
  done
}

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
repo_root="$(cd "$script_dir/.." >/dev/null 2>&1 && pwd)"
stamp="$(date -u +%Y%m%d%H%M%S)"
kubeconfig="${KUBECONFIG:-/etc/rancher/k3s/k3s.yaml}"
namespace="orkestr-vps-smoke-$stamp"
vm_name="orkestr-smoke"
repo_url="${ORKESTR_REPO_URL:-https://github.com/otcan/orkestr.git}"
git_ref="${ORKESTR_GIT_REF:-main}"
image_url="${ORKESTR_K3S_SMOKE_IMAGE_URL:-http://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img}"
image_cache_dir="${ORKESTR_K3S_SMOKE_IMAGE_CACHE_DIR:-/tmp/orkestr-k3s-vps-smoke-images}"
storage_size="${ORKESTR_K3S_SMOKE_STORAGE_SIZE:-40Gi}"
memory="${ORKESTR_K3S_SMOKE_MEMORY:-4Gi}"
cpu="${ORKESTR_K3S_SMOKE_CPU:-2}"
local_bootstrap=0
cache_image_locally=0
keep=0
keep_on_failure=0

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
    --vm-name)
      vm_name="${2:-}"
      shift 2
      ;;
    --repo)
      repo_url="${2:-}"
      shift 2
      ;;
    --ref)
      git_ref="${2:-}"
      shift 2
      ;;
    --image-url)
      image_url="${2:-}"
      shift 2
      ;;
    --cache-image-locally)
      cache_image_locally=1
      shift
      ;;
    --storage-size)
      storage_size="${2:-}"
      shift 2
      ;;
    --memory)
      memory="${2:-}"
      shift 2
      ;;
    --cpu)
      cpu="${2:-}"
      shift 2
      ;;
    --local-bootstrap)
      local_bootstrap=1
      shift
      ;;
    --keep)
      keep=1
      shift
      ;;
    --keep-on-failure)
      keep_on_failure=1
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

[ -n "$kubeconfig" ] || die "--kubeconfig is required"
[ -r "$kubeconfig" ] || die "Cannot read kubeconfig: $kubeconfig"
[ -n "$namespace" ] || die "--namespace is required"
[ -n "$vm_name" ] || die "--vm-name is required"
[ -n "$repo_url" ] || die "--repo is required"
[ -n "$git_ref" ] || die "--ref is required"
[ -n "$image_url" ] || die "--image-url is required"

need kubectl
need virtctl
need ssh
need scp
need ssh-keygen
need timeout

work="$(mktemp -d /tmp/orkestr-k3s-vps-smoke.XXXXXX)"
key="$work/ssh_key"
known_hosts="$work/known_hosts"
manifest="$work/vm.yaml"
image_server_manifest="$work/image-server.yaml"

kubectl_k3s() {
  KUBECONFIG="$kubeconfig" kubectl "$@"
}

virtctl_k3s() {
  KUBECONFIG="$kubeconfig" virtctl "$@"
}

virtctl_ssh_opts=(
  --namespace "$namespace"
  --username orkestr
  --identity-file "$key"
  --known-hosts "$known_hosts"
  --local-ssh-opts "-o StrictHostKeyChecking=accept-new"
  --local-ssh-opts "-o ConnectTimeout=8"
  --local-ssh-opts "-o ServerAliveInterval=30"
  --local-ssh-opts "-o ServerAliveCountMax=10"
)

ssh_run_timeout() {
  local seconds command
  seconds="$1"
  command="$2"
  KUBECONFIG="$kubeconfig" timeout "$seconds" virtctl ssh "${virtctl_ssh_opts[@]}" --command "$command" "vm/$vm_name"
}

ssh_run() {
  ssh_run_timeout 3600 "$1"
}

scp_to_vm() {
  KUBECONFIG="$kubeconfig" timeout 180 virtctl scp \
    --namespace "$namespace" \
    --identity-file "$key" \
    --known-hosts "$known_hosts" \
    --local-ssh-opts "-o StrictHostKeyChecking=accept-new" \
    "$@"
}

cache_and_serve_image() {
  local image_name image_path image_service_ip
  [ "$cache_image_locally" -eq 1 ] || return 0

  need curl
  mkdir -p "$image_cache_dir"
  image_name="$(basename "$image_url")"
  image_path="$image_cache_dir/$image_name"

  log "Caching VM image locally: $image_path"
  curl -fL -C - -o "$image_path" "$image_url"

  cat > "$image_server_manifest" <<EOF
apiVersion: v1
kind: Pod
metadata:
  name: orkestr-image-server
  namespace: $namespace
  labels:
    app: orkestr-image-server
spec:
  containers:
    - name: server
      image: python:3.12-alpine
      imagePullPolicy: IfNotPresent
      command:
        - python3
        - -m
        - http.server
        - "8000"
        - --bind
        - 0.0.0.0
        - --directory
        - /images
      ports:
        - containerPort: 8000
          name: http
      volumeMounts:
        - name: images
          mountPath: /images
          readOnly: true
  volumes:
    - name: images
      hostPath:
        path: $image_cache_dir
        type: Directory
---
apiVersion: v1
kind: Service
metadata:
  name: orkestr-image-server
  namespace: $namespace
spec:
  selector:
    app: orkestr-image-server
  ports:
    - name: http
      port: 80
      targetPort: 8000
EOF

  log "Starting in-cluster cached image server"
  kubectl_k3s apply -f "$image_server_manifest" >/dev/null
  kubectl_k3s wait -n "$namespace" pod/orkestr-image-server --for=condition=Ready --timeout=5m
  image_service_ip="$(kubectl_k3s get svc -n "$namespace" orkestr-image-server -o jsonpath='{.spec.clusterIP}')"
  [ -n "$image_service_ip" ] || die "Could not resolve ClusterIP for cached image server"
  image_url="http://$image_service_ip/$image_name"
  log "CDI image URL: $image_url"
}

write_vm_manifest() {
  local public_key
  public_key="$(cat "$key.pub")"
  cat > "$manifest" <<EOF
apiVersion: v1
kind: Namespace
metadata:
  name: $namespace
  labels:
    app.kubernetes.io/name: orkestr-vps-smoke
---
apiVersion: kubevirt.io/v1
kind: VirtualMachine
metadata:
  name: $vm_name
  namespace: $namespace
  labels:
    app: $vm_name
spec:
  runStrategy: Always
  dataVolumeTemplates:
    - metadata:
        name: ${vm_name}-rootdisk
      spec:
        source:
          http:
            url: "$image_url"
        pvc:
          accessModes:
            - ReadWriteOnce
          storageClassName: local-path
          resources:
            requests:
              storage: $storage_size
  template:
    metadata:
      labels:
        app: $vm_name
        kubevirt.io/domain: $vm_name
    spec:
      domain:
        cpu:
          cores: $cpu
        resources:
          requests:
            memory: $memory
        devices:
          disks:
            - name: rootdisk
              disk:
                bus: virtio
            - name: cloudinitdisk
              disk:
                bus: virtio
          interfaces:
            - name: default
              bridge: {}
      networks:
        - name: default
          pod: {}
      volumes:
        - name: rootdisk
          dataVolume:
            name: ${vm_name}-rootdisk
        - name: cloudinitdisk
          cloudInitNoCloud:
            userData: |
              #cloud-config
              hostname: $vm_name
              manage_etc_hosts: true
              ssh_pwauth: false
              users:
                - default
                - name: orkestr
                  gecos: Orkestr Smoke
                  groups: sudo
                  shell: /bin/bash
                  sudo: ALL=(ALL) NOPASSWD:ALL
                  lock_passwd: true
                  ssh_authorized_keys:
                    - $public_key
              package_update: true
              packages:
                - ca-certificates
                - curl
                - git
                - openssh-server
                - qemu-guest-agent
              runcmd:
                - [systemctl, enable, --now, qemu-guest-agent]
                - [systemctl, enable, --now, ssh]
EOF
}

collect_failure_logs() {
  log "Collecting k3s/KubeVirt failure context"
  kubectl_k3s get all,vm,vmi,dv,pvc -n "$namespace" || true
  kubectl_k3s describe vm "$vm_name" -n "$namespace" || true
  kubectl_k3s describe vmi "$vm_name" -n "$namespace" || true
  kubectl_k3s get events -n "$namespace" --sort-by=.lastTimestamp || true
  if kubectl_k3s get vm "$vm_name" -n "$namespace" >/dev/null 2>&1; then
    ssh_run_timeout 30 'set +e
      echo "== systemctl status orkestr =="
      sudo systemctl status orkestr --no-pager --lines=80
      echo "== journalctl -u orkestr =="
      sudo journalctl -u orkestr --no-pager -n 160
      echo "== bootstrap tail =="
      tail -n 160 /tmp/orkestr-bootstrap.log
      echo "== cloud-init status =="
      cloud-init status --long
    ' || true
  fi
}

cleanup() {
  local status="$?"
  trap - EXIT

  if [ "$status" -ne 0 ]; then
    collect_failure_logs
  fi

  if [ "$keep" -eq 1 ] || { [ "$status" -ne 0 ] && [ "$keep_on_failure" -eq 1 ]; }; then
    log "Keeping k3s namespace and SSH key for inspection"
    log "namespace=$namespace"
    log "vm=$vm_name"
    log "ssh_key=$key"
    log "known_hosts=$known_hosts"
    exit "$status"
  fi

  log "Deleting namespace: $namespace"
  kubectl_k3s delete namespace "$namespace" --ignore-not-found=true --wait=true --timeout=5m >/dev/null 2>&1 || true
  rm -rf "$work"
  exit "$status"
}
trap cleanup EXIT

ensure_namespace() {
  kubectl_k3s create namespace "$namespace" --dry-run=client -o yaml | kubectl_k3s apply -f - >/dev/null
}

wait_for_vm() {
  log "Waiting for DataVolume creation"
  for _ in $(seq 1 120); do
    if kubectl_k3s get -n "$namespace" "datavolume/${vm_name}-rootdisk" >/dev/null 2>&1; then
      break
    fi
    sleep 2
  done
  kubectl_k3s get -n "$namespace" "datavolume/${vm_name}-rootdisk" >/dev/null 2>&1 || {
    kubectl_k3s describe vm "$vm_name" -n "$namespace" || true
    die "DataVolume ${vm_name}-rootdisk was not created"
  }

  log "Waiting for DataVolume import"
  if ! kubectl_k3s wait -n "$namespace" "datavolume/${vm_name}-rootdisk" --for=jsonpath='{.status.phase}'=Succeeded --timeout=20m; then
    die "DataVolume ${vm_name}-rootdisk did not finish importing"
  fi
  if [ "$(kubectl_k3s get -n "$namespace" "datavolume/${vm_name}-rootdisk" -o jsonpath='{.status.phase}')" != "Succeeded" ]; then
    die "DataVolume ${vm_name}-rootdisk is not Succeeded after wait"
  fi

  log "Waiting for VM readiness"
  if ! kubectl_k3s wait -n "$namespace" "vm/$vm_name" --for=condition=Ready --timeout=10m; then
    die "VM $vm_name did not become Ready"
  fi
  kubectl_k3s get vm,vmi,pod -n "$namespace" -o wide
}

wait_for_ssh() {
  log "Waiting for SSH"
  for _ in $(seq 1 180); do
    if ssh_run_timeout 20 true >/dev/null 2>&1; then
      log "SSH is ready"
      return 0
    fi
    sleep 5
  done
  die "SSH did not become ready through virtctl ssh"
}

wait_for_cloud_init() {
  log "Waiting for cloud-init"
  ssh_run 'if command -v cloud-init >/dev/null 2>&1; then sudo cloud-init status --wait; fi'
}

run_installer() {
  local bootstrap_args remote_cmd bootstrap_url

  bootstrap_args=(--repo "$repo_url" --ref "$git_ref" --no-tailscale --no-auto-update)
  if [ "$local_bootstrap" -eq 1 ]; then
    log "Uploading local bootstrap/install scripts"
    ssh_run 'mkdir -p /tmp/orkestr-vps-smoke'
    scp_to_vm \
      "$repo_root/scripts/bootstrap-vps.sh" \
      "orkestr@vm/$vm_name:/tmp/orkestr-vps-smoke/bootstrap-vps.sh" >/dev/null
    scp_to_vm \
      "$repo_root/scripts/install.sh" \
      "orkestr@vm/$vm_name:/tmp/orkestr-vps-smoke/install.sh" >/dev/null
    remote_cmd="set -euo pipefail; chmod +x /tmp/orkestr-vps-smoke/bootstrap-vps.sh /tmp/orkestr-vps-smoke/install.sh; sudo env DEBIAN_FRONTEND=noninteractive /tmp/orkestr-vps-smoke/bootstrap-vps.sh$(quote_args "${bootstrap_args[@]}") 2>&1 | tee /tmp/orkestr-bootstrap.log"
  else
    bootstrap_url="https://raw.githubusercontent.com/otcan/orkestr/${git_ref}/scripts/bootstrap-vps.sh"
    log "Fetching bootstrap script in VM: $bootstrap_url"
    remote_cmd="set -euo pipefail; curl -fsSL $(printf '%q' "$bootstrap_url") -o /tmp/bootstrap-vps.sh; chmod +x /tmp/bootstrap-vps.sh; sudo env DEBIAN_FRONTEND=noninteractive /tmp/bootstrap-vps.sh$(quote_args "${bootstrap_args[@]}") 2>&1 | tee /tmp/orkestr-bootstrap.log"
  fi

  log "Running installer inside k3s VM"
  ssh_run "$remote_cmd"
}

run_remote_smoke() {
  log "Running remote Orkestr smoke test"
  ssh_run 'set -euo pipefail
    printf "service=%s\n" "$(systemctl is-active orkestr)"
    printf "version="
    curl -fsS http://127.0.0.1:19812/api/version
    printf "\n"
    cd /opt/orkestr/app
    npm run smoke
  '
}

main() {
  log "Using kubeconfig: $kubeconfig"
  log "Creating disposable VM $namespace/$vm_name"

  ssh-keygen -q -t ed25519 -N '' -C "orkestr-k3s-smoke-$stamp" -f "$key"
  ensure_namespace
  cache_and_serve_image
  write_vm_manifest
  kubectl_k3s apply -f "$manifest"

  wait_for_vm
  wait_for_ssh
  wait_for_cloud_init
  run_installer
  run_remote_smoke

  log "k3s VM smoke passed: namespace=$namespace vm=$vm_name"
}

main "$@"
