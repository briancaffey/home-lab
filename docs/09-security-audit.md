# 09 — Security Audit (home-cluster)

**Date:** 2026-06-30 · **Scope:** the live k3s cluster (4 nodes, `v1.35.5+k3s1`)
and this PUBLIC GitOps repo · **Auditor:** Claude (Opus 4.8) · **Method:** live
`kubectl` posture sweep + full `git log -p` history scan + manifest review.

This is a *home-lab* threat model. The realistic adversaries are: (1) accidental
public exposure / a leaked secret in the public repo, (2) a single compromised
service pivoting to the rest of the flat cluster network, (3) anyone who reaches
the **LAN** or the **tailnet** finding an unauthenticated door, and (4) data loss.
It is **not** a hardened-enterprise checklist — findings are ranked by real risk
*for this setup* and fixes are scoped to a solo operator.

---

## Scorecard

| Severity | Count | Headline |
|---|---|---|
| 🔴 **Critical** | 1 | Headlamp = no-login **cluster-admin**, published on the tailnet |
| 🟠 **High** | 2 | Unauthenticated container **registry**; **Vaultwarden** open signups |
| 🟡 **Medium** | 8 | Flat network, secrets unencrypted at rest, no managed secrets, `:latest`, tailnet-IP leak, no PSA, NodePort sprawl, root containers |
| 🔵 **Low / Expected** | 4 | Privileged GPU/monitoring DaemonSets (justified), Traefik dashboard, no backups, chart provenance |

**Overall posture:** *Reasonable for a LAN-scoped home lab, with a few sharp
edges that are cheap to fix.* The repo hygiene is genuinely good — **no hard
secrets are committed** (`.gitignore` discipline is working). The risk is
concentrated in **exposure** (a couple of powerful, unauthenticated services
reachable beyond where they should be) and **architecture** (one unencrypted
SQLite control plane holding every secret; a flat pod network with no policies).

---

## 🔴 Critical

### C1 — Headlamp runs as no-login `cluster-admin` and is exposed over Tailscale
- **Where:** `clusters/home/headlamp/values.yaml` (`unsafeUseServiceAccountToken: true`,
  `clusterRoleName: cluster-admin`) + `clusters/home/tailscale/ingress-headlamp.yaml`.
  Confirmed live: ClusterRoleBinding `headlamp-admin` → SA `headlamp/headlamp` → `cluster-admin`.
- **What:** Headlamp authenticates every visitor as a pod ServiceAccount bound to
  `cluster-admin`, with **no login prompt**. The values file's own comment says
  "LAN-only" — but the Tailscale Ingress right next to it publishes it at
  `https://headlamp.<tailnet>.ts.net`.
- **Why it matters:** anyone who reaches that tailnet host — any tailnet member, any
  device that ever receives a tagged key, or one ACL slip — gets **full read/write
  control of the entire cluster**, no password. This is the single highest-impact
  finding: it's game-over if reached.
- **Fix (pick one, ~5 min):**
  1. **Easiest:** remove `ingress-headlamp.yaml` from
     `clusters/home/tailscale/kustomization.yaml` → keep Headlamp `.lan`-only.
  2. **Better:** set `clusterRoleName: view` and disable `unsafeUseServiceAccountToken`
     so it's read-only and requires a real token to do anything.
  - Recommended: **both** — `view` by default, and off the tailnet.

---

## 🟠 High

### H1 — Private registry: no auth, plaintext, push **and** pull open on the LAN
- **Where:** `clusters/home/registry/registry.yaml` — NodePort **`30500`**, no
  htpasswd/auth, `tls: { insecure_skip_verify: true }`. Reachable on every node IP.
- **Why it matters:** anyone who can reach a node can **push** images. A poisoned
  image is a direct path to arbitrary code execution on the cluster (every node
  pulls from it). Pull-only would be bad; open push is worse.
- **Fix (~30 min):** add an htpasswd Secret (basic auth) to the registry, and stop
  exposing it past where it's needed (pushes should come from CI, not be open).

### H2 — Vaultwarden allows open signups and is on the tailnet
- **Where:** `clusters/home/vaultwarden/vaultwarden.yaml:79` (`SIGNUPS_ALLOWED: "true"`,
  `SIGNUPS_VERIFY: "false"`) + `clusters/home/tailscale/ingress-vaultwarden.yaml`.
- **Why it matters:** this is the app that stores **every other credential**. Open
  registration means anyone who reaches it can create an account on your vault.
