#!/usr/bin/env bash
# Passwordless sudo for brian on cluster nodes — red-tape item 1 (home-lab#28).
# Run ON each node (or via ssh): bash scripts/node-sudoers.sh
# Idempotent. SSH is already key-only, so anyone with the key owns the account
# anyway — this removes the password prompt that blocks unattended node ops
# (apt installs, mkdir on root-owned mounts, systemctl, k3s maintenance).
set -euo pipefail

FILE=/etc/sudoers.d/brian-nopasswd
TMP=$(mktemp)
echo 'brian ALL=(ALL) NOPASSWD:ALL' > "$TMP"

# Validate BEFORE installing — a bad sudoers file can lock you out of sudo.
sudo visudo -cf "$TMP"
sudo install -m 0440 -o root -g root "$TMP" "$FILE"
rm -f "$TMP"

# Prove it took effect in this same run.
sudo -k                       # drop the cached password credential
sudo -n true && echo "OK: passwordless sudo active on $(hostname)"
