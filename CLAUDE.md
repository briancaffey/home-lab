# CLAUDE.md — home-lab working context

Context and conventions for working in this repo. Read this before acting on
general home-lab requests. (Cross-tool note: this is the Claude-native file;
symlink `AGENTS.md → CLAUDE.md` if you also use other agents.)

## What this is
Brian's home cluster: a GPU inference fleet **and** a growing set of self-hosted
services, all on **k3s**. Four Ubuntu boxes on one LAN, registered to
inference.club via the `inference-club-agent`. The repo is the source of truth
for everything that runs on the cluster.

**⚠️ This repository is PUBLIC.** Never commit secrets or environment-specific
private values (see "Secrets & privacy").

## Cluster topology
| node  | LAN IP        | tailnet role | arch  | GPU              | k3s role |
|-------|---------------|--------------|-------|------------------|----------|
| a3    | 192.168.5.173 | online       | amd64 | RTX 4090         | **server (sole control plane)** + workloads |
| a1    | 192.168.5.253 | online       | amd64 | RTX 4090         | agent |
| a2    | 192.168.5.96  | online       | amd64 | RTX 4090         | agent |
| spark | 192.168.6.19  | (often offline) | arm64 | DGX Spark GB10 (128 GB unified) | agent |

Node selector convention: pin pods with `nodeSelector: { inference-club.com/box: <a1|a2|a3|spark> }`.

**Known constraints (factor these into recommendations):**
- **a3 is the only control plane**, on **SQLite** (not HA etcd) — single point of
  failure for the API. HA (3-server embedded etcd) is a known future step.
- **a1 has flaky USB WiFi** (no wired link): it corrupts multi-GB image pulls and
  is a poor fit for network-heavy roles (etcd, storage replication).
  **Build images elsewhere, not on a1.**
- **a2 GPU** has periodically hit an NVML driver mismatch (needs reboot) — dcgm
  is scoped to a1+a3 for that reason.
- **spark** is arm64 + on a different subnet (192.168.6.x); keep it as an agent,
  not a control-plane/etcd/storage member.

## Repo layout
- `clusters/home/<service>/` — LAN / cluster services (Homepage, Grafana, Jellyfin,
  Harbor, Tailscale operator ingresses, monitoring, etc.). Aggregated by
  `clusters/home/kustomization.yaml`.
- `services/<name>/` — AI inference workloads (vLLM models, flux2, ltx2, dia,
  nemotron-*, etc.).
- `observability/`, `platform/`, `mcp/` — gateway/data layer, observability,
  MCP backends.
- `scripts/` — helpers (e.g. `scripts/lan-certs.sh` mints the mkcert `home-tls`
  wildcard cert). `docs/` — guides incl. `docs/05-service-directory.md`.

## How services are deployed & exposed
- **Two deploy mechanisms coexist — know which a service uses:**
  - **kustomize** (most things): `kubectl apply -k clusters/home/<svc>`, or for
    charts inflated via kustomize `helmCharts`, use the **standalone** kustomize:
    `kustomize build --enable-helm <dir> | kubectl apply -n <ns> -f -`.
  - **Helm releases** (e.g. **homepage**): apply with `helm upgrade`, **never**
    `kubectl apply`. See "Gotchas".
- **LAN access:** each web UI gets a Traefik ingress at `https://<name>.lan/` with
  the mkcert `home-tls` wildcard cert (`*.lan`). Add `gethomepage.dev/*`
  annotations on the ingress so Homepage auto-discovers it.
- **Remote access (Tailscale):** the Tailscale Kubernetes operator exposes select
  services at `https://<name>.<tailnet>.ts.net` (trusted Let's Encrypt certs,
  tailnet-only). One Ingress per service in `clusters/home/tailscale/` with
  `ingressClassName: tailscale` and `tls.hosts: [<short-name>]` (operator appends
  the suffix). Each = one proxy pod + one tagged tailnet device — expose only the
  handful you actually want remote, not everything.
- **Homepage** is the dashboard/front door (auto-discovers `.lan` ingresses; a
  static "Tailnet" group provides the `*.ts.net` links).
- **Tailnet ACL is default-deny.** Reaching the *nodes* over their tailnet IPs
  (NodePort services, SSH, host VNC) requires an explicit grant —
  `autogroup:member -> autogroup:member` is in place for device-to-device access;
  the operator proxies use a `tag:k8s` grant. `tailscale ping` can succeed while
  TCP is still ACL-blocked, so test with an actual `nc <tailnet-ip> <port>`.

## GPU conventions
- GPU pods set `runtimeClassName: nvidia` (RuntimeClass in `clusters/home/gpu/`).
- NFD + gpu-feature-discovery publish `nvidia.com/gpu.*` node labels.
- **No time-slicing/MPS.** Two sharing patterns:
  - **Exclusive:** `resources.limits["nvidia.com/gpu"]: 1` — one pod owns a GPU.
  - **Shared/unmanaged:** `NVIDIA_VISIBLE_DEVICES=all` with **no** `nvidia.com/gpu`
    request — multiple pods share a GPU; the scheduler is blind to contention
    (accounted for out-of-band by the `vram-reporter`).

## Storage
- **`local-path`** (node-local disk) only. PVCs are therefore **pinned to a node**
  via `nodeSelector` (e.g. Grafana/Prometheus on a3). No mobility, no redundancy.
