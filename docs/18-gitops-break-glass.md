# 18 — GitOps break-glass: operating when the loop is broken

Written 2026-07-06, BEFORE migrating the circularity trio (vaultwarden,
harbor, forgejo) to Argo CD. Read this when Argo/Forgejo/Harbor is down or
misbehaving and "fix it via a git push" is not available.

## The dependency loops, plainly

- **Argo reads its desired state from Forgejo.** Forgejo broken ⇒ Argo can
  deploy nothing new (running apps keep running; syncs just stop).
- **Nodes pull images through Harbor's proxy cache** (falls back to upstream
  automatically — slow, not broken). Harbor also hosts `library/*` images
  (rampart, hermes-otel) with NO upstream fallback.
- **Credentials bootstrap from Vaultwarden** (`scripts/vault-secret.sh`).

## Trio sync policy (deliberately weaker than the other apps)

`automated` sync (commits deploy) but **`selfHeal: false`** — Argo never acts
on drift by itself for these three; drift shows as OutOfSync and a human
decides. `prune: false` forever. Harbor additionally carries
`ignoreDifferences` for its self-regenerating chart secrets (see the
Application block) — do not "fix" that by syncing those secrets manually.

## Break-glass procedures

**1. The repo is never hostage.** Full copies: the laptop clone and the
GitHub push mirror (github.com/briancaffey/home-lab). If forgejo.lan is down,
work from the laptop clone; push to Forgejo when it's back (mirror re-syncs
GitHub automatically).

**2. `kubectl apply -k clusters/home/<svc>` always works** for plain-kustomize
dirs — Argo tolerates it (worst case an app shows OutOfSync until the change
is also committed; trio apps won't self-heal-revert you because selfHeal is
off). For argo-managed helm apps (netdata, homepage):
`helm template` + `kubectl apply -n <ns>` in an emergency, or fix Forgejo
first — that's usually faster.

**3. Stop Argo from acting at all** (bad sync loop, need quiet):
```sh
# pause one app (removes automated policy until re-set from git):
kubectl -n argocd patch application <name> --type merge \
  -p '{"spec":{"syncPolicy":{"automated":null}}}'
# or stop the whole control plane (running workloads unaffected):
kubectl -n argocd scale deploy argocd-application-controller --replicas=0 \
  2>/dev/null || kubectl -n argocd scale sts argocd-application-controller --replicas=0
```
Re-enable by re-syncing home-apps-root (git is still the truth) or scaling
back up. NOTE: a paused app's spec was hand-patched — the root app will
restore it from git on its next sync, which is what you want.

**4. Forgejo dead and its manifests need a fix:** edit on the laptop clone →
`kubectl apply -k clusters/home/forgejo` directly. Forgejo's data (repos,
issues) is on its PVC on a2, untouched by manifest surgery.

**5. Harbor dead and a node can't pull `harbor.lan/library/*`:** the image is
also loadable from any node that has it cached (`crictl images`), or rebuild/
re-push from source. Public images keep flowing via the upstream fallback in
`scripts/k3s-registries.sh` config.

**6. Vaultwarden dead:** its SQLite lives on the a3 PVC. `kubectl apply -k
clusters/home/vaultwarden` from the laptop restores the workload; the data
survives. Bot credentials for the CLI live in the macOS Keychain (docs/10),
so vault access recovers as soon as the pod does. (Vaultwarden backups are
red-tape item 7 — still pending, still the real risk.)

**7. Total Argo loss:** `kubectl apply -k clusters/home/argocd --server-side`,
re-run `scripts/lan-certs.sh` (tls-certs-cm reset gotcha), recreate the
`repo-home-lab` secret (token in Vaultwarden `forgejo-api`), then
`kubectl apply -f clusters/home/argocd/apps/root.yaml`. Everything else
reconciles from git.
