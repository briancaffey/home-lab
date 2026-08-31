---
name: renovate-deps
description: >-
  Work through the open `chore(deps)` Renovate PRs on Forgejo (brian/home-lab)
  safely — triage each one by real blast radius, preflight it before it can
  touch the cluster, merge in a deliberate order, watch the live rollout, and
  revert fast when it breaks. Use when asked to "do the renovate PRs", "upgrade
  dependencies", "clear the dependency backlog", or to review/merge anything
  titled `chore(deps)` in the home-lab repo.
---

# Renovate dependency PRs (home lab)

## The one fact that shapes everything

**Merging is deploying.** There is no CI gate on this repo — the only workflow
is `.forgejo/workflows/docs.yml`, which builds the docs site and nothing else.
Every Argo CD app except `home-forgejo`, `home-harbor`, `home-longhorn` and
`home-vaultwarden` runs `automated.selfHeal: true`, so a merge to `main` reaches
running workloads within about three minutes, unreviewed and ungated.

Two consequences that drive this whole skill:

1. **All meaningful validation has to happen _before_ the merge.** After the
   merge, you are not validating — you are watching an outage that already
   started.
2. **`kubectl rollout undo` does not roll back.** selfHeal re-applies the git
   state within minutes and silently undoes your undo. The only real rollback is
   `git revert <sha> && git push`. Never reach for `kubectl` to fix a bad merge.

## Where things live

| Thing | Location |
|---|---|
| PRs | `https://forgejo.lan/brian/home-lab/pulls` · API `https://forgejo.lan/api/v1/repos/brian/home-lab` |
| Local clone | `~/git/home-cluster` (remote `origin` pushes to **both** GitHub and forgejo.lan) |
| Auth | git credential helper — `printf 'protocol=https\nhost=forgejo.lan\n\n' \| git credential fill` |
| Renovate policy | `renovate.json` (prConcurrentLimit 10, majors get a `major` label) |
| Renovate itself | Argo app `home-renovate`, CronJob in `clusters/home/renovate/` |
| Triage helper | `.claude/skills/renovate-deps/scripts/triage.sh` |

`origin` has two push URLs. One `git push origin main` publishes to the public
GitHub mirror *and* the internal forgejo. Argo CD only watches forgejo, but the
GitHub copy is public — never merge anything that puts a secret in the diff.

## The loop

Run these in order, one PR at a time. Do not batch merges: if three land
together and something breaks, you have three suspects and a selfHeal loop
fighting you.

### 1. Triage

`scripts/triage.sh` lists every open PR with its diff, the files it touches, the
Argo app that owns those files, and whether that app self-heals. Read it before
forming any plan.

Classify each PR by **blast radius, not by semver**. A patch bump to the secrets
bridge is far more dangerous than a minor bump to a log viewer. The version
number tells you what upstream *intended*; the deploy path tells you what
actually happens here.

### 2. Assign a tier

**Tier 1 — proceed on your own.** Stateless leaf app, no persistent state, no
other service depends on it, and reverting fully restores it. A crash here is
visible and cheap. *Examples: mailpit, dozzle, kube-ops-view, speedtest,
it-tools.*

**Tier 2 — preflight hard, then proceed and watch closely.** Real users or real
data, but a revert genuinely restores the prior state. *Examples: docs-site npm
bumps (must build first), the Forgejo runner, Renovate itself, most media apps.*

**Tier 3 — stop and ask the human.** Never merge these on your own judgment:

- **Anything with a schema or data migration.** Helm chart bumps for Dagster,
  Immich, Paperless, Harbor. A revert does *not* undo a migration that already
  ran against the database — this is the one case where rollback is a lie.
- **Secrets and identity.** `external-secrets`, the bitwarden-cli bridge,
  vaultwarden. If these break, secrets stop refreshing and you may lose the
  ability to fix anything else.
- **The tools you would need to recover.** Forgejo, Harbor, Argo CD, Longhorn.
  Breaking the git host or the registry means the revert can't deploy either.
- **GPU inference services** (`services/*`, vLLM, flux2, magpie-tts). Multi-GB
  image pulls, long model loads, and a node that is already memory-tight.
- **Any major**, and any jump spanning more than a couple of minor versions.
- **Digest-only bumps**, where the diff shows a hash change and nothing about
  what actually changed.