- **Fix (~2 min):** set `SIGNUPS_ALLOWED: "false"` now that your account exists.
  Flip it back on only transiently if you ever need to add a user.

---

## 🟡 Medium

### M1 — No NetworkPolicies anywhere (flat pod network)
- **Live:** `0` NetworkPolicies across all 28 namespaces. Any pod can talk to any
  service in any namespace.
- **Why it matters:** if one service is compromised (say a `:latest` third-party
  image), nothing stops it from reaching Vaultwarden's DB, the registry, MinIO, or
  the Postgres instances. Blast radius = the whole cluster.
- **Fix:** you don't need a mesh. Start with **default-deny + explicit allow** on
  the 2–3 crown jewels (vaultwarden, registry, the platform Postgres). k3s ships
  with a policy-capable CNI; a handful of small NetworkPolicies goes a long way.

### M2 — Cluster secrets are unencrypted at rest on a single SQLite control plane
- **Context:** a3 is the sole control plane on **SQLite** (not encrypted by default).
  Every Kubernetes Secret — DB passwords, the LiteLLM master key, TLS keys,
  Vaultwarden's — sits base64-only in that one file.
- **Why it matters:** whoever gets a3's disk or a raw DB backup gets **all** secrets.
  And it's a single point of failure for the API.
- **Fix:** enable k3s secrets-encryption (`k3s secrets-encrypt …`, verify with
  `k3s secrets-encrypt status` on a3). This pairs naturally with the planned
  HA/etcd migration — see the upcoming storage+HA plan.

### M3 — No managed-secret mechanism (purely out-of-band)
- Secrets are injected via `secretKeyRef` / `helm --set` / `kubectl create secret`.
  There is **no** Sealed Secrets / External Secrets / SOPS.
