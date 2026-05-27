#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Route a dedicated public IPv4 address to a KubeVirt VM on a single-node k3s host.

This helper is intended for host-routed /32 addresses, such as dedicated or
failover IPs routed to the k3s node. It keeps the guest on the normal KubeVirt
pod network, then applies host DNAT/SNAT rules so selected public ports and
guest egress use the dedicated public IP.

Usage:
  scripts/k3s-vm-public-ip.sh apply --namespace NS --vm VM --public-ip IP [options]
  scripts/k3s-vm-public-ip.sh delete --namespace NS --vm VM --public-ip IP [options]
  scripts/k3s-vm-public-ip.sh install-systemd --namespace NS --vm VM --public-ip IP [options]

Options:
  --kubeconfig FILE       k3s kubeconfig. Defaults to KUBECONFIG or /etc/rancher/k3s/k3s.yaml.
  --namespace NS          Namespace containing the KubeVirt VM.
  --vm VM                 KubeVirt VM/VMI name.
  --public-ip IP          Public IPv4 address routed to this host.
  --vm-ip IP              Guest/pod IPv4. Defaults to reading the VM/VMI from Kubernetes.
  --interface IFACE       Public host interface. Defaults to the default-route interface.
  --ports LIST            Public TCP ports to forward. Defaults to 22,80,443.
  --wait-seconds N        Seconds to wait for the VMI IP. Defaults to 180.
  --help                  Show this help.

Examples:
  scripts/k3s-vm-public-ip.sh install-systemd \
    --namespace orkestr-example --vm orkestr-example \
    --public-ip 203.0.113.10 --ports 22,80,443

The installed systemd unit reapplies rules after reboot and after k3s starts.
USAGE
}

log() {
  printf '[orkestr-k3s-public-ip] %s\n' "$*"
}

die() {
  printf '[orkestr-k3s-public-ip] error: %s\n' "$*" >&2
  exit 1
}

need() {
  command -v "$1" >/dev/null 2>&1 || die "Missing required command: $1"
}

action="${1:-}"
if [ "$action" = "--help" ] || [ "$action" = "-h" ]; then
  usage
  exit 0
fi
if [ -n "$action" ]; then shift; fi

kubeconfig="${KUBECONFIG:-/etc/rancher/k3s/k3s.yaml}"
namespace=""
vm=""
public_ip=""
vm_ip=""
interface=""
ports="22,80,443"
wait_seconds=180

while [ "$#" -gt 0 ]; do
  case "$1" in
    --kubeconfig)
      kubeconfig="${2:-}"
      shift 2
      ;;
    --namespace|-n)
      namespace="${2:-}"
      shift 2
      ;;
    --vm)
      vm="${2:-}"
      shift 2
      ;;
    --public-ip)
      public_ip="${2:-}"
      shift 2
      ;;
    --vm-ip)
      vm_ip="${2:-}"
      shift 2
      ;;
    --interface)
      interface="${2:-}"
      shift 2
      ;;
    --ports)
      ports="${2:-}"
      shift 2
      ;;
    --wait-seconds)
      wait_seconds="${2:-}"
      shift 2
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

[ "$action" = "apply" ] || [ "$action" = "delete" ] || [ "$action" = "install-systemd" ] || {
  usage >&2
  exit 2
}
[ -n "$namespace" ] || die "--namespace is required"
[ -n "$vm" ] || die "--vm is required"
[ -n "$public_ip" ] || die "--public-ip is required"
[ -r "$kubeconfig" ] || die "Cannot read kubeconfig: $kubeconfig"
[ -n "$ports" ] || die "--ports must not be empty"

need ip
need iptables

kubectl_k3s() {
  KUBECONFIG="$kubeconfig" kubectl "$@"
}

default_interface() {
  ip -o -4 route show default | awk '{for (i = 1; i <= NF; i++) if ($i == "dev") {print $(i + 1); exit}}'
}

vmi_ip() {
  local ip_value pod_value
  ip_value="$(kubectl_k3s get vmi -n "$namespace" "$vm" -o jsonpath='{.status.interfaces[0].ipAddress}' 2>/dev/null || true)"
  if [ -n "$ip_value" ]; then
    printf '%s' "$ip_value"
    return 0
  fi
  pod_value="$(kubectl_k3s get pod -n "$namespace" -l "kubevirt.io/domain=$vm" -o jsonpath='{.items[0].status.podIP}' 2>/dev/null || true)"
  [ -n "$pod_value" ] && printf '%s' "$pod_value"
}

