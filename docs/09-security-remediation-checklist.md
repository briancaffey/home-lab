# 09 — Security Remediation Checklist

Companion to [`09-security-audit.md`](09-security-audit.md). A living tracker —
check items off as you go. Immediate fixes (🔴/🟠 + M5) have **Forgejo issues** in
`brian/home-lab`.

## This week (urgent — has a Forgejo issue)

- [ ] **C1 — Headlamp lockdown.** Remove `ingress-headlamp.yaml` from
  `clusters/home/tailscale/kustomization.yaml`; set `clusterRoleName: view` +
  `unsafeUseServiceAccountToken: false` in `clusters/home/headlamp/values.yaml`;
  re-apply. _Verify:_ `headlamp.<tailnet>.ts.net` no longer resolves to a proxy; UI
  is read-only.
- [ ] **H2 — Vaultwarden signups off.** `SIGNUPS_ALLOWED: "false"` in
  `clusters/home/vaultwarden/vaultwarden.yaml`; `kubectl apply`. _Verify:_ the
  register page is gone.
- [x] **H1 — Registry auth.** Resolved by decommissioning (2026-07-02,
  home-lab#28): the unauthenticated registry:2 is gone; images live in Harbor
  (push requires auth). _Verify:_ `curl 192.168.5.173:30500` refuses.
- [x] **M5 — Scrub tailnet IPs.** Done 2026-07-07: docs/07 now uses
  `<node>.<tailnet>.ts.net` placeholders; repo-wide grep for CGNAT 100.x clean.
  History NOT rewritten (public-repo force-push breaks mirror/clones); the IPs
  are CGNAT-unroutable + tailnet ACL is default-deny — rotate the nodes'
  tailnet IPs if paranoia warrants, cheaper than history surgery.

## Soon (projects — fold into the roadmap)

- [ ] **M3 — Sealed Secrets.** Install the controller; convert existing Secrets to
  `SealedSecret` CRDs so they can live in the repo. Makes GitOps reproducible.
- [ ] **M2 — Secrets-encryption + HA.** `k3s secrets-encrypt enable` on a3 (check
  `status` first); plan the etcd/HA migration in the storage+HA doc.
- [ ] **M1 — NetworkPolicies.** Default-deny + explicit-allow on `vaultwarden`,
  `registry`, `platform` (Postgres/MinIO) namespaces first.
- [ ] **M7 — Trim NodePorts.** Move HTTP services to `.lan`/Tailscale Ingress; delete
  the NodePort once an Ingress exists (Phoenix is the template).
- [ ] **L3 — Backups.** `k8up` → MinIO for the stateful PVCs (Paperless, Grafana,
  Phoenix-Postgres, Forgejo, Vaultwarden).

## Background (incremental / low priority)

- [ ] **M4 — Pin `:latest` images** — a few per session; internet-facing first.
- [ ] **M6 — PSA labels** — `enforce: baseline` on app namespaces; leave GPU/monitoring
  namespaces `privileged`.
- [ ] **M8 — securityContext** — add `runAsNonRoot` + `seccompProfile: RuntimeDefault`
  to new services as you add them.

## Verification one-liners

```bash
# C1 — no cluster-admin binding left for headlamp after downgrade
kubectl get clusterrolebindings -o json | jq -r '.items[]|select(.roleRef.name=="cluster-admin")|.metadata.name'
# M1 — count NetworkPolicies (should grow from 0)
kubectl get netpol -A --no-headers | wc -l
# M2 — secrets encryption status (run on a3)
sudo k3s secrets-encrypt status
# M6 — namespaces still missing a PSA label
kubectl get ns -o json | jq -r '.items[]|select((.metadata.labels//{})|keys|any(startswith("pod-security"))|not)|.metadata.name'
```
