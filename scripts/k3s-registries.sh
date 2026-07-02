#!/usr/bin/env bash
# Point containerd at Harbor's pull-through proxy caches — red-tape item 5
# (home-lab#28). Writes the ONE canonical /etc/rancher/k3s/registries.yaml:
#   - docker.io and ghcr.io pulls are rewritten into harbor.lan's public
#     proxy-cache projects (dockerhub/, ghcr/) — first pull fills the cache,
#     every later pull (any node) is LAN-fast. If harbor.lan is unreachable,
#     containerd falls through to the upstream registry: cache only, no new SPOF.
#   - harbor.lan TLS is pinned to the mkcert CA (also OK via OS store, but
#     explicit survives base-image trust quirks).
# (The legacy in-cluster registry:2 at 192.168.5.173:30500 was decommissioned
# 2026-07-02 — its images live in Harbor now: library/rampart,
# inference-club/nemotron-asr.)
#
# Run ON each node (agents first, a3/server last):
#   scp "$(mkcert -CAROOT)/rootCA.pem" <node>:/tmp/lan-rootCA.pem
#   ssh <node> sudo bash /tmp/k3s-registries.sh
# k3s restart reloads containerd config; running pods are NOT disrupted
# (containerd shims survive the restart).
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "ERROR: run with sudo/root"; exit 1; }

CA_SRC="${1:-/tmp/lan-rootCA.pem}"
[ -f "$CA_SRC" ] || CA_SRC=/usr/local/share/ca-certificates/mkcert-lan.crt
[ -f "$CA_SRC" ] || { echo "ERROR: mkcert CA not found (run trust-lan-ca.sh first)"; exit 1; }

DEST_CA=/etc/rancher/k3s/harbor-rootCA.pem
install -D -m 0644 "$CA_SRC" "$DEST_CA"

REG=/etc/rancher/k3s/registries.yaml
[ -f "$REG" ] && cp -a "$REG" "$REG.bak.$(date +%s)"
cat > "$REG" <<EOF
mirrors:
  docker.io:
    endpoint:
      - "https://harbor.lan"
    rewrite:
      "^(.*)\$": "dockerhub/\$1"
  ghcr.io:
    endpoint:
      - "https://harbor.lan"
    rewrite:
      "^(.*)\$": "ghcr/\$1"
configs:
  "harbor.lan":
    tls:
      ca_file: $DEST_CA
EOF
echo "wrote $REG"

# NB: not `list-unit-files | grep -q` — grep -q's early exit SIGPIPEs
# systemctl and pipefail turns that into a bogus failure.
UNIT=k3s
systemctl cat k3s-agent.service >/dev/null 2>&1 && UNIT=k3s-agent
systemctl restart "$UNIT"
sleep 6
echo "OK on $(hostname): $UNIT $(systemctl is-active "$UNIT")"
