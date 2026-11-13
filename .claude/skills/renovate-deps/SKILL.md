---
name: renovate-deps
description: >-
  Upgrade everything Renovate has proposed for the home cluster (Forgejo
  brian/home-lab `chore(deps)` PRs): triage by real blast radius, sort into
  risk groups, test each group before it can touch the cluster, ship a group
  (or a single PR) at a time, watch the live rollout, and revert fast when it
  breaks. Use when asked to "do the renovate PRs", "upgrade dependencies /
  everything", "clear the dependency backlog", "are there upgrades to make", or
  to review/merge anything titled `chore(deps)` in the home-lab repo.
---

# Renovate dependency upgrades (home lab)

Brian's process, in his words: *group them into risk groups, tackle them in
groups or individually depending on what works best, test where appropriate.*
This file is how to do that without taking the cluster down.

## The one fact that shapes everything

**Merging is deploying.** There is no CI gate on infra changes — the only
workflow is `.forgejo/workflows/docs.yml` (docs site). Every Argo CD app except
`home-forgejo`, `home-harbor`, `home-longhorn` and `home-vaultwarden` runs
`automated.selfHeal: true`, so a push to `main` reaches running workloads in
about three minutes, unreviewed and ungated.

1. **All meaningful testing happens _before_ the push.** After it, you are
   watching an outage that already started.
2. **`kubectl rollout undo` does not roll back.** selfHeal re-applies git. The
   only real rollback is `git revert <sha> && git push origin main`.
3. **A revert does not undo a database migration.** For anything that migrates
   (Immich, Paperless, Open WebUI, Dagster, Forgejo, Harbor…) the rollback is a
   *restore*, so take a fresh backup immediately before (recipes below).

## Where things live

| Thing | Location |
|---|---|
| PRs | `https://forgejo.lan/brian/home-lab/pulls` · API `…/api/v1/repos/brian/home-lab` (needs a token — anonymous calls 404) |
| Local clone | `~/git/home-cluster`. `origin` push URLs = GitHub mirror **and** forgejo; `forgejo` remote = forgejo only. `git push origin main` publishes both — GitHub is public, scan the diff |
| Auth | merge API: `printf 'protocol=https\nhost=forgejo.lan\n\n' \| git credential fill`; reads: `scripts/vault-secret.sh forgejo-api` |
| Renovate policy | `renovate.json` — validate edits with `npx --yes --package renovate@44 renovate-config-validator renovate.json` |
| Renovate itself | Argo app `home-renovate`, CronJob `renovate/renovate` (06:00 ET), runs as Forgejo user **`renovate`** |
| Helpers | `scripts/triage.sh` (list + owning app), `scripts/merge-and-watch.sh` (one PR), `scripts/wait-healthy.sh` (after a direct push) |
| Not Argo-managed | `platform/**` (e.g. milvus), `clusters/home/gpu/**` (NFD, device plugin, GFD) and `clusters/home/forgejo/runner/` (`kubectl apply -k`, see its README) — a merge deploys **nothing**; apply by hand. Before trusting git, compare the live image (`kubectl get deploy -o jsonpath`) — the runner sat on 12.12.0 through two "merged" Renovate bumps |

## The loop

### 1. Triage

Run `scripts/triage.sh`. It prints every open PR's version change, files, the
owning Argo app (and whether it self-heals), and **file overlaps**. Also run
`git fetch forgejo '+refs/pull/*/head:refs/remotes/pr/*'` and read the full
diffs (`git diff -U0 main...pr/<N>`) of any *group* PR — the triage summary
truncates them.

Before anything else, check the cluster is in a state worth changing: all
nodes Ready (`a2` dual-boots into Windows), Argo apps Synced/Healthy, and the
nightly backups succeeded (`kubectl get cronjobs -A | grep backup`).

### 2. Sort into risk groups — by blast radius, not semver

A patch bump to the secrets bridge outranks a major bump to a log viewer.

