---
title: "649 Restarts Before the First Span"
authors: brian
tags: [langfuse, observability, llm, clickhouse, incident, lessons]
description: "Self-hosting Langfuse v4 took three days and four stacked failures before a single trace made it through: a liveness probe that killed database migrations, a ClickHouse two releases too old, a profiler log eating its own host, and an API that had quietly been removed. None of them were exotic. All of them hid behind each other."
draft: true
---

The quick honest take: I added [Langfuse](/observability/langfuse) to the lab this week — a self-hosted LLM tracing platform, so that when [Hermes](/ai/hermes) does something strange I can look at the tree of model calls that led there instead of scrolling logs. The Helm install took ten minutes. Then the web pod restarted 649 times over three days, and I learned more about how a modern "v4" application boots than I have from any deployment that worked the first time. Four things were broken, each one hiding the next.

<!-- truncate -->

## Failure 1: the liveness probe killed the migrations

Langfuse's web container does something reasonable on startup: it runs every pending database migration before it starts answering health checks. On a fresh install that's **438 Prisma migrations** against an empty Postgres, which on a3 takes several minutes.

The chart's default liveness probe gives it about fifty seconds.

So Kubernetes killed the container mid-migration. Prisma, doing its job, recorded that migration as *failed*. And from then on every subsequent start looked at the migration table, saw a failed row, and refused to touch the database — `Error: P3009` — which meant it never reached the health check, which meant the probe killed it again. Six hundred and forty-nine times.

The fix had three parts, and only the first was obvious:

- A **10-minute liveness window** in the values file so first boot can finish. That is the permanent fix and the only line that matters for the next person.
- `prisma migrate resolve --rolled-back` on the failed migration, so Prisma would try it again. Postgres DDL is transactional, so I expected a clean retry.
- Except that migration uses `CREATE INDEX CONCURRENTLY`, which is **not** transactional. The kill had left an *invalid* index behind, and the retry died with "already exists." One `DROP INDEX` later, the migrations ran through.

That last detail is the kind of thing you only learn by being killed at exactly the wrong moment. I've written the recovery into the README so I don't have to rediscover it.

## Failure 2: ClickHouse was two releases too old

With Postgres happy, the ClickHouse migrations got their turn — and migration 0039 failed with `Only literals can be skip index arguments`. Langfuse v4 builds text skip indexes that need **ClickHouse 25.12 or newer** (26.4 recommended). My self-managed StatefulSet was on 25.3, because that's what I'd picked when I set it up a while back and nothing had complained.

ClickHouse migrations here go through golang-migrate, which on failure marks the schema *dirty* and refuses to run anything until a human says otherwise. Fixing it meant bumping the image to 26.4.5 and then manually forcing the version pointer back to the last good migration. Not hard, but not documented anywhere I'd looked either.

## Failure 3: ClickHouse was eating its own host

While I was in there, the ClickHouse pod kept getting OOM-killed. The instance was *idle* — nothing had successfully written to it yet — and its own profiler log, `system.trace_log`, had written **4 GB in three days**. Merging those parts needed more than the 4 GiB memory limit I'd given it.

A database that fills its own disk and memory by profiling itself doing nothing is a genuinely funny failure mode. It's now disabled through a `config.d` override in the StatefulSet's ConfigMap, and the memory limit is 8 GiB. Lesson: any system that ships with introspection logging on by default will eventually charge you for it.

## Failure 4: the API I was testing against had been removed

Spans were finally flowing. My "export a span, read it back" check exported fine — HTTP 200 — and then the read returned 404. I spent an unreasonable amount of time in worker logs before finding the release note: Langfuse v4 is **"events-only"**. The v3 read endpoints (`/api/public/traces`, `/observations`, `/metrics`) are gone; `/api/public/v2/observations` is the read side now. The spans had been sitting in ClickHouse for an hour. I'd been knocking on a door that no longer existed.

## What I keep

The concrete keeper is a **smoke test** committed next to the deployment: check health, export one OTLP span with the bootstrap project's keys, poll the v2 API until it comes back. That single script would have collapsed three days into an afternoon, because it tests the *whole path* rather than the thing I happened to be staring at. "The pod is Running" was true for most of those three days. It just wasn't the question.

The softer lesson is about stacked failures. None of these four was hard on its own. What made them expensive is that each one was invisible until the previous one was fixed: you can't see the ClickHouse version problem until Postgres migrations pass, you can't see the API rename until spans are flowing. The only defense I know of is an end-to-end check you write *before* you believe the thing works, and then trust over your own eyes.

Langfuse is up now, at `langfuse.lan` and on the tailnet. Hermes traces land in it through hermes-otel. Whether it eventually replaces Phoenix as the lab's one tracing store is a question for after I've used both enough to have an opinion.
