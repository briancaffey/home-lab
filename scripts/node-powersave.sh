#!/usr/bin/env bash
# Keep cluster nodes awake and on the network — red-tape item 6 (home-lab#28).
# x1 went offline mid-operation on 2026-07-02 (sleep or WiFi powersave); on a
# WiFi-only cluster, powersave also adds latency to everything. Idempotent.
#   1. Mask every sleep/suspend path (systemd targets + logind lid/idle —
#      x1 is a laptop, closing its lid must not suspend it).
#   2. WiFi power_save off, live (iw) and persistently (NetworkManager
#      drop-in: wifi.powersave=2 means "disable").
#
# Run ON each node: sudo bash node-powersave.sh
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "ERROR: run with sudo/root"; exit 1; }

# 1) no sleeping
systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target >/dev/null 2>&1
install -d /etc/systemd/logind.conf.d
cat > /etc/systemd/logind.conf.d/nosleep.conf <<'EOF'
# Managed by scripts/node-powersave.sh (home-lab#28 item 6).
[Login]
HandleLidSwitch=ignore
HandleLidSwitchExternalPower=ignore
HandleLidSwitchDocked=ignore
IdleAction=ignore
EOF
systemctl restart systemd-logind
echo "sleep targets masked, lid/idle ignored"

# 2) WiFi power_save off (skip cleanly on a wired-only node)
WIFI=""
for d in /sys/class/net/*; do
  [ -d "$d/wireless" ] && WIFI=$(basename "$d") && break
done
if [ -n "$WIFI" ]; then
  cat > /etc/NetworkManager/conf.d/wifi-powersave-off.conf <<'EOF'
# Managed by scripts/node-powersave.sh (home-lab#28 item 6). 2 = disable.
[connection]
wifi.powersave = 2
EOF
  nmcli general reload conf 2>/dev/null || true
  # Apply live without touching the active connection (we're on this link).
  command -v iw >/dev/null || { apt-get install -y -qq iw >/dev/null; }
  iw dev "$WIFI" set power_save off
  echo "WiFi power_save on $WIFI: $(iw dev "$WIFI" get power_save)"
else
  echo "no WiFi interface — skipped powersave config"
fi

echo "OK on $(hostname)"