wait_for_vm_ip() {
  local deadline ip_value
  if [ -n "$vm_ip" ]; then
    printf '%s' "$vm_ip"
    return 0
  fi
  deadline=$((SECONDS + wait_seconds))
  while [ "$SECONDS" -le "$deadline" ]; do
    ip_value="$(vmi_ip)"
    if [ -n "$ip_value" ]; then
      printf '%s' "$ip_value"
      return 0
    fi
    sleep 2
  done
  die "Could not determine VM IP for $namespace/$vm"
}

ensure_rule() {
  local table="$1"
  local chain="$2"
  shift 2
  if ! iptables -t "$table" -C "$chain" "$@" >/dev/null 2>&1; then
    iptables -t "$table" -I "$chain" 1 "$@"
  fi
}

delete_rule() {
  local table="$1"
  local chain="$2"
  shift 2
  while iptables -t "$table" -C "$chain" "$@" >/dev/null 2>&1; do
    iptables -t "$table" -D "$chain" "$@"
  done
}

assign_public_ip() {
  ip -4 address show dev "$interface" | grep -F " $public_ip/32" >/dev/null || {
    log "Assigning $public_ip/32 to $interface"
    ip address add "$public_ip/32" dev "$interface"
  }
}

apply_rules() {
  local target_ip="$1"
  assign_public_ip
  sysctl -w net.ipv4.ip_forward=1 >/dev/null
  ensure_rule nat PREROUTING -d "$public_ip/32" -p tcp -m multiport --dports "$ports" -j DNAT --to-destination "$target_ip"
  ensure_rule nat OUTPUT -d "$public_ip/32" -p tcp -m multiport --dports "$ports" -j DNAT --to-destination "$target_ip"
  ensure_rule nat POSTROUTING -s "$target_ip/32" -o "$interface" -j SNAT --to-source "$public_ip"
  ensure_rule filter FORWARD -d "$target_ip/32" -p tcp -m multiport --dports "$ports" -j ACCEPT
  ensure_rule filter FORWARD -s "$target_ip/32" -j ACCEPT
  log "Routed $public_ip tcp/$ports to $namespace/$vm at $target_ip"
}

delete_rules() {
  local target_ip="$1"
  delete_rule nat PREROUTING -d "$public_ip/32" -p tcp -m multiport --dports "$ports" -j DNAT --to-destination "$target_ip"
  delete_rule nat OUTPUT -d "$public_ip/32" -p tcp -m multiport --dports "$ports" -j DNAT --to-destination "$target_ip"
  delete_rule nat POSTROUTING -s "$target_ip/32" -o "$interface" -j SNAT --to-source "$public_ip"
  delete_rule filter FORWARD -d "$target_ip/32" -p tcp -m multiport --dports "$ports" -j ACCEPT
  delete_rule filter FORWARD -s "$target_ip/32" -j ACCEPT
  log "Removed route rules for $public_ip to $namespace/$vm at $target_ip"
}

systemd_unit_name() {
  printf 'orkestr-k3s-vm-public-ip-%s-%s.service' "$namespace" "$vm" | tr -c 'A-Za-z0-9_.@-' '-'
}

install_systemd() {
  local script_path unit_name unit_path
  need systemctl
  script_path="/usr/local/sbin/orkestr-k3s-vm-public-ip"
  install -m 0755 "$0" "$script_path"
  unit_name="$(systemd_unit_name)"
  unit_path="/etc/systemd/system/$unit_name"
  cat > "$unit_path" <<EOF
[Unit]
Description=Route $public_ip to KubeVirt VM $namespace/$vm
After=network-online.target k3s.service
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=$script_path apply --kubeconfig $kubeconfig --namespace $namespace --vm $vm --public-ip $public_ip --interface $interface --ports $ports --wait-seconds $wait_seconds
ExecStop=$script_path delete --kubeconfig $kubeconfig --namespace $namespace --vm $vm --public-ip $public_ip --interface $interface --ports $ports --wait-seconds 10

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable --now "$unit_name"
  log "Installed systemd unit $unit_name"
}

interface="${interface:-$(default_interface)}"
[ -n "$interface" ] || die "Could not determine default public interface; pass --interface"
need kubectl

case "$action" in
  apply)
    apply_rules "$(wait_for_vm_ip)"
    ;;
  delete)
    delete_rules "$(wait_for_vm_ip)"
    ;;
  install-systemd)
    install_systemd
    ;;
esac
