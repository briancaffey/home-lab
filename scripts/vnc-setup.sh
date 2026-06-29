#!/usr/bin/env bash
# Reliable remote desktop for a homelab node: a PERSISTENT TigerVNC virtual
# desktop (Xfce) on display :1 (port 5901), managed by systemd, reachable over
# LAN *and* Tailscale. Independent of the physical monitor / Wayland / GDM, so it
# "just works" and your session resumes exactly where you left off on reconnect.
#
# Run ON each node with sudo (it needs a TTY for the sudo + VNC-password prompts):
#   scp scripts/vnc-setup.sh <node>:/tmp/ && ssh -t <node> 'sudo bash /tmp/vnc-setup.sh'
#
# Idempotent: re-running keeps an existing ~/.vnc/passwd and just reconciles config.
set -euo pipefail

RUNUSER="${SUDO_USER:-$USER}"
HOMEDIR="$(getent passwd "$RUNUSER" | cut -d: -f6)"
DISP=1
PORT=$((5900 + DISP))
GEOMETRY="${VNC_GEOMETRY:-1920x1080}"

[ "$(id -u)" -eq 0 ] || { echo "Please run with sudo."; exit 1; }
echo "==> TigerVNC virtual desktop for '$RUNUSER' on $(hostname), display :$DISP (port $PORT)"

echo "==> Installing TigerVNC + Xfce (idempotent)"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq tigervnc-standalone-server tigervnc-common xfce4 xfce4-terminal dbus-x11

echo "==> Removing any old/failed x11vnc service (the unreliable Wayland-incompatible path)"
systemctl disable --now x11vnc.service 2>/dev/null || true

echo "==> Mapping display :$DISP -> $RUNUSER in /etc/tigervnc/vncserver.users"
mkdir -p /etc/tigervnc
touch /etc/tigervnc/vncserver.users
sed -i "/^:$DISP=/d" /etc/tigervnc/vncserver.users
echo ":$DISP=$RUNUSER" >> /etc/tigervnc/vncserver.users

echo "==> Writing ~/.vnc/config (Xfce session, $GEOMETRY, listen on all interfaces)"
install -d -o "$RUNUSER" -g "$RUNUSER" "$HOMEDIR/.vnc"
cat > "$HOMEDIR/.vnc/config" <<EOF
session=xfce
geometry=$GEOMETRY
localhost=no
alwaysshared
EOF
chown "$RUNUSER:$RUNUSER" "$HOMEDIR/.vnc/config"

echo "==> VNC password"
if [ ! -s "$HOMEDIR/.vnc/passwd" ]; then
  echo "    No password set yet — enter one now (it's the VNC connect password)."
  echo "    When asked 'view-only password', you can answer n."
  sudo -u "$RUNUSER" vncpasswd "$HOMEDIR/.vnc/passwd"
else
  echo "    Keeping existing ~/.vnc/passwd (run 'vncpasswd' as $RUNUSER to change it)."
fi
chmod 600 "$HOMEDIR/.vnc/passwd"; chown "$RUNUSER:$RUNUSER" "$HOMEDIR/.vnc/passwd"

echo "==> Enabling + starting tigervncserver@:$DISP"
systemctl daemon-reload
systemctl enable --now "tigervncserver@:$DISP"
sleep 2

echo
echo "==> Status:"
systemctl --no-pager --full status "tigervncserver@:$DISP" 2>/dev/null | sed -n '1,4p' || true
echo "==> Listening sockets on :$PORT:"
ss -tlnp 2>/dev/null | grep ":$PORT " || echo "    (not listening yet — check 'journalctl -u tigervncserver@:$DISP')"
echo
echo "==> DONE. Connect from your Mac's VNC viewer:"
echo "      LAN:        $(hostname):$PORT"
TSIP="$(sudo -u "$RUNUSER" tailscale ip -4 2>/dev/null | head -1 || true)"
[ -n "$TSIP" ] && echo "      Tailscale:  $TSIP:$PORT   (encrypted; prefer this)" || \
  echo "      Tailscale:  (node is logged out of Tailscale — run 'sudo tailscale up')"
echo "    Persistent: disconnect/reconnect resumes exactly where you left off."
echo "    (Reboot resets the session; the service auto-starts a fresh desktop.)"
