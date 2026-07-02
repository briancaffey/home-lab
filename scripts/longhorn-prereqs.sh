#!/usr/bin/env bash
# Host-level prereqs for Longhorn storage members (a2, a3, x1).
# Run ON each member node (or via ssh):  bash scripts/longhorn-prereqs.sh
#
# Installs the iSCSI initiator (Longhorn attaches volumes as iSCSI block
# devices) and the NFS client (RWX volumes mount via the share-manager's NFS
# export). Idempotent — safe to re-run. See docs/16 §prereqs, brian/home-lab#27.
set -euo pipefail

sudo apt-get update -qq
sudo apt-get install -y open-iscsi nfs-common
sudo systemctl enable --now iscsid

# Longhorn validates its disk path but does NOT create it (learned 2026-07-02:
# "failed to get fs stat ... no such file or directory" until mkdir). Paths
# must match the default-disks-config annotations in scripts/longhorn-nodes.sh.
case "$(hostname)" in
  a2) sudo mkdir -p /home/brian/e/longhorn ;;
  a3|a1) sudo mkdir -p /mnt/d/longhorn ;;   # a1's /mnt/d is root-owned
  # spark/x1: inventory-only disks at /var/lib/longhorn (root) — the manager
  # creates that dir itself; nothing to do.
esac

# multipathd grabbing Longhorn devices is a known Ubuntu gotcha; on this fleet
# it is inactive (audited 2026-07-02). Warn if that ever changes.
if systemctl is-active --quiet multipathd; then
  echo "WARNING: multipathd is ACTIVE — blacklist Longhorn devices in /etc/multipath.conf" >&2
  echo '  (blacklist { devnode "^sd[a-z0-9]+" } then: sudo systemctl restart multipathd)' >&2
fi

echo "--- verify ---"
dpkg -s open-iscsi | grep ^Version
dpkg -s nfs-common | grep ^Version
systemctl is-active iscsid
echo "OK: $(hostname) ready for Longhorn"
