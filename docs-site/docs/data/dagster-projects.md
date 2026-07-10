---
title: "Building Dagster Pipelines"
tags: [data, orchestration, dagster, gitops, claude, workflow]
service: dagster
repo_path: clusters/home/dagster
description: A practical guide to Dagster on the home lab — what it is, how it's deployed, what the demo pipeline does, and the exact workflow (including how to just ask Claude) for building new pipelines.
---

# Building Dagster Pipelines

**The quick honest take.** [Dagster](./dagster.md) is the lab's data orchestrator —
the layer that runs *code I write*, on a schedule, against the platform I already
built. This page is the companion to the [service overview](./dagster.md): it's the
**how-to**. If the other page answers "what is this and how is it wired," this one
answers "how do I actually build a new pipeline — and how do I get Claude to do it
for me the way I like?"

## 1. Dagster in one minute

You write pipelines as Python **assets** — an asset is a thing you want to exist (a
table, a report, a file). You declare what each asset depends on, and Dagster works
out the order, runs them on a schedule or a trigger, records every run in Postgres,
and gives you a UI to watch it all. It's in the Airflow family but **asset-first**
and much nicer to look at.

Three nouns worth knowing:

- **Asset** — a materializable output (`@asset` function). Its arguments are its
  dependencies.
- **Job** — a selection of assets you run together (`define_asset_job`).
- **Schedule / Sensor** — *when* a job runs (a cron, or a reaction to an event).

## 2. How it's deployed here (the short version)

Full detail is in the [service overview](./dagster.md); the essentials:

