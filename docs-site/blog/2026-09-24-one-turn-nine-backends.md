---
title: "One Turn, Nine Backends"
authors: brian
tags: [observability, opentelemetry, hermes, helm, lessons]
description: "Every self-hostable backend my hermes-otel plugin claims to support now runs in the cluster from its official Helm chart, and one real agent turn lands in all of them. The install was the easy part. The interesting failures were a config file nobody was reading, a collector that accepted nothing until someone registered, and a five-minute loop that had been silently failing since the day it was written."
draft: true
---

The quick honest take: I maintain [hermes-otel](https://github.com/briancaffey/hermes-otel), an OpenTelemetry plugin for the Hermes agent, and its README lists a dozen backends it supports. Until this week, "supports" meant "I read the docs and wrote an exporter." Now it means something better: every backend on that list that *can* be self-hosted is running in my k3s cluster from its official Helm chart, and a real [Hermes](/ai/hermes) turn — a `/v1/runs` call with tool use — showed up as a trace in every one of them. Nine backends, one turn, one evening. The [backends page](/observability/otel-backends) has the matrix; this is the story.

<!-- truncate -->

## Why nine

Nobody needs nine tracing backends. I don't. The lab already had [Langfuse](/observability/langfuse) and Phoenix, and those remain the two I'd open to actually *read* a trace.

But a plugin author has a different problem from a user. When someone opens an issue saying "the Jaeger backend doesn't work," I want to answer from a Jaeger I can log into, not from memory of a docs page. And "self-hostable" is a claim about the *backend*, which is only true if you've done it: the official chart exists, it comes up on one node, it takes the OTLP the plugin sends, the trace is visible in the UI. Every one of those steps had at least one surprise this week.

So the shape of the work was: for each of OpenObserve, Jaeger v2, Grafana Tempo, SigNoz, Uptrace and Parseable — plus an OTel Collector standing in for the `lgtm` type — a Helm release from the official chart, values in git, pinned to a2, a `.lan` ingress, a Homepage tile, secrets via External Secrets from Vaultwarden. Then point the plugin at all of them at once and send a turn.

## The one that wasn't a backend

hermes-otel's `lgtm` type expects "an OTLP receiver with Grafana behind it." On a laptop that's the `grafana/otel-lgtm` demo container. It has no chart and no durable storage, and I had already decided not to port it. What it *is*, structurally, is a collector in front of Tempo, Prometheus and Loki. So the k3s version is exactly that: an OpenTelemetry Collector (contrib) receiving on `:4318`, forwarding traces to the Tempo I'd just installed, metrics to Prometheus — which needed one flag, `--web.enable-otlp-receiver`, to accept a push instead of a scrape — and logs to nowhere yet, because my Loki is 2.9 with no OTLP endpoint and collector-contrib dropped its `loki` exporter. That gap is a tracked Loki 3 migration.

The gateway then earned its keep a second time. Parseable OSS turned out to be un-talkable-to directly: the plugin's `parseable` type authenticates with an API key, and OSS has no API keys (401 to anything carrying the header); and OSS rejects OTLP/protobuf outright (`400 Protobuf ingestion is not supported in Parseable OSS`), which is all the Python exporter sends. The collector, though, can re-encode to OTLP/JSON, add Basic auth, and set a per-signal stream header. So Parseable is fed by the gateway and nothing else, and it works. A backend that "doesn't support" the plugin turned into a backend that the plugin reaches through one hop.

## Three failures worth keeping

**The config nobody was reading.** Seven backends up, every OTLP endpoint smoke-tested with a hand-built request, all 200s. I sent a real turn. The traces went to Langfuse *Cloud*.

The plugin was fine. The install step had seeded its config into `/opt/data/.hermes/plugins/hermes_otel/` — the path the old fork branch used. The 1.x plugin, with `HERMES_HOME` set to `/opt/data`, looks in `/opt/data/plugins/hermes_otel/` (which the init container reinstalls on every boot) or `/opt/data/hermes_otel.yaml`. Finding neither, it fell through to environment auto-detection, found a Langfuse-shaped pair of keys, and configured itself for the cloud. It never told me it had ignored my file, because from its point of view there was no file.

The fix is a mounted ConfigMap and `HERMES_OTEL_CONFIG` pointing at it — the plugin's highest-precedence path, nothing on the volume for a reboot to wipe. The lesson is the one I keep relearning in new costumes: *a 200 from the endpoint tests the receiver, not the sender.* The only proof is the trace in the UI.

**The collector that accepted nothing.** SigNoz came up green, every pod Running, and its collector's port 4318 was closed. The collector registers with the SigNoz app over OpAMP on start, and that registration fails until a first user and org exist. Register an admin, and the ports open a moment later. The chart does not mention this. "Ready" was true; "accepting traffic" was not.

**The loop that had never worked.** This one wasn't about observability at all. External Secrets reads my Vaultwarden through a small bridge pod running `bw serve`, which caches the vault in memory, so the bridge has a background loop that hits its own `/sync` endpoint every five minutes. Standing up seven backends meant seven new vault items in one evening, and none of them appeared in the cluster until I restarted the bridge. The loop called `node`. The image has no `node` on its PATH. It had been failing silently every five minutes since the day it was written, with a green readiness probe the whole time, because serving a stale vault still counts as serving. It calls `wget` now.

## What I'd tell someone doing this

- Put the collector in early. A gateway that re-encodes and fans out solves a whole class of "this backend is picky" problems without touching the sender.
- Don't trust chart repos to stay put: the Grafana community charts moved to `grafana-community` in January, and the old `grafana/tempo` is a stale 1.24.
- Read the operator situation before installing. SigNoz brings a cluster-scoped ClickHouse operator; Uptrace wants three operators for its stores and I replaced all of them with plain StatefulSets.
- The end-to-end test is the only test. Every failure above was invisible from the component's own health check.

Nine tiles on Homepage now, all pointing at the same trace. I'll keep them until I've formed an opinion about each, and then the `helm uninstall` commands are already in the READMEs.
