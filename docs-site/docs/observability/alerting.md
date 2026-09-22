---
title: Alerts That Reach a Human
tags: [observability, alerting, alertmanager, telegram, karma]
description: From rules firing into the void to a phone that buzzes — the whole alerting pipeline.
---

# Alerts That Reach a Human

**What it is:** the pipeline that turns "a metric crossed a line" into "my phone buzzed." Prometheus evaluates the rules, **Alertmanager** groups and routes them, **Telegram** delivers to my pocket, **Mailpit** keeps an always-on paper trail, and **Karma** (`karma.lan`) is the dashboard when I want the full picture with silencing.

**Why it exists — the missing-organ story:** for weeks, this lab had alert *rules* and nowhere to send them. Prometheus dutifully evaluated `VLLMTargetDown` and friends, marked them FIRING… into the void. No Alertmanager existed. The lesson generalizes: monitoring guides love dashboards and skip delivery, and a rule nobody receives is a diary entry, not an alert. Meanwhile the receipts piled up — Jellyfin was once down *three days* and a dev deployment crash-looped for *thirteen* before anything surfaced them.

{/* screenshot: observability/karma.png — karma with a firing test alert */}
{/* screenshot: observability/telegram-alert.png — the phone view, redact chat details */}

**What I get from it daily:**
- 📱 Anything real → Telegram within seconds (node down, disk filling, endpoint dead)
- 🧾 Every alert *and* its resolution → Mailpit, so there's always a record even if I dismissed the buzz
- 🖥️ `karma.lan` for the overview: what's firing, what's grouped, silence a known issue during maintenance
- 🔗 Every alert carries a clickable `prometheus.lan` link straight to the query that fired — tap, see the graph, know the shape of the problem

**The rule pack is earned, not copied.** Each rule traces to a real event: `NodeDown` after five minutes exists because x1 (a laptop node) once ran its battery flat at 5:40am and nobody knew for twelve hours. Disk-almost-full exists because every byte here lives on node-local disks. And the inference fleet gets a deliberately different philosophy — see below.

**The `node-runaway` group (added 2026-09-22).** The newest rules are the most expensively earned. The control plane [spun in a kernel lockup for nine hours](/hardware/nodes#a3--control-plane) — two cores at 100% *kernel* time, the box hot to the touch — and not one alert fired, because `NodeDown` watches for a node that stops answering and a3 never quite did: node-exporter was still up, it was just answering slowly from a machine whose network stack was wedged. The gap was that I had no rule for "a node is alive but stuck." Now there are four, all fed by node-exporter:

- `NodeCPUStuckInKernel` (**critical**) — any single CPU over 95% kernel time for ten minutes. This is the fingerprint of a soft lockup and it would have fired at 09:25 that morning instead of me finding out at 18:22.
- `NodeHighTemperature` — any core sensor over 95 °C for ten minutes. The symptom I actually noticed, as a rule.
- `NodeIOStalled` — pressure-stall "full" I/O over 50% for thirty minutes, because a3's data directory sits on a spinning disk and every reboot is followed by a quarter hour of saturated I/O that makes pods look broken when they are just waiting.
- `NodeRebooted` — boot time changed. Nodes now [reboot themselves on a lockup](/foundations/k3s#nodes-that-reboot-themselves), which is what I want, but a self-inflicted reboot should never be a surprise.

The rules live with the others in [`clusters/home/monitoring/config/homelab-alerts.yml`](https://github.com/briancaffey/home-lab/blob/main/clusters/home/monitoring/config/homelab-alerts.yml) and reach Prometheus the usual way: Argo CD syncs the config, Reloader restarts Prometheus.

{/* screenshot: observability/node-runaway-cpu-graph.png — a3's per-CPU system-mode graph from 2026-09-22, two flat lines at 100% */}

**"Parked is not down."** Model servers here are constantly scaled to zero to share four GPUs — that's an operational rhythm, not an outage. So *presence* alerts are excluded for the inference fleet entirely; instead, **behavior** rules (KV-cache pressure, requests backing up, slow time-to-first-token) only *can* fire while a model is actively serving, and go silent when it's parked. Zero configuration per service, correct in both directions.

Three emitters share the same two channels: Prometheus/Alertmanager (metrics), **Gatus** (18 endpoint healthchecks — is `jellyfin.lan` actually answering?), and **Scrutiny** (disk health). One phone, one paper trail, whoever noticed first.

```mermaid
flowchart LR
    P[Prometheus rules] --> AM[Alertmanager]
    GA[Gatus — 18 endpoints] --> TG
    SC[Scrutiny — 12 disks] --> TG
    AM --> TG[📱 Telegram]
    AM --> MP[📬 Mailpit record]
    GA --> MP
    SC --> MP
    AM --> K[Karma dashboard]
```

Config lives in [`clusters/home/monitoring/`](https://github.com/briancaffey/home-lab/tree/main/clusters/home/monitoring); the Alertmanager config itself is an out-of-band Secret because it touches the Telegram credentials — the one part of this page you won't find in git, on purpose.
