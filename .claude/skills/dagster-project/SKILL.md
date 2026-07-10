---
name: dagster-project
description: >-
  Scaffold, ship, and verify a Dagster pipeline in Brian's home lab the way he
  likes it — assets + resources + schedule in the dagster-pipelines repo, shipped
  through the Forgejo → Harbor → Argo CD loop and verified with a real run. Use
  when asked to "make a Dagster project", "add a pipeline / asset / schedule",
  build a data pipeline, or wire something new into dagster.lan.
---

# Dagster project (home lab)

This skill encodes how Brian builds Dagster pipelines on his k3s cluster. When he
says *"make me a Dagster project that does X"*, follow this end-to-end and he
shouldn't have to explain the conventions again.

Read the service overview first if you need context:
[`docs-site/docs/data/dagster.md`](../../../docs-site/docs/data/dagster.md).

## What "a project" means here

Default model: **a new project = a new asset module inside the existing
`dagster-pipelines` repo.** One repo → one image → one code location → many
pipelines. This reuses the CI/Harbor/Argo loop and is almost always what's wanted.

Only create a **separate repo + code location** for a genuinely independent
project with its own dependencies or release cadence (advanced path at the end).

## Where things live

| Thing | Location |
|---|---|
| Platform (chart, values, Postgres, ingress) | `clusters/home/dagster/` in the **home-lab** repo · Argo app `home-dagster` |
| Pipeline **code** | `~/git/dagster-pipelines` (Forgejo `brian/dagster-pipelines`) |
| Built image | `harbor.lan/apps/dagster-pipelines:<sha>` (Forgejo Actions) |
| UI | `https://dagster.lan` (LAN) · `dagster.<tailnet>.ts.net` (Tailscale) — **no auth**, LAN/tailnet only |
| Deployed image tag | `dagster-user-deployments[0].image.tag` in `clusters/home/dagster/values.yaml` |

## Conventions — match these

Project layout (`~/git/dagster-pipelines/dagster_pipelines/`):
- `resources.py` — shared `ConfigurableResource`s. **Reuse** `PrometheusResource`
  (`http://prometheus.monitoring.svc:9090`) and `LiteLLMResource`
  (`http://litellm.observability.svc:4000`). Add a new resource here for any new
  external system; don't hard-code URLs in assets.
- `<area>.py` — assets for one pipeline/topic (e.g. `assets.py`, `hn.py`, `minio.py`).
- `definitions.py` — `load_assets_from_modules([...])`, one `define_asset_job`
  per pipeline, a `ScheduleDefinition` if it runs on a cron, resources wired in.

Asset style:
- `@asset(group_name="<pipeline>", description="...")`; declare deps as function args.
- Emit rich UI metadata: `context.add_output_metadata({"table": MetadataValue.md(...)})`.
- **Graceful degradation**: never fail a run because an *optional* dependency
  (LLM, external API) is down — catch and fall back to a templated/empty result.
  (See how `cluster_summary` falls back when LiteLLM is unavailable.)

LLM calls: go through the [LiteLLM gateway](../../../docs-site/docs/data/dagster.md).
Model is set by the `LITELLM_MODEL` env (ConfigMap `dagster-pipelines-config`, no
rebuild to switch); default `nemotron-omni` (local). Key = `LITELLM_API_KEY`
(secret `dagster-litellm`). NB: cloud models route through the **Rampart** PII
guard, which can redact pod-name hashes — prefer local models for internal digests,
or normalize identifiers before the prompt.

Dependencies (`pyproject.toml`): `dagster==1.13.13`; integration libs use the
`0.X.Y` scheme, so `dagster-postgres==0.29.13` and `dagster-k8s==0.29.13` **must**
be present (the run pods import them) — they already are.

## Ship a new pipeline — the loop

1. **Write** `dagster_pipelines/<name>.py` (assets, + a new resource in
   `resources.py` if needed).
2. **Wire** it in `definitions.py`: add the module to `load_assets_from_modules`,
   add a `define_asset_job(name="<name>_job")`, and a `ScheduleDefinition` if it's
   scheduled.
3. **Validate locally** before pushing (a venv with `dagster==1.13.13` + deps):
   ```bash
   dagster definitions validate -m dagster_pipelines.definitions
   ```
   Expect "All code locations passed validation."
