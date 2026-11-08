---
title: "Hermes in my pocket, with a local brain on spark"
slug: hermes-in-my-pocket
authors: brian
tags: [ai, agents, hermes, inference, tailscale, lessons]
description: "In one Sunday, the in-cluster Hermes agent got an upgrade, an iPhone app over the tailnet, a ChatGPT-subscription login that works from a headless pod, and a local model on spark that runs at about 112 tokens/s. One small detail sent its traces to the cloud for a while."
draft: true
---

The quick honest take: the agent that lives in my cluster used to be something I talked to from a laptop, through a model I didn't fully control. As of today I talk to it from my phone, and it can think with either my ChatGPT subscription or a 30B model running on spark at about 112 tokens a second. Most of the day was straightforward. The parts worth writing about were two silent failures. In both, everything reported success and the result still wasn't what I wanted.

<!-- truncate -->

## The upgrade that moved the furniture

Hermes went from v2026.7.7 to v0.23.0. The version jump is mostly cosmetic, because upstream switched to semver tags. The changes underneath were real, though. OpenTelemetry now ships in the image (on Python 3.14), so the init container and `PYTHONPATH` trick I'd used for months to install it could go. The new launcher strips `PYTHONPATH` anyway. Plugin dependencies now live in Hermes's own dependency generations on the volume, and the image re-resolves them on every upgrade. I took a restic snapshot of the agent's volume first. Its memory is one of the few things in the house I can't rebuild from git.

## The config file nobody read, again

Right after the upgrade, my tracing plugin (hermes-otel, which I maintain) sent everything to one place: Langfuse Cloud. In September I had the [exact same symptom](/observability/otel-backends) for a different reason. This time the new image didn't include PyYAML, so the plugin couldn't read its YAML config. It skipped the file without complaining, auto-detected a backend from environment variables, found Langfuse keys, and used the cloud default.

The fix was to declare the missing packages as plugin dependencies and let Hermes install them. I also pinned `LANGFUSE_BASE_URL` to the in-cluster Langfuse, so auto-detection can't leave the house even if it runs again. The real check is a real agent turn followed by looking in Phoenix for the trace. While I was in there I parked six of the nine trace backends from September. Hermes now sends to Weave, Phoenix and Langfuse.

## The phone, and the wrong port

The Hermes iOS app is in beta. I exposed the agent's gateway API on the tailnet, pointed the app at it, and got "not the Hermes dashboard (HTTP 404)". The app talks to the **dashboard** on port 9119, not the API on 8642. One edit to the Tailscale Ingress fixed it. I also had to delete the proxy pod, which doesn't notice backend changes by itself. Now it's a tailnet-only HTTPS address with a real certificate, and I sign in with the dashboard password. It will never go on Funnel. This agent can run kubectl and read from the vault.

## Two brains

**ChatGPT subscription:** `hermes auth add openai-codex` runs a device-code login. The pod prints a link and a code, and I approve it on my phone. No browser needed in the pod. That's handy, because the model Hermes used by default before, NVIDIA's hosted nemotron-3-super, has been retired and now returns a 404.

**Local:** NVIDIA's Nemotron 3.5 Lightning (30B-A3B, NVFP4) took over spark's single vLLM slot from Ripple-65B. I used NVIDIA's DGX Spark recipe: vLLM 0.27.1, Marlin MoE, fp8 KV cache, and a speculative drafter. It does about 112 tokens/s, its tool calls parse cleanly, and the context window is 80K, which Hermes needs. It uses 30% of spark's memory. In LiteLLM it's `nemotron-lightning`, a local-only route. If spark is down, the request fails. It doesn't quietly go to a cloud provider.

One reminder that wireless nodes are wireless: spark's WiFi truncated a 4.7 GB image layer partway through the pull. So I staged the weights and the image on the node before the swap, and the pod started offline.

## What I'm taking away

Twice now, my tracing plugin has had a config file it silently didn't read, and both times every health check was green. "Export OK" tells you the export happened. It doesn't tell you where the data went. The only check I trust is to send a real request and find it at the other end. The details are on the [Hermes page](/ai/hermes) and the [inference fleet page](/ai/inference-fleet).
