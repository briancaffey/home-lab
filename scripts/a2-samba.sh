#!/usr/bin/env bash
# Samba share of a2's big disks so the Mac (or any device) mounts them like a
# normal drive: Finder → ⌘K → smb://192.168.5.96 (user brian, password in
# Vaultwarden: `samba-brian`). Shares are read-write for brian only, no guest.
#
# Run ON a2:  sudo bash a2-samba.sh
# Then set the Samba password once (piped, not argv):
#   printf '%s\n%s\n' "$PW" "$PW" | sudo smbpasswd -s -a brian
# Idempotent: rewrites only the managed include file, never smb.conf itself
# (beyond ensuring the include line exists).
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "ERROR: run with sudo/root"; exit 1; }

command -v smbd >/dev/null || { apt-get update -qq && apt-get install -y -qq samba; }

SHARES=/etc/samba/homelab-shares.conf
cat > "$SHARES" <<'EOF'
# Managed by scripts/a2-samba.sh (home-cluster repo). Do not edit in place.
[downloads]
   path = /home/brian/e/downloads
   valid users = brian
   read only = no
   browseable = yes

[e]
   path = /home/brian/e
   valid users = brian
   read only = no
   browseable = yes

[media]
   path = /home/brian/media
   valid users = brian
   read only = no
   browseable = yes
EOF

grep -q "include = $SHARES" /etc/samba/smb.conf || {
  cp -a /etc/samba/smb.conf "/etc/samba/smb.conf.bak.$(date +%s)"
  printf '\ninclude = %s\n' "$SHARES" >> /etc/samba/smb.conf
}

testparm -s >/dev/null 2>&1 || { echo "ERROR: smb.conf invalid"; exit 1; }
systemctl enable --now smbd >/dev/null
systemctl restart smbd
echo "OK on $(hostname): smbd $(systemctl is-active smbd), shares: downloads, e, media"