4. **Commit + push** the pipelines repo. The remote needs the bot token:
   ```bash
   BOT="$(scripts/vault-secret.sh forgejo-bot)"   # run from the home-lab repo
   git -C ~/git/dagster-pipelines remote set-url origin \
     "https://brian:${BOT}@forgejo.lan/brian/dagster-pipelines.git"
   git -C ~/git/dagster-pipelines push origin main
   git -C ~/git/dagster-pipelines remote set-url origin \
     "https://forgejo.lan/brian/dagster-pipelines.git"   # scrub token back out
   ```
   Forgejo Actions builds `harbor.lan/apps/dagster-pipelines:<sha>` (12-char SHA
   printed in the job log). Poll the build:
   ```bash
   curl -sk -H "Authorization: token $BOT" \
     https://forgejo.lan/api/v1/repos/brian/dagster-pipelines/actions/tasks \
     | python3 -c 'import sys,json;t=json.load(sys.stdin)["workflow_runs"][0];print(t["status"])'
   ```
   (Watch **`status`**, which becomes `success`/`failure`; `conclusion` stays null.)
5. **Promote**: set that `<sha>` as `tag:` under `dagster-user-deployments` in
   `clusters/home/dagster/values.yaml`, commit + push the **home-lab** repo. Argo
   rolls the code server (or `kustomize build --enable-helm clusters/home/dagster
   | kubectl apply -n dagster -f -` to apply immediately, then let Argo adopt).
6. **Verify** — confirm the code location loaded and run it as a K8s Job:
   ```bash
   kubectl -n dagster port-forward svc/dagster-dagster-webserver 3999:80 &
   # list jobs in the code location:
   curl -s localhost:3999/graphql -H 'Content-Type: application/json' --data \
     '{"query":"{ repositoriesOrError { ... on RepositoryConnection { nodes { location{name} pipelines{name} } } } }"}'
   # launch one (selector: location=pipelines, repo=__repository__, job=<name>_job):
   curl -s localhost:3999/graphql -H 'Content-Type: application/json' --data \
     '{"query":"mutation{ launchRun(executionParams:{selector:{repositoryLocationName:\"pipelines\",repositoryName:\"__repository__\",jobName:\"<name>_job\"},mode:\"default\"}){ __typename ... on LaunchRunSuccess{ run{ runId } } } }"}'
   kubectl -n dagster get jobs   # each run = one dagster-run-<id> Job
   ```

## Credentials — all via `scripts/vault-secret.sh` (home-lab repo)

| Item | Use |
|---|---|
| `forgejo-bot` | admin token: create repos, set repo Actions secrets, `git push` |
| `harbor-robot-apps-ci` (`username` + password) | CI push creds → set as `HARBOR_ROBOT_USER`/`HARBOR_ROBOT_TOKEN` on any new repo |
| `dagster-postgres` | the metadata DB password (also in-cluster secret `dagster-postgres-secret`) |

Never write secrets to git or to disk; read them at call time.

## Hard constraints

- **Pin to a2**: `nodeSelector: { inference-club.com/box: a2 }` on webserver,
  daemon, code server, and the run launcher. The run/code images live in
  `harbor.lan/apps/` and **t430 doesn't trust the Harbor CA yet** (fix:
  `scripts/trust-harbor-ca.sh` on t430, then selectors can relax to
  `kubernetes.io/arch: amd64` to spread runs). spark is arm64 — always excluded.
- The run/code image must carry `dagster-postgres` + `dagster-k8s` (0.29.13).
- Dagster OSS has **no authentication** — never expose it past the tailnet.

## Advanced: a separate code location (new repo)

Only when a project is genuinely independent:
1. Create the repo with the bot token:
   `POST /api/v1/user/repos` (auth `token $(scripts/vault-secret.sh forgejo-bot)`).
2. Set CI secrets on it (`HARBOR_ROBOT_USER`/`HARBOR_ROBOT_TOKEN` from
   `harbor-robot-apps-ci`) via `PUT /repos/brian/<repo>/actions/secrets/<name>`.
3. Copy the `dagster-pipelines` scaffold (`Dockerfile`, `.forgejo/workflows/build.yaml`,
   `pyproject.toml`).
4. Add a **second** entry to `dagster-user-deployments[].deployments` in
   `clusters/home/dagster/values.yaml` (its own `name`, `image`, `dagsterApiGrpcArgs`,
   `nodeSelector: {inference-club.com/box: a2}`, and the same
   `envConfigMaps`/`envSecrets`). Commit + push → Argo adds the new code server.
