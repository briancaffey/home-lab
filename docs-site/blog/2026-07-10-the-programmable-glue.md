---
title: "The Programmable Glue: Dagster Writes About My GPUs"
authors: brian
tags: [dagster, orchestration, gpu, gitops, litellm]
description: "I added a data orchestrator to the lab and pointed its first pipeline at the cluster itself — it reads my Prometheus, calls my LLM gateway, and writes a daily state-of-the-fleet digest. Then the PII guard renamed a GPU pod to DRIVERS_LICENSE_1."
draft: true
---

The quick honest take: my lab could host things and deploy things, but it had nowhere to *run a bit of logic on a schedule and do something with the result*. This week I fixed that by standing up [Dagster](/data/dagster), a data/DAG orchestrator, as a genuinely new service category — "Data / Orchestration." And the first thing I did with it was point it back at the cluster: a daily pipeline that reads my own GPU metrics and writes an English summary of how the fleet is doing. It's the most self-referential thing I've built since the Git server that deploys itself.

<!-- truncate -->

## Why a whole new category

Most of what I add to the lab slots into an existing shelf: another media app, another platform service, another model server. Dagster didn't fit any of them, and that's exactly why it's interesting. Everything else in the lab is a *thing that runs*. Dagster is *the thing that runs my code against the other things*. It's a different layer — the programmable glue over the platform — so it got its own category rather than being crammed into "Platform Services."

The plumbing was almost boring, in the best way. Dagster is the official Helm chart inflated through kustomize (same pattern as open-webui), deployed by an Argo CD app, with a plain `postgres:16-alpine` for its metadata store pinned to a2. The one nice architectural flourish is the **K8sRunLauncher**: every pipeline run executes as its own Kubernetes Job. There's no long-lived worker pool — Dagster asks the cluster for a fresh pod per run and you watch them appear and vanish in `kubectl get jobs`. The orchestrator delegates execution straight to the scheduler it's already sitting on. It's a lovely, legible demonstration of k8s-native orchestration.

And the pipeline *code* didn't need a new deployment story at all. It lives in its own Forgejo repo, gets built into `harbor.lan/apps/dagster-pipelines:<sha>` by the same Forgejo Actions runner that builds everything else, and gets promoted by bumping an image tag that Argo then rolls out. Dagster just plugged into the [CI loop](/gitops/ci-loops) that was already there. That's the payoff of building the machinery first: the fifth thing you add costs a fraction of the first.

## The flagship: a pipeline that describes its own hardware

The first real pipeline is called "GPU digest," and it's a one-job tour of the whole lab:

1. It queries my own Prometheus for the dcgm-exporter metrics — per-GPU utilization, VRAM, power, temperature — plus the custom vram-reporter for the top VRAM-hungry pods.
2. It hands those numbers to my own [LiteLLM gateway](/ai/litellm) and asks for a natural-language "state of the GPU fleet" digest (with a templated fallback if the gateway is down).
3. It runs every day.

The model is configurable via an env var and defaults to the local `nemotron-omni`, so the entire thing — data, reasoning, orchestration — happens on my own hardware with no cloud in the loop. Dagster reads from Prometheus, thinks with LiteLLM, and shipped through Forgejo and Harbor. That's four existing systems tied together by one new one, which is the whole point of calling it glue.

## Then the PII guard renamed my GPU pod

Here's the moment that made me laugh. The first digest came back cheerfully reporting the GPU utilization of a pod named `DRIVERS_LICENSE_1`.

Nothing was broken. That was [Rampart](/ai/rampart), my PII-redaction guard, doing precisely its job. Every prompt to the LiteLLM gateway passes through Rampart, and a hashed pod name apparently looks enough like an ID number that the redactor swapped it for a `DRIVERS_LICENSE` placeholder before the model ever saw it. My security layer reached out and censored my own infrastructure's hostnames.

I love this failure, because it's the good kind. It proves the redactor is genuinely inline — not a config that *claims* to protect cloud calls but a filter that actually rewrites every prompt, including the ones I didn't think needed protecting. Over-redacting and fixing the prose is the safe direction to fail in. The fix is obvious and on the list: normalize pod names before they hit the gateway. But I'm oddly fond of the digest that worried about the license status of my RTX 4090s.

## What this unlocks

Dagster is now the place where "do X on a schedule against the platform" lives. The GPU digest is the first tenant; the obvious next ones write themselves — nightly backup-verification reports, a weekly changelog assembled from Forgejo commits, cost/usage rollups from the LiteLLM database. The layer exists now, and it can see everything else in the house.

One honest caveat I want on the record: Dagster OSS has no built-in auth, so it's gated purely by LAN and tailnet. That's fine for a solo operator behind a default-deny tailnet, and it's exactly why it doesn't leave the tailnet without an auth proxy in front. Ready is not the same as safe-to-expose — a lesson this lab keeps teaching me in new costumes.
