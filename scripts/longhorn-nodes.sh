#!/usr/bin/env bash
# Longhorn node membership + disk placement — the single source of truth for
# which nodes participate and where replica data lives.
# Run from any machine with kubectl:  bash scripts/longhorn-nodes.sh
# Idempotent (--overwrite). See docs/16, brian/home-lab#27; consumed by
# clusters/home/longhorn/values.yaml (createDefaultDiskLabeledNodes +
# systemManagedComponentsNodeSelector reference these labels).
#
# Two tiers:
#   REPLICA HOMES (allowScheduling true)  — a2, a3: the big ext4 CMR HDDs.
#   INVENTORY ONLY (allowScheduling false) — a1, spark, x1: disks are visible
#     on the longhorn.lan dashboard (total storage inventory) but Longhorn
#     will never place a replica on them until the flag is flipped here.
#     a1 = SMR HDD + USB WiFi (bulk member later, docs/16 p.3);
#     spark/x1 = root partitions only — display, never storage.
set -euo pipefail

# Members run the longhorn-manager daemonset (= appear on the dashboard).
# NOTE: spark's k8s node name is spark-d2ce (arm64 — Longhorn images are multi-arch).
kubectl label node a2 a3 x1 a1 spark-d2ce inference-club.com/longhorn=member --overwrite

# SYSTEM-managed components (instance-managers, RWX share-managers = each
# volume's NFS server, CSI plugin) are fenced tighter — storage nodes only.
# A node must carry this label to run engines OR to mount Longhorn volumes;
# add x1 here if a pod on x1 ever needs a Longhorn PVC.
kubectl label node a2 a3 inference-club.com/longhorn-system=true --overwrite

# 'config' makes Longhorn read the disk layout from the annotation instead of
# defaulting to /var/lib/longhorn on /. Longhorn stat()s but does NOT create
# the path — scripts/longhorn-prereqs.sh mkdirs the non-root ones.
kubectl label node a2 a3 x1 a1 spark-d2ce node.longhorn.io/create-default-disk=config --overwrite

# Replica homes — never a root partition:
kubectl annotate node a2 node.longhorn.io/default-disks-config=\
'[{"path":"/home/brian/e/longhorn","allowScheduling":true}]' --overwrite
kubectl annotate node a3 node.longhorn.io/default-disks-config=\
'[{"path":"/mnt/d/longhorn","allowScheduling":true}]' --overwrite

# Longhorn node TAGS (not k8s labels): the longhorn-hdd StorageClass pins
# volumes to tag "storage" so engines/attachment AND the RWX share-manager
# (the volume's NFS server) stay on a2/a3 — never spark (other subnet) or a1
# (USB WiFi). Annotation is consumed when the Longhorn node has no tags yet.
kubectl annotate node a2 a3 node.longhorn.io/default-node-tags='["storage"]' --overwrite

# Inventory-only (dashboard visibility; scheduling OFF):
kubectl annotate node a1 node.longhorn.io/default-disks-config=\
'[{"path":"/mnt/d/longhorn","allowScheduling":false}]' --overwrite
kubectl annotate node spark-d2ce node.longhorn.io/default-disks-config=\
'[{"path":"/var/lib/longhorn","allowScheduling":false}]' --overwrite
kubectl annotate node x1 node.longhorn.io/default-disks-config=\
'[{"path":"/var/lib/longhorn","allowScheduling":false}]' --overwrite

echo "--- verify ---"
kubectl get nodes -L inference-club.com/longhorn -L node.longhorn.io/create-default-disk