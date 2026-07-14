---
title: "Two Kinds of Glue: n8n Joins Dagster in the Lab"
authors: brian
tags: [n8n, automation, orchestration, dagster, litellm, gitops]
description: "I added n8n, an event-driven workflow tool, next to Dagster. One does scheduled data pipelines, the other reacts to webhooks — and both talk to the LiteLLM gateway, so a workflow can reach every model and service in the house."
draft: true
---

The quick honest take: a few days ago I gave the lab a place to *run code on a schedule* — [Dagster](/data/dagster). This week I gave it the other half — a place to *react to things*. That's [n8n](/data/n8n), a self-hosted workflow-automation tool (think Zapier or Make, but mine), and it lives right next to Dagster in the new "Data / Orchestration" category. The two of them split the job of "run some logic and do something" cleanly down the middle: Dagster is scheduled data pipelines, n8n is event-driven webhook-and-integration glue.

<!-- truncate -->

## Why two orchestrators isn't one too many

I went back and forth on this. Wasn't Dagster *the* orchestration layer? Why add another one? The answer is that they're shaped for different questions. Dagster is beautiful at "materialize these assets every morning" — a dependency graph of things you want to exist, run on a schedule, each run its own Kubernetes Job. But it's the wrong tool for "*when this webhook fires, go do that*." Reactive, integration-heavy, one-off-glue work wants a different shape: a canvas of pre-built service nodes, a trigger, and a Code node for when the drag-and-drop runs out. That's n8n.

So the mental model is: **Dagster = the clock, n8n = the doorbell.** Dagster wakes up because it's time. n8n wakes up because something happened. Between them they cover both halves of automation, and I'd rather have two tools that each fit their job than one tool stretched over both.

## The plumbing was boring, on purpose

This is the part I'm quietly proud of. n8n deployed almost identically to Dagster: a community Helm chart inflated through kustomize, an Argo CD app (`home-n8n`), and its own plain `postgres:16-alpine` instead of the chart's bundled subchart — same bring-your-own-Postgres convention, same node pin to a2 because the local-path PVC lives there. I didn't invent a new deployment story; I reused the one from last week. That's the whole payoff of building the machinery first: the second orchestrator cost a fraction of the first.

## The interesting part: it's wired to LiteLLM

Where n8n earns its keep is the connective tissue. The main pod carries a handle to the in-cluster [LiteLLM gateway](/ai/litellm), and I made a matching OpenAI-compatible credential in the UI. So any workflow can call *any* model LiteLLM fronts — local vLLM on my own GPUs, or a cloud model when a task outgrows the house — through the same single door every other consumer uses. n8n doesn't know about models; it knows about one gateway, and the gateway knows about everything.

Stack that on top of a couple hundred built-in integration nodes — Paperless, Immich, Forgejo, MinIO, Mailpit, the Telegram bot that already pages my phone — and n8n becomes a layer that can react to an event, think with an LLM, and act on any service in the house. That's the definition of glue, and it's why it sits in the same category as Dagster even though it does the opposite kind of work.

## The lesson I wrote down before I had to learn it

n8n encrypts every stored credential with an encryption key, and if that key ever changes, every saved credential turns into undecryptable garbage — no Postgres restore can bring them back. The chart will cheerfully generate a fresh key on install, which is a quiet way to lose everything on your next redeploy. So the key lives in an out-of-band secret the GitOps loop is told never to regenerate, with a copy in Vaultwarden. Same treatment for the Postgres password and the LiteLLM key. It's the lab's oldest rule in a new costume: secrets never live in git, and the automation is told not to fight the human who created them.

## One honest gap

n8n's native git source-control — the feature that would let me keep workflows in a repo — is enterprise-only. The community path is the Public API, which I've turned on, and the plan is to push workflow JSON in and out of a Forgejo repo through CI the way [dagster-pipelines](/data/dagster-projects) already does. That loop isn't built yet; right now my workflows live only in Postgres, backed up nightly. Ready to build on, not yet ready to call GitOps. That's an honest place to leave it — the door is open and the road is mapped, which is usually how the good parts of this lab start.
