# Longhorn — replicated block storage — MANAGED BY ARGO CD (home-longhorn)

Since 2026-07-07 the chart is an Argo multi-source Application (upstream
longhorn@1.12.0 + values.yaml here + ingress/storageclass). **Never
`helm upgrade` longhorn again** — bump `targetRevision` in
clusters/home/argocd/apps/home-services.yaml via a reviewed PR (Renovate
gates these behind dashboard approval). selfHeal is OFF: syncs happen on
commits only. Steps 1–2 below (host prereqs, node membership) remain
manual/scripted and are NOT chart concerns.

Everything needed to stand Longhorn up (or rebuild it from scratch) lives in
this repo. No tribal knowledge: three steps, all committed.

- **Plan of record:** `docs/16-longhorn-toe-dip.pdf` (full lifecycle) ·
  **theory:** `docs/13-longhorn-replicated-storage.pdf` · **ticket:** brian/home-lab#27
- **Scope (toe-dip):** members a2 + a3 + x1; replica disks ONLY on a2/a3's big
  ext4 CMR HDDs — never a root partition. x1 attaches volumes but holds no
  data. a1 and spark run zero Longhorn pods. `local-path` stays the default
  StorageClass.

## Deploy (in order, all idempotent)

```sh
# 1 · host prereqs on each member (iSCSI initiator + NFS client):
for h in a2 a3 x1; do ssh $h 'bash -s' < scripts/longhorn-prereqs.sh; done

# 2 · node membership labels + disk-placement annotations:
bash scripts/longhorn-nodes.sh

# 3 · the Helm release (NEVER kubectl apply — same rule as homepage, see CLAUDE.md):
helm upgrade --install longhorn longhorn \
  --repo https://charts.longhorn.io --version 1.12.0 \
  -n longhorn-system --create-namespace \
  -f clusters/home/longhorn/values.yaml

# 4 · UI at https://longhorn.lan (mint the cert once, then the ingress):
bash scripts/lan-certs.sh          # longhorn.lan is in its HOSTS/SECRETS lists
kubectl apply -f clusters/home/longhorn/ingress.yaml
```

## Verify

```sh
kubectl -n longhorn-system get pods -o wide          # nothing on a1/spark
kubectl get sc                                       # longhorn exists, local-path still (default)
kubectl get nodes.longhorn.io -n longhorn-system     # a2+a3 with disks, x1 without
```

UI → Node tab: **2 schedulable nodes** (a2, a3), disks under
`/home/brian/e/longhorn` and `/mnt/d/longhorn`.

## Gotchas

- ⚠️ **The UI has no auth** and can delete volumes. LAN-only — no Tailscale
  ingress. Basic-auth middleware is a follow-up on #27.
- **Helm release, not kustomize.** `kubectl apply` of rendered chart YAML puts
  namespaceless objects in `default` and fights the release (see CLAUDE.md).
- Disk layout changes (new drive, new node) go in `scripts/longhorn-nodes.sh`,
  not ad-hoc kubectl — keep that script the single source of truth.
- Replication rides the LAN, which is currently **all WiFi** (audited
  2026-07-02 — every ethernet NIC is unplugged). Fine for write-once/read-many
  volumes; wire the members before write-heavy replicated workloads.