- **Why it matters:** great for leak-prevention (nothing's in the public repo), but
  the cluster's secrets live *only* in live SQLite and your head. A node loss = manual
  reconstruction; the GitOps repo is not actually reproducible.
- **Fix:** **Sealed Secrets** is the lowest-effort fit — encrypted secrets become
  safe to commit, restoring full reproducibility. Already on your roadmap; this audit
  bumps its priority.

### M4 — Pervasive `:latest` / untagged images (16 of 70 distinct images)
- e.g. `jellyfin:latest`, `minio/minio:latest`, `qdrant:latest`, `searxng:latest`,
  the `minio/mc:latest` fan-out jobs, the NIM images; and
  `clusters/home/invokeai/invokeai.yaml:37` has **no tag at all** (→ `latest`).
- **Why it matters:** non-reproducible deploys; a re-pull can silently change (or
  pull a compromised) image; rollback is impossible.
- **Fix:** pin a version tag (or digest) per image and bump deliberately. Start with
  the internet-facing / third-party ones.

### M5 — Tailnet `100.x` IPs committed to a public repo
- **Where:** `docs/07-remote-desktop-vnc.md:19-22` lists real tailnet IPs
  (`100.x.x.x`) pointing at unencrypted VNC ports. CLAUDE.md explicitly lists
  tailnet `100.x` IPs as **NOT OK** to commit. (The MagicDNS suffix is *not* leaked — good.)
- **Why it matters:** it's the repo's own stated red line; topology disclosure in a
  public repo. Not directly exploitable (CGNAT, tailnet-only) but it should be scrubbed.
- **Fix:** replace the IP column with node names / `<tailnet>` placeholders.

### M6 — No Pod Security Admission baseline on any namespace
- **Live:** none of the 28 namespaces carry `pod-security.kubernetes.io/*` labels.
- **Why it matters:** there's no guardrail stopping a future manifest from running
  privileged / hostPath by accident. Today it's fine; it's a missing safety net.
- **Fix:** label app namespaces `pod-security.kubernetes.io/enforce: baseline` (leave
  the GPU/monitoring namespaces — `kube-system`, `monitoring`, `netdata`, `nfd`,
  `inference-club` — at `privileged`, since they legitimately need it).

### M7 — NodePort sprawl: 14 services reachable on every node IP
- grafana `30030`, prometheus `30090`, registry `30500`, litellm `30400`, minio
  `30900/30901`, qdrant, browserless `30330`, searxng, immich, jellyfin, navidrome,
  excalidraw, studio-voice. Several (**prometheus, minio, litellm**) are
  unauthenticated or hold powerful keys.
- **Why it matters:** large exposure surface gated only by "the LAN/tailnet is
  trusted." LiteLLM `30400` fronts a master key; Prometheus `30090` leaks infra
  metrics; MinIO console is open.
- **Fix:** prefer `.lan`/Tailscale Ingress (auth + TLS) over raw NodePorts; drop the
  NodePort once a service has an Ingress (you just did this for Phoenix). Keep
  NodePorts only where a non-HTTP client truly needs them.

### M8 — Most workloads run as root with no `securityContext`
- ~10 of ~44 workloads set any `securityContext`; only 4 set `runAsNonRoot`. A few
  are explicitly root: `clusters/home/monitoring/vram-reporter.yaml:101`,
  `services/magpie-tts/magpie-tts.yaml:58` (`runAsUser: 0`).
- **Why it matters:** a container escape from any of these starts as root — thin
  defense-in-depth.
- **Fix:** add `runAsNonRoot` + `seccompProfile: RuntimeDefault` where the image
  allows. Lowest priority on an isolated LAN; cheap to add on *new* services going forward.

---

## 🔵 Low / Expected (noted, not alarming)

- **L1 — Privileged & host-level DaemonSets, all justified:** `gpu-feature-discovery`
  (`privileged`), `dcgm-exporter` (`SYS_ADMIN`), `node-exporter` (`hostNetwork`+
  `hostPID`+host `/`,`/proc`,`/sys`), `vram-reporter` (`hostPID`), `nvidia-device-plugin`,
  `promtail`, `nfd-worker`, `netdata-child`. Standard for GPU/node telemetry — but
  these are the **highest-value escape targets**, so keep them scoped to their
  monitoring/system namespaces and don't add more.
- **L2 — Traefik dashboard enabled** (`--api.dashboard=true`) but **not routed
  externally** — no IngressRoute exposes it. Low risk; don't add one.
- **L3 — No backups.** Not a confidentiality issue but an integrity/availability one:
  a single a3 disk failure loses Paperless, Grafana, Phoenix, and the control plane.
  Covered by the separate storage+HA plan; `k8up` → MinIO is the cheap first step.
- **L4 — Helm charts version-pinned** (harbor, headlamp, homepage, loki, open-webui)
  from official repos, re-pulled into a gitignored `charts/`. No digest/provenance
  verification, but version-pinning is reasonable here.

---

## Do-this-week quick wins (highest value / lowest effort)

1. **[C1]** Take Headlamp off the tailnet **and** set `clusterRoleName: view`. *(~5 min)*
2. **[H2]** `SIGNUPS_ALLOWED: "false"` on Vaultwarden, re-apply. *(~2 min)*
3. **[H1]** Add htpasswd auth to the registry. *(~30 min)*
4. **[M5]** Scrub the tailnet `100.x` IPs from `docs/07-remote-desktop-vnc.md`. *(~5 min)*

Each of these has a Forgejo issue in **`brian/home-lab`**.

## Next projects (do after the quick wins — and they line up with your roadmap)

- **Sealed Secrets** (M3) — makes the GitOps repo truly reproducible; pick this as the
  next "stand up a real piece of infra" project.
- **k3s secrets-encryption + HA/etcd migration** (M2) — fold into the storage+HA plan.
- **A handful of NetworkPolicies** (M1) — default-deny on vaultwarden / registry / Postgres.
- **Pin `:latest` images** (M4) — incremental; do a few per session.
- **`k8up` backups → MinIO** (L3) — the reliability win from the earlier project menu.

---

## Appendix — raw evidence

- **Nodes:** a1, a2, a3, spark-d2ce — all `Ready`, `v1.35.5+k3s1`.
- **`cluster-admin` subjects:** `system:masters` (normal), `headlamp/headlamp` (**C1**),
  traefik helm install SAs (normal).
- **NodePorts (14):** immich `30283`, studio-voice `30080`, jellyfin `30096`,
  browserless `30330`, excalidraw `30505`, searxng `30808`, grafana `30030`,
  prometheus `30090`, navidrome `30533`, litellm `30400`, minio `30900/30901`,
  qdrant `30633/30575`, registry `30500`.
- **NetworkPolicies:** 0. **PSA-labelled namespaces:** 0. **Custom over-broad RBAC:** none.
- **`:latest`/untagged images:** 16 of 70 distinct.
- **No committed secrets** found in current tree or full git history.
