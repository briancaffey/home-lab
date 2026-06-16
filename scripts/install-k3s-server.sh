#!/usr/bin/env bash
# Run ON a3 with sudo: bash scripts/install-k3s-server.sh
# Server + workloads node. Docker containers on the box are untouched
# (k3s uses its own embedded containerd).
set -euo pipefail
curl -sfL https://get.k3s.io | sh -s - server \
  --write-kubeconfig-mode 644 \
  --node-label inference-club.com/box=a3
echo "--- node token (agents join with this): ---"
cat /var/lib/rancher/k3s/server/node-token