- **No replicated storage and no NAS yet.** Free disk: a2 ~527 GB, a3 ~75 GB,
  a1 ~49 GB (small). Longhorn (2-replica on a2+a3 to start) is the planned next
  step for redundancy/mobility — see the bin-packing goal.

## Secrets & privacy (PUBLIC repo)
- **Never commit secrets or personal/sensitive data.** No passwords, tokens, API
  keys, OAuth client secrets, bearer/claim tokens (`tskey-…`), TLS private keys
  (`BEGIN … PRIVATE KEY`), kubeconfigs, or personal info (emails, etc.).
  `.gitignore` covers `*.env`, `.env*`, `*secret*.yaml`, `*-secret.yaml`,
  `*.key/.pem/.crt`, `*kubeconfig*`, and `*.local.yaml`.
- **OK to commit:** private LAN IPs (`192.168.x`) and node names — already in the
  README. **NOT OK:** the tailnet MagicDNS suffix and tailnet `100.x` IPs.
- Credentials (e.g. the Tailscale OAuth client) go in via `helm --set` or
  in-cluster secrets, never files. TLS secrets are created in-cluster by
  `scripts/lan-certs.sh` (private keys never touch the repo). Future: adopt
  Sealed Secrets / External Secrets so secrets can be safely committed.
- **Keep the tailnet name out of committed files.** The MagicDNS suffix lives
  only in gitignored `*.local.yaml` overlays (committed `*.local.yaml.example`
  templates use a `<your-tailnet>` placeholder). In docs/manifests use
  `<tailnet>.ts.net`.
- **Before every commit, scan the staged diff** for leaks — e.g.
  `git diff --cached | grep -niE 'tailb|PRIVATE KEY|tskey-|BEGIN .*KEY|password:|token:'`
  — and confirm nothing sensitive is staged.

## Gotchas (learned the hard way)
- **`kubectl kustomize --enable-helm` is broken with Helm v4** (it calls the v3
  `helm version -c`). Use the **standalone `kustomize` v5** binary instead.
- **There are NO helm-CLI releases anymore** (since 2026-07-07). Everything
  that was helm-CLI (homepage, netdata, longhorn) is an **Argo CD multi-source
  Application** — edit values in git and push; `helm upgrade` anywhere is
  WRONG and helm's bookkeeping secrets are gone. Longhorn is the most
  protected app: selfHeal off, chart bumps gated behind Renovate dashboard
  approval (`storage-ceremony` label), node membership/disk placement in
  `scripts/longhorn-nodes.sh`. Homepage's tailnet bits arrive via the
  out-of-band `homepage-tailnet` Secret ({{HOMEPAGE_VAR_TAILNET}} placeholders
  in committed values); the tailnet name is in Vaultwarden (`tailnet-name`).
- **Homepage host validation:** any host serving Homepage must be in
  `HOMEPAGE_ALLOWED_HOSTS` or it returns "Host validation failed".
- **Monitoring is hand-rolled** (`clusters/home/monitoring/`): plain Prometheus
  with **static_configs** (no Operator/ServiceMonitors) + Grafana with
  file-provisioned dashboards (add JSON to `dashboards/` + the
  `grafana-dashboards` configMapGenerator, then rollout restart). dcgm-exporter
  (a1+a3) + node-exporter (all) + a custom `vram-reporter` (per-pod GPU VRAM).
- **Image builds** go through the `inference-club-agent` repo's CI → GHCR (push to
  its `main` triggers a multi-arch build). Don't build on a1. App images
  (GitOps loop) are built by the in-cluster Forgejo Actions runner
  (`clusters/home/forgejo/runner/`, dind on a2) and pushed to `harbor.lan/apps/`
  — these are **amd64-only**, so pin consumers off spark
  (`kubernetes.io/arch: amd64`).
- **Argo CD** (`clusters/home/argocd/`, https://argocd.lan): apply with
  `kubectl apply -k --server-side` (CRDs too big for client-side), then re-run
  `scripts/lan-certs.sh` — every apply **resets `argocd-tls-certs-cm`** (the
  mkcert CA for cloning forgejo.lan) to upstream's empty version. Application
  CRs live in `clusters/home/argocd/apps/` (applied separately). Webhook:
  Forgejo → `http://argocd-server.argocd.svc.cluster.local/api/webhook`
  (needs `FORGEJO__webhook__ALLOWED_HOST_LIST=private`).
- **In-cluster `*.lan` DNS** comes from `clusters/home/coredns/` (coredns-custom
  forwards the `lan` zone to Pi-hole). Pods could NOT resolve `.lan` before
  that existed — remember it when a pod can't reach forgejo.lan/harbor.lan.

## Working style / preferences
- **Goal: bin-packing** — maximize service density; move workloads to nodes with
  headroom. Reliability hardening (HA control plane, Longhorn, backups, secrets
  mgmt) is on the roadmap.
- Learning-oriented: Brian likes standing up real infrastructure pieces and
  understanding them; **opinionated, ranked recommendations are welcome** (lead
  with a clear pick, not an exhaustive survey).
- Privacy-conscious about the public repo (tailnet name, secrets).
- Confirm before committing/pushing; prefer clean, logically-grouped commits.
