#!/usr/bin/env bash
# Static /etc/hosts entries for cluster-critical .lan names — home-lab#43.
# Lesson from the 2026-07-07 pihole-upgrade incident: image pulls resolve
# harbor.lan via node split-DNS -> Pi-hole, so a pihole outage (including
# pihole's OWN upgrade, which kills the pod before pulling the new image)
# deadlocks every image pull on the .lan path. /etc/hosts wins before DNS,
# breaking the loop. 192.168.5.173 = Traefik ingress (served on every node).
# Idempotent managed block. Run ON each node: sudo bash node-hosts.sh
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "ERROR: run with sudo/root"; exit 1; }
START="# BEGIN home-lab managed hosts"; END="# END home-lab managed hosts"
sed -i "/$START/,/$END/d" /etc/hosts
cat >> /etc/hosts <<HOSTS
$START
192.168.5.173 harbor.lan
$END
HOSTS
getent hosts harbor.lan >/dev/null && echo "OK on $(hostname): harbor.lan -> $(getent hosts harbor.lan | awk '{print $1}')"
