---
title: From kubectl-and-vibes to GitOps in three days
authors: brian
tags: [gitops, kubernetes, agents]
description: How my home cluster went from "SSH in and apply things" to fully git-driven — forty-plus applications, zero manual deploys — in one long weekend with an AI agent.
---

Here's the quick honest take: three days ago, deploying anything to my home cluster meant remembering the right incantation for that particular service, typing it into a terminal, and hoping I remembered correctly. Today, I merge a pull request and the cluster updates itself. If you run a homelab and you've been putting off "doing GitOps properly," this post is me telling you the water's warm — and that the payoff isn't the automation, it's the *visibility*.

<!-- truncate -->

## The before times

My cluster is four (sometimes five) machines running k3s: three boxes with RTX 4090s for AI inference, a laptop, and a DGX Spark. On top of them: something like forty services. Media servers, photo backup, a password vault, a Git forge, model servers, dashboards for everything.

Each service lived in my repo as a directory of Kubernetes manifests, and each got deployed by hand: `kubectl apply -k clusters/home/<service>`. Except the Helm ones, which needed `helm upgrade` with exactly the right flags — and if you accidentally used `kubectl` on those, objects landed in the wrong namespace and fought the real release. (I know this because it happened, and it took down my dashboard for an evening.)

The deeper problem wasn't the typing. It was that *nothing was watching*. The repo said one thing, the cluster did another, and the gap between them was invisible until something broke.

## "Why are there six Applications?"

The migration started small: an Argo CD instance I'd set up as a pilot, watching a single toy repo. Then Claude — the AI agent I operate this lab with, more on that in other posts — started migrating real services, one directory at a time.

My first genuinely confused moment came early. I expected "one repo, one apply." Instead I was staring at six separate Argo *Applications* and asked what was going on. The answer turned out to be the whole design philosophy: each Application is an independent watcher with its own blast radius. A bad commit degrades *one* service, not the whole cluster. Sync policies become trust tiers — new services can't delete anything (`prune: false`), battle-tested ones can, and the scary ones (more below) never self-heal without a human.

Once that clicked, the rest was rhythm.

## The waves

The migration ran as numbered tasks on a Forgejo issue that became a kind of captain's log. The shape of it:

```mermaid
graph LR
    A[Push mirror<br/>Forgejo → GitHub] --> B[Renovate<br/>nightly PRs]
    B --> C[App-of-apps root]
    C --> D[Migration waves<br/>easy → media → inference]
    D --> E[The circularity trio]
    E --> F[Longhorn ceremony]
    F --> G[Empty migration board]
```

- **The plumbing**: a push mirror so my self-hosted Forgejo and GitHub stay in sync automatically, and Renovate — a bot that opens PRs when any pinned image version has an update. My dependency updates became code review instead of archaeology.
- **The app-of-apps root**: one Application that watches a directory of Application definitions. After this, adding a service to GitOps meant *committing a file*. I did one myself, solo, as a training lap: pushed a commit, watched the new Application materialize with nobody running apply. Genuinely delightful.
- **The waves**: easy stateless services first, then media services (drift-checked carefully — self-heal will revert any live tweak you forgot you made), then the inference fleet with one crucial rule: replica counts are *ignored* by GitOps, because I park and unpark model servers constantly and git has no business un-parking them.
- **The scary stuff last**: the services the GitOps loop itself depends on, and the storage layer — each with their own ceremony, each a story for another post.

## What the machine found

Here's the part I didn't expect. Within a day of migrating, Argo's health checks surfaced two things nothing else had caught: my media server had been silently crash-looping for **three days**, and a dev deployment had been dead for **thirteen**. Both had been failing quietly while their little corner of the cluster looked fine from the outside.

That's the real sales pitch. Before: "is everything running?" had no answer short of checking forty things by hand. After: one command — `kubectl get applications -n argocd` — and anything red is lying to me in a way I can see.

## The honest accounting

I should be clear about how this actually happened, because it's part of the story: Claude drove. The agent wrote the Application manifests, ran the drift checks, found and fixed the incidents, and logged every step on the tracking issue. I made the decisions — which services, what risk tiers, when to merge — and clicked the merge buttons. Three days of that rhythm produced something I genuinely could not have built alone in three weeks, and — more importantly — every decision is written down in the issue log, so future-me can reconstruct *why*.

The migration board is empty now. Every workload in the cluster is git-driven. When tonight's Renovate run proposes some image bump, I'll read a diff, click merge, and the right pod will roll itself while I do something else.

That's the whole pitch: not that robots deploy your software, but that you finally know what your cluster is doing — because there's exactly one place to look.
