#!/usr/bin/env bash
# Make THIS k3s node trust Harbor's TLS cert (signed by your mkcert CA) so pods
# (and docker/crictl on the node) can pull/push images from https://harbor.lan/.
#
# Run with root ON EACH NODE that runs Harbor workloads or pulls Harbor images:
#   sudo bash trust-harbor-ca.sh [/path/to/rootCA.pem]
# Defaults to /tmp/harbor-rootCA.pem — scp your mkcert root there first:
#   scp "$(mkcert -CAROOT)/rootCA.pem" brian@<node>:/tmp/harbor-rootCA.pem
#
# Restarting k3s is non-disruptive to running pods (containerd shims survive).
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "ERROR: run with sudo/root"; exit 1; }

CA_SRC="${1:-/tmp/harbor-rootCA.pem}"
[ -f "$CA_SRC" ] || { echo "ERROR: CA not found at $CA_SRC (scp it first)"; exit 1; }

# 1) containerd (k3s) registry trust for harbor.lan
DEST_CA=/etc/rancher/k3s/harbor-rootCA.pem
install -D -m 0644 "$CA_SRC" "$DEST_CA"
REG=/etc/rancher/k3s/registries.yaml
[ -f "$REG" ] && cp -a "$REG" "$REG.bak.$(date +%s)"
# NOTE: this (re)writes registries.yaml for harbor.lan only. The built-in
# registry:2 at 192.168.5.173:30500 is being decommissioned; re-add its block
# here if you still need it during migration.
cat > "$REG" <<EOF
configs:
  "harbor.lan":
    tls:
      ca_file: $DEST_CA
EOF
echo "wrote $REG (harbor.lan trusts $DEST_CA)"

# 2) OS trust store (for docker/crictl/curl directly on the node)
if command -v update-ca-certificates >/dev/null; then
  install -m 0644 "$CA_SRC" /usr/local/share/ca-certificates/mkcert-harbor.crt
  update-ca-certificates >/dev/null && echo "installed CA into OS trust store"
fi

# 3) restart the right k3s unit so containerd reloads
UNIT=k3s
systemctl list-unit-files | grep -q '^k3s-agent\.service' && UNIT=k3s-agent
echo "restarting $UNIT ..."
systemctl restart "$UNIT"; sleep 6
echo "  $UNIT: $(systemctl is-active "$UNIT")"
echo "done on $(hostname)."
