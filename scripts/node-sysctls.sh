#!/usr/bin/env bash
# Node sysctls for a dense k8s box — home-lab#43 (found via jellyfin).
# The kernel default fs.inotify.max_user_instances=128 is per-UID and shared
# by EVERY pod on the node; on a busy node it exhausts and apps crash at
# startup with "configured user limit (128) on the number of inotify
# instances has been reached" (jellyfin sat in CrashLoopBackOff for 3 days).
# Raise instances + watches well past what the fleet needs. Idempotent.
#
# Run ON each node: sudo bash node-sysctls.sh
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "ERROR: run with sudo/root"; exit 1; }

cat > /etc/sysctl.d/99-homelab-inotify.conf <<'EOF'
# Managed by scripts/node-sysctls.sh (home-lab#43). Defaults (128/8192-ish)
# are per-UID across all pods on the node — far too low for a dense box.
fs.inotify.max_user_instances = 1024
fs.inotify.max_user_watches = 1048576
EOF
sysctl -p /etc/sysctl.d/99-homelab-inotify.conf >/dev/null
echo "OK on $(hostname): instances=$(sysctl -n fs.inotify.max_user_instances) watches=$(sysctl -n fs.inotify.max_user_watches)"
