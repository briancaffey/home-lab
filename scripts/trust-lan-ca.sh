#!/usr/bin/env bash
# Trust fabric for .lan on a node — red-tape item 2 (home-lab#28).
# Two halves, both idempotent:
#   1. TLS trust : install the mkcert root CA into the OS trust store, so
#      curl/wget/apt-level tools on the node accept https://<svc>.lan.
#   2. DNS       : systemd-resolved split-DNS drop-in routing ONLY the `lan`
#      domain to Pi-hole (192.168.5.96, hostPort on a2). Pi-hole down means
#      .lan breaks but general DNS keeps working — deliberate blast-radius cap.
#
# Run ON each node (Ubuntu/DGX OS, needs systemd-resolved):
#   scp "$(mkcert -CAROOT)/rootCA.pem" <node>:/tmp/lan-rootCA.pem
#   ssh <node> sudo bash /tmp/trust-lan-ca.sh
# Container-image pulls (containerd) trust harbor.lan separately via
# trust-harbor-ca.sh — this script covers node-level tools only.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "ERROR: run with sudo/root"; exit 1; }

CA_SRC="${1:-/tmp/lan-rootCA.pem}"
PIHOLE_IP="${PIHOLE_IP:-192.168.5.96}"
[ -f "$CA_SRC" ] || { echo "ERROR: CA not found at $CA_SRC (scp it first)"; exit 1; }

# 1) OS trust store
install -m 0644 "$CA_SRC" /usr/local/share/ca-certificates/mkcert-lan.crt
update-ca-certificates >/dev/null
echo "installed mkcert CA into OS trust store"

# 2) split DNS: lan -> Pi-hole, everything else untouched
install -d /etc/systemd/resolved.conf.d
cat > /etc/systemd/resolved.conf.d/lan.conf <<EOF
# .lan -> Pi-hole (home-lab#28 item 2). Managed by scripts/trust-lan-ca.sh.
[Resolve]
DNS=$PIHOLE_IP
Domains=~lan
EOF
systemctl restart systemd-resolved
echo "routed ~lan to $PIHOLE_IP via systemd-resolved"

# 3) prove both layers end-to-end in this same run. home.lan must be an
# EXPLICIT SAN in the cert (single-label wildcard *.lan is never honored —
# see the NOTE in lan-certs.sh).
getent hosts home.lan >/dev/null || { echo "FAIL: .lan does not resolve"; exit 1; }
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 https://home.lan/) \
  || { echo "FAIL: TLS to https://home.lan not trusted"; exit 1; }
echo "OK on $(hostname): home.lan resolves, TLS trusted (HTTP $code)"
