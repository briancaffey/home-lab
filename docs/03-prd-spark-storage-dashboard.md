# PRD 03 — Spark storage dashboard: see what's eating the disk, reclaim it safely

**Status: draft (2026-06-12, written the day spark's docker turned out to be
hoarding ~365GB while its swap sat 100% full)**

## One-liner

A single-page dashboard for the DGX Spark that visualizes where its 3.7T disk
and 121G unified memory actually go — docker, k3s containerd, model caches,
swap — and turns "I should clean up sometime" into an informed, safe,
two-click reclaim.

## Why

- The numbers that motivated this (2026-06-12): 79% disk used; docker holding
  548.8GB of images (157GB unused), **171GB in 36 stopped containers**, 75GB
  of build cache, 36GB of dangling volumes; swap 15/15Gi full from running
  duplicate docker+k8s copies during the migration. None of this is visible
  without running four different commands and knowing how to read them.
- `docker system prune -a` is a chainsaw: some stopped containers are
  experiments worth keeping, and some "unused" images are rollback paths.
  The dashboard's job is to make the safe/unsafe distinction obvious, not to
  automate the chainsaw.
- The k3s migration doubles storage during every service's dual-run phase —
  this becomes a recurring need, not a one-off.

## What Brian sees

One page (no auth needed beyond the tailnet/LAN), four panels:

1. **Disk treemap.** The 3.7T broken down: docker (images / containers /
   volumes / build cache, from `docker system df -v`), k3s containerd images
   (`k3s crictl images` or the node's `status.images`), the named model
   caches (`~/git/*/checkpoints`, `hf_cache`, `~/.cache/huggingface`,
   `/var/lib/docker/volumes/*`), and "everything else". Click a block to
   drill into the item list.
2. **Reclaim list.** Every deletable item as a row: name, size, age, last
   used, and a **risk tag** — `safe` (dangling/untagged, build cache),
   `check` (stopped container with a writable layer, unused-but-tagged
   image), `keep` (active, or referenced by a k8s manifest / compose file in
   this repo — the dashboard greps `services/` and known compose repos so it
   KNOWS ghcr.io/inference-club/* images are live rollback paths).
   Multi-select → "generate cleanup script" → copy-paste (V0) or execute
   with confirmation (V2).
3. **Memory + swap.** Current RAM/swap usage and per-process residents
   (k8s pods labeled by service, docker containers, bare processes), plus a
   "swap fossil" indicator — swap full while RAM is free means a past
   pressure event worth investigating, exactly what the migration caused.
4. **Trend.** Daily snapshot of the above (one JSON file per day, a year is
   trivial) so "disk is filling up" has a slope and an ETA.

## Data path

- A tiny collector on spark (FastAPI or a cron + static JSON): shells out to
  `docker system df -v`, `docker ps -a --size`, `docker images`,
  `crictl images`, `du` over an allowlist of cache dirs, `free`/`vmstat`.
  Read-only by construction in V0/V1.
- Serve: simplest thing that works — a static page + JSON on a port behind
  the tailnet, or (nicer) a `/design/spark-storage` style page in the
  inference.club frontend reading the collector through the agent, the same
  pathway PRD 07's /cluster/state established. Decide when building; the
  collector contract is the same either way.

## Phases

- **V0 (look):** collector + read-only page; treemap, reclaim list with risk
  tags, memory panel. Cleanup happens by copy-pasting the generated script.
- **V1 (watch):** daily snapshots + trend panel; "swap fossil" detection.
- **V2 (act):** execute reclaim from the UI with typed-confirmation, only
  ever for `safe`-tagged items; `check` items always stay manual.

## Non-goals

- Not a general fleet dashboard (PRD 07's cluster viz owns the fleet view;
  this is one box's disk and memory, deliberately boring).
- No automatic/scheduled pruning, ever — the risk tagging informs a human.
- Not a docker registry UI; GHCR cleanup is a separate (smaller) problem.

## Open questions

- Standalone page on spark vs. inference.club `/design/*` page via the agent
  pathway — consistency says the latter, isolation says the former.
- Should the collector also cover a1–a3 from day one? The panels are
  box-agnostic; spark is just the worst offender today.
- Risk-tagging heuristics for stopped containers: age alone, or diff size +
  name patterns (`*-test`, `*-old`)? Start conservative: everything is
  `check` unless provably dangling.
