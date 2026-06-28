#!/usr/bin/env bash
# Install the in-cluster registry trust config on THIS k3s node, then restart k3s
# so containerd regenerates its config and can pull plain-HTTP images from the
# LAN registry (192.168.5.173:30500). Mirrors clusters/home/registry/registries.yaml.
#
# Run ON EACH NODE that is missing it (a2, a3, spark), with root:
#   sudo bash apply-registry-config.sh
#
# Restarting k3s is NON-DISRUPTIVE to running pods: containerd's per-container
# shim processes are reparented to init and keep the containers alive across the
# restart; the kubelet just reconnects. The node shows NotReady for ~10-30s
# (on a3, the control-plane API also blips briefly), but workloads keep running.
# Safe to re-run; it backs up any existing file.
set -euo pipefail
REG="192.168.5.173:30500"
DEST=/etc/rancher/k3s/registries.yaml

[ "$(id -u)" = 0 ] || { echo "ERROR: run with sudo/root"; exit 1; }

if [ -f "$DEST" ]; then
  cp -a "$DEST" "$DEST.bak.$(date +%s)"
  echo "backed up existing $DEST"
fi
mkdir -p /etc/rancher/k3s
cat > "$DEST" <<EOF
mirrors:
  "$REG":
    endpoint:
      - "http://$REG"
configs:
  "$REG":
    tls:
      insecure_skip_verify: true
EOF
echo "wrote $DEST"

# Pick whichever k3s unit this node runs (server vs agent).
if systemctl list-unit-files | grep -q '^k3s\.service'; then UNIT=k3s
elif systemctl list-unit-files | grep -q '^k3s-agent\.service'; then UNIT=k3s-agent
else echo "ERROR: no k3s/k3s-agent unit found"; exit 1; fi

echo "restarting $UNIT (pods keep running) ..."
systemctl restart "$UNIT"
sleep 6
echo "  $UNIT is now: $(systemctl is-active "$UNIT")"

echo "verifying containerd picked up the mirror:"
if grep -RqsF "$REG" /var/lib/rancher/k3s/agent/etc/containerd/ 2>/dev/null; then
  echo "  OK — mirror for $REG present in generated containerd config"
else
  echo "  NOTE: not found yet under .../containerd/ — give k3s a few more seconds,"
  echo "        then: grep -Rs '$REG' /var/lib/rancher/k3s/agent/etc/containerd/"
fi
echo "done on $(hostname)."