- The **platform** (webserver UI, daemon, Postgres, run launcher) lives in
  [`clusters/home/dagster/`](https://github.com/briancaffey/home-lab/tree/main/clusters/home/dagster),
  deployed by the Argo CD app `home-dagster`. UI at `https://dagster.lan`.
- Every pipeline **run executes as its own Kubernetes Job** (the K8sRunLauncher) —
  watch them in `kubectl get jobs -n dagster`.
- My **pipeline code** lives in a *separate* repo, `brian/dagster-pipelines`, built
  into a container image (`harbor.lan/apps/dagster-pipelines`) and loaded by Dagster
  as a gRPC **code location**.
- Everything is pinned to node **a2** (Harbor-trusted, co-located with Postgres).

The key mental model: **platform = home-lab repo; pipeline code = dagster-pipelines
repo.** You edit the platform rarely and the pipeline code often.

## 3. What's in the demonstration project

The `dagster-pipelines` repo ships one real, end-to-end pipeline plus a warm-up
asset, so there's something working to learn from:

| Asset | What it does |
|---|---|
| `hello_dagster` | Trivial smoke-test — the first thing to materialize in the UI. |
| `gpu_snapshot` | Queries the lab's **Prometheus** (dcgm-exporter `DCGM_FI_DEV_*`) for per-GPU utilization, VRAM, power, temperature. |
| `vram_by_pod` | Top GPU-memory consumers by pod, from the custom `vram-reporter` metric. |
| `cluster_summary` | Feeds those numbers to the **LiteLLM gateway** and gets back a natural-language "state of the GPU fleet" digest (with a templated fallback if the gateway is down). |

They form a small DAG — `gpu_snapshot` and `vram_by_pod` fan into `cluster_summary`
— and run on a **daily schedule** (`daily_gpu_digest`, 07:00). It's deliberately a
tour of the whole lab in one job: it reads my own Prometheus, thinks with my own
LLM gateway, and was shipped through my own Forgejo + Harbor. That's the pattern
every new pipeline follows.

{/* screenshot: data/dagster-asset-graph.png — the GPU digest asset graph in the Dagster UI */}

The repo's shape is worth copying:

- `dagster_pipelines/resources.py` — the **seams** to the cluster: `PrometheusResource`
  and `LiteLLMResource`. New external systems get a new resource here, not a URL
  hard-coded in an asset.
- `dagster_pipelines/assets.py` — the assets themselves.
- `dagster_pipelines/definitions.py` — wires assets + resources + the schedule.
- `Dockerfile` + `.forgejo/workflows/build.yaml` — the code-server image and its CI.

## 4. The workflow for a new pipeline

The loop is the same one every app in the lab uses — push code, CI builds, Argo
deploys — with one Dagster-specific twist (promoting the image tag).

1. **Write** a new module `dagster_pipelines/<name>.py` (assets, plus a new resource
   in `resources.py` if it talks to something new).
2. **Wire** it into `definitions.py` — add a job and, if it's scheduled, a schedule.
3. **Validate** locally: `dagster definitions validate -m dagster_pipelines.definitions`.
4. **Push** the `dagster-pipelines` repo → Forgejo Actions builds
   `harbor.lan/apps/dagster-pipelines:<sha>`.
5. **Promote** — bump the `dagster-user-deployments` image tag in
   [`clusters/home/dagster/values.yaml`](https://github.com/briancaffey/home-lab/tree/main/clusters/home/dagster)
   to that `<sha>`, and push the home-lab repo. Argo rolls the code server.
6. **Verify** — the new code location loads in the UI; launch the job and watch its
   Kubernetes Job appear in `kubectl get jobs -n dagster`.

:::tip[Pin an explicit tag, don't chase `:latest`]
Promoting by pinning the exact `<sha>` (rather than following a moving `:latest`)
keeps deploys reviewable in git and trivially rollback-able — the same discipline
as every other GitOps app in the lab.
:::

A couple of rules the CI enforces for you: pin `dagster==1.13.13`, and remember the
integration libraries use the `0.X.Y` scheme — **`dagster-postgres`/`dagster-k8s`
are `0.29.13`** for core `1.13.13`. They have to be in the image or the run pods
fail to import.

## 5. The easy button: just ask Claude

Because this is my repo and Claude has the context, I don't do the six steps by
hand — I describe the pipeline and let Claude run the loop. This repo carries a
**Claude skill** at
[`.claude/skills/dagster-project/`](https://github.com/briancaffey/home-lab/tree/main/.claude/skills/dagster-project)
that encodes every convention on this page: where code goes, the resource patterns,
the credentials (`forgejo-bot`, `harbor-robot-apps-ci` via `scripts/vault-secret.sh`),
the a2 pinning, and the push → build → promote → verify loop.

So the prompt is just the *idea*:

> "Make a Dagster project that pulls the top Hacker News stories, runs each headline
> through LiteLLM for a one-line sentiment, and materializes a daily table. Put it in
> the `dagster-pipelines` repo and ship it."

Claude will scaffold the module, wire the job and schedule, validate it, push it,
watch the Harbor build, bump the tag in `values.yaml`, let Argo roll it, and launch
a verification run — then report the result. Good things to include in the prompt:

- **The data source** ("read Prometheus / hit this API / list this MinIO bucket").
- **The output** ("a daily table", "a Slack message", "a Markdown report in the UI").
- **The cadence** ("daily at 7am", "on demand only").
- **Where it goes** — default is a new module in `dagster-pipelines`; say so if you
  want a whole separate code location instead.

Some starter ideas worth trying: a **Hacker News → sentiment** digest, a **MinIO
bucket catalog** (counts/sizes/newest objects), or a **backup-freshness check** that
alerts through the existing Telegram/Alertmanager stack.

## 6. Good conventions to keep

- **Resources for anything external.** Put URLs and clients in `resources.py`, not
  in assets. Assets stay pure and testable.
- **Degrade gracefully.** Never fail a run because an *optional* dependency (the LLM,
  a flaky API) is down — catch it and fall back, like `cluster_summary` does.
- **Rich UI metadata.** Emit Markdown tables via `context.add_output_metadata` so a
  run tells its story in the UI, not just in logs.
- **Local models by default.** LLM steps default to the local `nemotron-omni`
  (set via the `LITELLM_MODEL` env — no rebuild to switch). Cloud models route
  through the [Rampart](./dagster.md) PII guard, which can redact identifiers.
- **No auth — mind the exposure.** Dagster OSS has no login. It's fine on the LAN
  and the default-deny tailnet; never put it anywhere more public without an auth
  proxy.
