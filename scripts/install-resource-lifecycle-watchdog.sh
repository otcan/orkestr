#!/usr/bin/env bash
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "install-resource-lifecycle-watchdog.sh must run as root" >&2
  exit 1
fi

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
install_dir="${ORKESTR_RESOURCE_LIFECYCLE_INSTALL_DIR:-/usr/local/lib/orkestr}"
config_file="${ORKESTR_RESOURCE_LIFECYCLE_CONFIG_FILE:-/etc/orkestr/resource-lifecycle.env}"
state_dir="${ORKESTR_RESOURCE_LIFECYCLE_STATE_DIR:-/var/lib/orkestr-resource-lifecycle}"
orkestr_home="${ORKESTR_HOME:-/var/lib/orkestr}"
kubeconfig="${KUBECONFIG:-}"
if [ -z "$kubeconfig" ] && [ -r /etc/rancher/k3s/k3s.yaml ]; then
  kubeconfig=/etc/rancher/k3s/k3s.yaml
fi
script_path="$install_dir/resource-lifecycle-watchdog.mjs"

install -d -m 0755 "$install_dir" /etc/orkestr
install -d -m 0700 "$state_dir"
install -m 0755 "$repo_dir/scripts/resource-lifecycle-watchdog.mjs" "$script_path"

if [ ! -e "$config_file" ]; then
  {
    printf 'ORKESTR_HOME=%q\n' "$orkestr_home"
    cat <<'EOF'
ORKESTR_RESOURCE_LIFECYCLE_STATE_DIR=/var/lib/orkestr-resource-lifecycle
ORKESTR_RESOURCE_LIFECYCLE_ENFORCE=1
ORKESTR_RESOURCE_LIFECYCLE_TAB_CLEANUP_ENABLED=1
ORKESTR_RESOURCE_LIFECYCLE_TAB_MAX_AGE=2h
ORKESTR_RESOURCE_LIFECYCLE_TAB_MAX_COUNT=8
ORKESTR_RESOURCE_LIFECYCLE_TAB_MIN_KEEP=2
ORKESTR_RESOURCE_LIFECYCLE_TAB_MAX_CLOSE_PER_RUN=3
ORKESTR_RESOURCE_LIFECYCLE_BROWSER_RESTART_ENABLED=1
ORKESTR_RESOURCE_LIFECYCLE_BROWSER_RESTART_RSS_GIB=8
ORKESTR_RESOURCE_LIFECYCLE_BROWSER_RESTART_UPTIME=7d
ORKESTR_RESOURCE_LIFECYCLE_BROWSER_RESTART_MIN_INTERVAL=6h
ORKESTR_RESOURCE_LIFECYCLE_MAX_DESKTOP_ACTIONS_PER_RUN=1
ORKESTR_RESOURCE_LIFECYCLE_DESKTOP_STOP_ENABLED=1
ORKESTR_RESOURCE_LIFECYCLE_DESKTOP_IDLE_STOP=30m
ORKESTR_RESOURCE_LIFECYCLE_TRANSIENT_DESKTOPS=android-emulator,wa-windows,ppt,synbiobeta,synbiobeta-murat,sosv-physical-ai,wa-voice,jobseeker-can
ORKESTR_RESOURCE_LIFECYCLE_DESKTOP_VMS=android-emulator,wa-windows
ORKESTR_RESOURCE_LIFECYCLE_INSTANCE_STOP_ENABLED=0
ORKESTR_RESOURCE_LIFECYCLE_ORPHAN_CLEANUP_ENABLED=1
ORKESTR_RESOURCE_LIFECYCLE_ORPHAN_GRACE=15m
ORKESTR_RESOURCE_LIFECYCLE_ORPHAN_MIN_OBSERVATIONS=3
ORKESTR_RESOURCE_LIFECYCLE_HEALTH_STALE_AFTER=12m
EOF
  } > "$config_file"
  chmod 0600 "$config_file"
fi

if [ -n "$kubeconfig" ] && ! grep -q '^KUBECONFIG=' "$config_file"; then
  printf 'KUBECONFIG=%q\n' "$kubeconfig" >> "$config_file"
fi

cat > /etc/systemd/system/orkestr-resource-lifecycle.service <<EOF
[Unit]
Description=Orkestr resource lifecycle controller
After=network-online.target k3s.service
Wants=network-online.target

[Service]
Type=oneshot
EnvironmentFile=-$config_file
ExecStart=/usr/bin/node $script_path run
TimeoutStartSec=4min
Nice=10
IOSchedulingClass=idle
EOF

cat > /etc/systemd/system/orkestr-resource-lifecycle.timer <<'EOF'
[Unit]
Description=Run the Orkestr resource lifecycle controller every five minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=5min
AccuracySec=15s
Persistent=true
Unit=orkestr-resource-lifecycle.service

[Install]
WantedBy=timers.target
EOF

cat > /etc/systemd/system/orkestr-resource-lifecycle-health.service <<EOF
[Unit]
Description=Watch the Orkestr resource lifecycle controller heartbeat
After=network-online.target

[Service]
Type=oneshot
EnvironmentFile=-$config_file
ExecStart=/usr/bin/node $script_path health
TimeoutStartSec=2min
EOF

cat > /etc/systemd/system/orkestr-resource-lifecycle-health.timer <<'EOF'
[Unit]
Description=Check the Orkestr resource lifecycle heartbeat every five minutes

[Timer]
OnBootSec=4min
OnUnitActiveSec=5min
AccuracySec=15s
Persistent=true
Unit=orkestr-resource-lifecycle-health.service

[Install]
WantedBy=timers.target
EOF

install -d -m 0755 /etc/systemd/system/orkestr-memory-watch.service.d
cat > /etc/systemd/system/orkestr-memory-watch.service.d/50-resource-lifecycle-health.conf <<EOF
[Service]
ExecStartPost=-/usr/bin/node $script_path health
EOF

systemctl daemon-reload
systemctl enable orkestr-resource-lifecycle.timer orkestr-resource-lifecycle-health.timer
systemctl start orkestr-resource-lifecycle.service
systemctl start orkestr-resource-lifecycle-health.service
systemctl start orkestr-resource-lifecycle.timer orkestr-resource-lifecycle-health.timer