| Group | What | How to ship |
|---|---|---|
| **G0 Renovate health** | the renovate image, its config, its access | first — it has to rebase the rest |
| **T1 leaf apps** | stateless, nothing depends on them, revert restores them: dozzle, mailpit, gatus, karma, code-server, scrutiny, qbittorrent, navidrome, manyfold | **one batched commit**, verify every app after |
| **T2 shared/stateful-but-revertible** | monitoring core, backup CronJobs, the backup store (RustFS), Pi-hole (LAN DNS!), Hermes, docs site/CI, low-risk Helm charts (reloader, headlamp, trivy, netdata, milvus) | small themed groups, each with its own test |
| **T3 migrations** | Immich, Paperless, Open WebUI, Dagster, Harbor, Forgejo | **one at a time**, fresh backup first, read every release note in the range |
| **T3 recovery tooling** | Forgejo + runner, Harbor, Argo CD, Longhorn | one at a time; Forgejo/Harbor/Longhorn apps are manual-sync |
| **T3 secrets** | external-secrets chart, the bitwarden-cli bridge, Vaultwarden | one at a time; force-sync every ExternalSecret after (see recipes). Auto-mode may refuse these — hand them to Brian |
| **T3 GPU** | `services/*`, vLLM, NFD + device plugin | test the image/flags on the target node first; NFD/device-plugin are hand-applied |
| **Close** | bogus tags, superseded PRs | close with a comment explaining why |

Brian has blanket-approved "upgrade all of these" before; that covers T3, but
still **stop and ask** if preflight turns up something he'd want to decide
(a data reset, a feature removal, a required manual step).

### 3. Split group PRs; avoid conflicts

Renovate's grouped PRs (`kubernetes images (non-major)`, `helm charts
(non-major)`) mix every tier in one PR and overlap the single-purpose PRs.
Don't merge them whole. Instead:

- Apply their changes yourself as **risk-grouped commits** on `main`
  (`deps(tier1): …`, `deps(monitoring): …`) — each commit message says which
  Renovate PR it came from and what was tested.
- Merge clean **single-purpose PRs** through the API (`merge-and-watch.sh`), so
  their history stays identifiable.
- Close the group PRs at the end ("superseded by <shas>"); Renovate re-opens
  whatever is still outstanding on its next run.

"non-major" is not "low risk": the group PR has carried vLLM v0.27 → v0.33 and
python 3.12 → 3.15 for an app that pip-installs torch. Pull those out.

### 4. Preflight — test before the push

Always:
- **Image exists for the right arch.** `crane digest --platform linux/amd64 <img>`
  (and `crane manifest … | jq '.manifests[].platform'` for anything on `spark`,
  which is arm64).
- **Renders.** `kustomize build [--enable-helm] <dir>` (standalone kustomize v5;
  delete the generated `charts/` dir after). For chart bumps, diff old vs new
  render: object kinds, CRD versions, images. Plain-manifest dirs (no
  kustomization) → `kubectl apply --dry-run=server -f <file>`.
- **Release notes across the whole range**, grepped for breaking / migrat /
  remov / deprecat — then check each hit against *our* config.

Recipes that have caught real problems:

| Change | Test |
|---|---|
| Prometheus / Alertmanager | throwaway pod with the **new** image mounting the live configmaps/secret: `promtool check config --syntax-only`, `promtool check rules`, `amtool check-config` |
| Python base image bump where the app `pip install`s pinned deps | check wheels exist for the new cpXYZ (e.g. `download.pytorch.org/whl/cu130/torch/`); for light deps, `docker run python:<new> pip install … && python -c 'import …'` |
| vLLM | throwaway pod **on the serving node** running `vllm serve --help=all` and grepping every flag we pass — also pre-pulls the ~10 GB image so the real rollout is short |
| npm / Node / docs site | merge the PRs in a scratch worktree, `docker build docs-site/`, run it, curl `/` |
| Pi-hole | before/after `dig @192.168.5.96 harbor.lan` + an external name; confirm `FTLCONF_*` keys we use still apply |
| DB-migrating app (Postgres) | `kubectl -n <ns> create job bk-pre-<x> --from=cronjob/backup-<ns>`; wait; confirm "snapshot … saved" + "no errors were found" |
| SQLite app with no backup job (Open WebUI) | in-pod `sqlite3` backup API → `webui.db.pre-<ver>`, `pragma integrity_check`, `kubectl cp` a copy out |
| Paperless major | confirm the `PAPERLESS_DB*` envs still parse in the new `src/paperless/settings/`; Postgres version vs Django minimum |
| external-secrets | audit `kubectl get externalsecrets -A` (apiVersion, `dataFrom.find`, templates) against the notes; after rollout annotate every ES with `force-sync=$(date +%s)` and require 51/51 `SecretSynced` |
| Backups / RustFS | after rollout, run one backup job by hand and read restic's check output |

### 5. Ship

- Direct commit: `git commit` → `git push origin main` →
  `scripts/wait-healthy.sh <sha> <app>[,<app>…]`.
- Single PR: `scripts/merge-and-watch.sh <pr> <app> <ns> [url] [selector]`.
- Merge API returns **405 "Please try again later"** right after another merge
  while Forgejo recomputes mergeability — wait 15 s and retry; don't fall back
  to force-anything.
- After any PR merge: `git pull --ff-only forgejo main && git push origin main`
  so the GitHub mirror keeps up.

### 6. Verify behaviour, not just Argo

Synced/Healthy can arrive before the new pod serves. For each app: running
image matches, `ready=true`, no new restarts, the real endpoint answers
(`curl -sk https://<host>.lan/` — get the host from `kubectl get ingress -A`,
it is not always the app name: code-server is `code.lan`, navidrome is
`music.lan`), and an app-level check where one exists (Dagster GraphQL
`{ version … daemonHealth }`, Prometheus `up==0` list, `dig` for DNS, a backup
run for backup tooling).

