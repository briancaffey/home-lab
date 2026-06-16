#!/usr/bin/env bash
# Run ON a1/a2/spark with sudo:
#   bash scripts/install-k3s-agent.sh <box-name> <node-token>
set -euo pipefail
BOX="$1"; TOKEN="$2"
curl -sfL https://get.k3s.io | K3S_URL=https://192.168.5.173:6443 K3S_TOKEN="$TOKEN" \
  sh -s - agent --node-label "inference-club.com/box=${BOX}"