When you hit a Tier 3, present the specific risk and your recommendation, then
use AskUserQuestion. Give a real recommendation — "merge it, here's why" or
"skip it, here's what I'd want first" — not a neutral menu.

### 3. Preflight — before the merge, always

- **Verify the artifact exists.** `crane digest <image>:<tag>` for a tag bump,
  `crane manifest <image>@<digest>` for a digest. A typo'd tag that Argo can't
  pull is the single most common way one of these bricks a service, and it costs
  one second to rule out. Confirm the platform is `linux/amd64` (or `arm64` for
  the pi nodes) — an image that only ships one arch will `ImagePullBackOff` on
  the node it lands on.
- **Render the manifests.** `kustomize build clusters/home/<app>` or
  `helm template` for chart bumps. Catches a schema change in rendered output
  before Argo does.
- **Build it, if it's code.** npm/lockfile PRs must actually build
  (`cd docs-site && npm ci && npm run build`) — a lockfile that resolves is not
  a lockfile that compiles.
- **Read the release notes** on the range being crossed, not just the newest
  release. Look specifically for: required migrations, config format changes,
  dropped flags, changed default ports, and new required env vars.
- **Check for overlapping files.** Two Renovate PRs that touch the same file
  will conflict; the second needs a rebase. Merge the riskier one first while
  you have full attention, or ask Renovate to rebase.
- **Confirm the path is actually deployed.** Some paths are staged behind an
  overlay — `services/vllm/active/kustomization.yaml` selects *one* model
  directory, so a bump to an unreferenced model is inert. Check before assigning
  a scary tier to something that deploys nothing.

### 4. Merge

Merge via the API, one at a time:

```
curl -s -u "$U:$P" -X POST -H 'Content-Type: application/json' \
  -d '{"Do":"merge","delete_after_merge":true}' \
  https://forgejo.lan/api/v1/repos/brian/home-lab/pulls/<N>/merge
```

Prefer `"Do":"merge"`. Renovate branches are single-commit and a merge commit
keeps the revert trivially identifiable later.

### 5. Watch the rollout — this is not optional

A merge you do not watch is a merge you will debug tomorrow with no context.
Watch the owning Argo app until it is `Synced/Healthy` *and* the workload is
actually ready:

```
kubectl -n argocd get app <app> -o jsonpath='{.status.sync.revision} {.status.sync.status} {.status.health.status}'
kubectl -n <ns> get pods -l app=<app>
```

Verify the *behavior*, not just the pod phase. A pod reporting `1/1 Running` can
still be serving errors, and — as the Grafana thrash incident showed — a pod can
be `Running` and completely wedged with nothing in Kubernetes flagging it. Hit
the real endpoint (`curl -s -o /dev/null -w '%{http_code}' http://<app>.lan/`)
and check that the container isn't restarting.

Watch for the failure modes Argo will *not* mark unhealthy: `ImagePullBackOff`
behind a long pull, a container that starts and then crashes on a config it no
longer understands, and a readiness probe that passes before the app has
finished loading.

### 6. When it breaks

```
git revert --no-edit <merge-sha>
git push origin main
```

Then watch the app return to healthy, exactly as in step 5. Do not attempt a
`kubectl` fix first — selfHeal will undo it and you will lose time believing the
fix worked. Report what broke and stop the run; do not continue to the next PR
with an unresolved regression behind you.

## Hard constraints

- **One PR in flight at a time.** Merged, verified healthy, *then* the next.
- **Never merge Tier 3 without an explicit human answer.** Not "seems fine" —
  an actual answer to an actual question.
- **Never `kubectl edit`/`patch`/`rollout undo` an Argo-managed resource.**
  selfHeal reverts it; the change belongs in git or nowhere.
- **Never force-push or `--force` a merge** past a conflict. Ask Renovate to
  rebase, or rebase locally and push normally.
- **Stop the whole run on the second failure.** One revert is a bad upgrade; two
  means something about the cluster's state is wrong and batch-merging more
  dependencies will make diagnosis harder.
- **Report honestly.** If a PR was skipped, say it was skipped and why. A
  dependency backlog that looks cleared but isn't is worse than a visible one.