**Big images on WiFi nodes take a long time** (a2, a3, spark, blade): an
Immich ML pull took 8½ min, vLLM/Open WebUI on spark well over 20. A pod in
`ContainerCreating` with a `Pulling` event is *slow*, not *failed* — check
`kubectl describe pod` events before deciding anything. Several big pulls to
the same node at once make it worse; stagger them.

Always compare against the **pre-existing** state before calling something a
regression (e.g. `max_over_time(up[6h] offset 30m)` in Prometheus, a
ReplicaSet's age, `kubectl get rs`). The cluster has standing quirks (a2's GPU
is shared by dia-a2 and trellis2, so one is always Pending).

### 7. When it breaks

```
git revert --no-edit <sha>
git push origin main
```

Watch it return to healthy. For a migrated DB, restore from the backup you
took in preflight instead. Report what broke and stop the run.

## Gotchas learned the hard way

- **Completed Jobs are immutable.** Any image bump to a one-shot Job (e.g.
  `services/dia/download-job.yaml`) leaves its app OutOfSync. Give such Jobs
  `argocd.argoproj.io/sync-options: Force=true,Replace=true` — `Replace` alone
  still trips the immutable selector.
- **Multi-source Argo apps** (netdata, external-secrets…) report
  `.status.sync.revisions[]`, not `.status.sync.revision` — watchers must read
  both.
- **Renovate's bot is the Forgejo user `renovate`.** Every repo in
  `RENOVATE_REPOSITORIES` must have it as a collaborator, or the whole run
  exits non-zero (it 404s on the repo) and `home-renovate` shows Degraded.
- **linuxserver date tags** (`qbittorrent:20.04.1`) sort above real 5.x
  releases — close those PRs; `renovate.json` now pins `allowedVersions`.
- **Tool environment:** macOS has no `timeout`; background shells here are
  bash 3.2 — run watchers in the foreground (≤10 min per call) or keep them
  3.2-compatible. `kubectl delete` has no `-q`.
- **Secrets changes may be refused by auto-mode** (and so may granting repo
  permissions). Don't work around it — finish everything else and hand the
  exact steps to Brian.

## Hard constraints

- **Test before push; one group (or one T3 item) in flight at a time.**
  Verified healthy, *then* the next.
- **Fresh backup immediately before any migrating upgrade.**
- **Never `kubectl edit`/`patch`/`rollout undo` an Argo-managed resource** to
  fix a bad upgrade — the fix belongs in git.
- **Never force-push or `--force` a merge.**
- **Stop the whole run on the second failure.**
- **Report honestly**: what shipped, what was held and why, what was refused,
  what still needs a human. A backlog that looks cleared but isn't is worse
  than a visible one.
