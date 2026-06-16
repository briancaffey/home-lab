# Plan: docker sprawl → k3s for the home inference fleet

**Written 2026-06-11.** Motivation crystallized by today's TRELLIS outage: a
service can be "healthy but wedged" for days, `agent.yaml` drifts from reality
(qwen3-asr declared but not running; flux not even a container), nothing
restarts on failure (`restart: no` almost everywhere), and debugging means
ssh-ing box to box. Kubernetes gives us one truthful, queryable picture of
machines + services, restart/health semantics, and a place to hang monitoring.

## Decisions (made 2026-06-11)

1. **Parallel experimental agent.** A new inference.club account + API key; the
   k3s-resident agent runs alongside the untouched prod `club-host` agent until
   proven. Cutover is the LAST step.
2. **Build k8s-native discovery first.** No agent.yaml-in-ConfigMap interim.
   The Go agent gets a `kubernetes` discovery mode (see `02-k8s-discovery.md`)
   before anything serves from the cluster.
3. **Repo layout.** Helm chart for the agent lives in `inference-club-agent`
   (product, any provider can install). This repo holds Brian's fleet:
   kustomize for services, cluster config, docs, the article.
4. **First migrated service: magpie-tts (a1).** Healthy, self-contained NIM,
   clean ports — proves GPU scheduling + Service DNS + discovery + routing
   end to end. trellis2 moves later (its box has an open perf mystery).

## Requirements

- **R1**: k3s on all 4 nodes; a3 is the single server/control plane (it also
  runs workloads — it's a 4090 box). Embedded containerd (NOT the docker
  shim); docker keeps running side by side during the whole migration so
  nothing breaks before its turn.
- **R2**: `inference-club` namespace for the agent and every inference service.
- **R3**: GPU scheduling on every healthy node: nvidia RuntimeClass + NVIDIA
  device plugin (+ GPU feature discovery so node labels carry GPU model/VRAM —
  the agent reads these instead of agent.yaml's hand-typed `gpu:` blocks).
- **R4**: The agent discovers services from the k8s API via labels/annotations
  (design in 02-k8s-discovery.md) and reports a manifest at least as rich as
  agent.yaml — plus things agent.yaml never had: exact image, command + args,
  pod status, restart counts.
- **R5**: Services outside k8s still representable (LM Studio on spark's host)
  via selector-less Service + manual EndpointSlice carrying the same labels.
- **R6**: Inbound path: the backend must reach the in-cluster agent. Local
  dev: ServiceLB (klipper) on the LAN IP. Prod cutover later: tailscale
  (sidecar or operator) — same as the current agent's tailnet pathway.
- **R7**: Locally-built images (trellis2, acestep, nemotron, ltx2) need a home:
  a private registry in-cluster (or ttl: import to each node's containerd).
  Decision deferred to Phase 4 — magpie/maxine pull from ngc.nvidia.com fine.
- **R8**: Secrets (NGC_API_KEY, HF_TOKEN, inference.club API key, LM Studio
  key) become k8s Secrets, never ConfigMap/env-in-manifest.

## Phases

- **Phase 0 — prereqs (partially blocked on Brian)**
  - [ ] Reboot a2 (NVML driver/library mismatch; will kill the bare-process
        flux server → coordinate; flux won't come back up on its own).
  - [ ] Containerize flux2-klein-server (`~/git/flux2-openai-server` on a2,
        has pyproject) so it can be adopted in Phase 5.
  - [x] Inventory captured (01-inventory.md).
- **Phase 1 — cluster up**
  - [x] k3s server on a3; agents a1, a2, spark join (scripts/install-k3s-*.sh,
        needs sudo per box).
  - [x] kubeconfig merged on the Mac (`~/.kube/config`, context `home`).
  - [x] `inference-club` namespace; node labels
        (`inference-club.com/box=a1..spark`).
  - [x] nvidia RuntimeClass + device plugin on a1/a3/spark (a2 after
        reboot; GFD still TODO). Smoke test passed on all 3 GPU nodes
        2026-06-11 (device plugin v0.17.4 — v0.17.0 fails on GB10).
- **Phase 2 — agent grows k8s discovery** (in inference-club-agent repo)
  - [x] `AGENT_DISCOVERY=kubernetes` mode (commit 075b438). Deviation from
        the original design: stdlib REST against the cluster API on a 30s
        byte-diffed poll instead of client-go informers — client-go would
        dwarf every other dependency for what is four namespace-scoped LISTs,
        and the repo deliberately keeps go.sum-free Docker builds.
  - [x] Services+Pods+Nodes → manifest structs, incl. exact image/command/args
        per service and GPU facts from node labels; fixture-driven tests pass.
  - [x] Helm chart (`charts/inference-club-agent`): Deployment, SA + RBAC,
        Secret ref for API key, LoadBalancer Service, direct/tailnet values.
        helm lint clean.
  - [ ] Publish multi-arch agent image (ghcr.io/briancaffey/inference-club-agent)
        — needed before the chart can pull.
- **Phase 3 — experimental agent live**
  - [x] Dev account (k8sbot) + API key on the local dev backend.
  - [x] Chart installed (release `agent`, ns inference-club) against the dev
        backend; image ghcr.io/inference-club/inference-club-agent (public,
        amd64+arm64). 2026-06-11.
  - [x] VERIFIED end to end: agent discovered the lmstudio Service from
        labels, registered as provider club-host-k8s (direct mode,
        192.168.5.173:8090), uploaded the k8s-sourced manifest (cluster-DNS
        URL + gemma model), and served a real chat completion:
        dev backend → k8s agent → svc DNS → kube-proxy → LM Studio on the
        spark host.
  - [ ] Repeat against PROD with a fresh prod account (after Phase 4/5 prove
        more services).
- **Phase 4 — first service: magpie-tts** — DONE 2026-06-12
  - [x] Deployment+Service in services/magpie-tts (image from NGC, GPU 1,
        nodeSelector a1, labels per discovery schema; Secrets ngc-api-key +
        ngc-registry — nvcr.io pulls need a $oauthtoken imagePullSecret).
  - [x] ~~Run BOTH copies briefly~~ — impossible: magpie holds ~13.7 GiB VRAM,
        two copies never fit a1's 4090. Cutover was stop-docker-then-apply.
        (The docker copy ran with --rm, so `docker stop` deleted it.)
  - [x] k8s copy takes :9000 traffic via hostPort 9000/50051 on a1 — prod
        agent's hard-coded URL heals with zero config change. TTS verified
        end to end on the experimental account (club-host-k8s, PROCESSED,
        ~3.7s latency, 5s WAV).
  - Article notes: a1's 110G root disk filled mid-pull (kubelet evict + taint;
    fix: k3s data-dir → /mnt/d/k3s-data, same move docker made years ago);
    `latest` had moved vs the 2-week-old docker image → 30-min TRT engine
    rebuild, which the default-ish 15-min startup probe SIGKILLed in an
    infinite loop (fix: 40-min budget + emptyDir on /data so engines survive
    restarts). The pending pod with no logs was a scheduling taint, not a
    crash — kubectl describe, not logs, told the story.
- **Phase 5 — migrate the rest, one at a time** (each: containerize if needed
  → registry → manifest → labels → verify → retire docker copy)
  - [x] acestep (spark, arm64 — proves mixed-arch) — DONE 2026-06-12: music
    verified end to end via club-host-k8s (PROCESSED, ~81s, 3.6MB MP3) on
    image :v1.5-spark-arm64-r3. The torchcodec error was a red herring — root
    cause: torchaudio 2.10 removed backend dispatch, breaking ACE-Step's
    soundfile/ffmpeg save design (and torchcodec wheels can't load against
    torch 2.10's ABI anyway, so that path was unwinnable). Fixed by local
    ACE-Step commit d4765b8 (save via soundfile + ffmpeg CLI — candidate for
    an upstream PR). PROD docker copy still runs the broken image — fix lands
    at its cutover (or restart it on ace-step-1.5:spark-r3 sooner).
    History below was the original status:
  - [~] (superseded) k8s copy DEPLOYED + Ready
    2026-06-12 (image pushed to ghcr.io/inference-club/acestep:v1.5-spark-arm64,
    pull Secret ghcr-pull, manifests services/acestep; discovery verified, 3
    models in dev catalog). End-to-end music BLOCKED by a bug the migration
    EXPOSED: torchaudio 2.10 delegates all saving to torchcodec, which
    upstream's uv.lock never included → every MP3 export fails ("healthy but
    wedged" — generation runs, save dies). The PROD docker copy has the SAME
    bug (reproduced directly on :8015) — prod music has been broken since the
    image was rebuilt ~3 days ago. Fix prepared but awaiting Brian's OK on the
    FFmpeg source: torchcodec needs FFmpeg>=5 shared libs (jammy has 4.4), so
    the derived image (/tmp/acestep-torchcodec/Dockerfile on spark, tag
    spark-r2) vendors BtbN ffmpeg-8 linuxarm64 shared + uv pip install
    torchcodec + LD_LIBRARY_PATH. Smoke test = torchaudio.save of an MP3 in
    the image BEFORE pushing. Same fix applies to the prod docker copy at
    cutover.
  - [x] nemotron-asr (spark) — DONE 2026-06-12: transcription verified end to
    end via club-host-k8s (PROCESSED, ~1.5s, transcribed the magpie-k8s TTS
    clip — full TTS→STT circle inside the cluster). Image
    ghcr.io/inference-club/nemotron-asr:latest-spark-arm64, manifests
    services/nemotron-asr. GPU sharing: spark advertises 1 nvidia.com/gpu and
    acestep holds it, so nemotron uses NVIDIA_VISIBLE_DEVICES=all + the
    nvidia RuntimeClass with no resource claim (docker --gpus all semantics);
    revisit with device-plugin time-slicing when exclusivity matters. Also
    2026-06-12: acestep docker copy retired — k8s pod took :8015 via hostPort
    (prod music repaired); docker copy stopped-not-removed (rollback:
    docker start acestep-api). Nemotron CUTOVER done later same day: docker
    container + image removed (rollback = ghcr pull), k8s pod holds hostPort
    8105, transcription re-verified post-cutover (~2.7s). Spark now runs ZERO
    docker inference services — acestep/nemotron/trellis2 all k8s, LM Studio
    external by design.
  - [ ] ltx2 (a3; unwind host networking)
  - [x] trellis2 (spark) — DONE 2026-06-12, ahead of the perf-mystery gate at
    Brian's call. Verified end to end via club-host-k8s: 1024_cascade GLB
    (692k verts, 29MB) in 243s (sample 211.6s + bake 21.9s) — and the mesh
    export did NOT wedge. Perf-mystery evidence: the CPU-spin behavior
    reproduces under containerd (93% CPU / 4% GPU between GPU-burst stages),
    so docker is exonerated; spark's swap was 15/15Gi full (fossil pressure
    from duplicate docker+k8s copies). Image ghcr.io/inference-club/trellis2
    :spark-arm64; manifests services/trellis2 — NOTE the TRELLIS.2 source +
    api are hostPath-mounted from ~/git/Trellis2-DGX-Spark-Docker (the image
    is runtime-env only); HF_TOKEN in Secret hf-token. Docker container AND
    image removed (rollback = re-pull from ghcr + recreate from compose file
    in that repo); k8s pod holds hostPort 8000 → prod mesh path live.
  - [ ] flux (a2, after Phase 0 reboot + containerization)
  - [ ] LM Studio stays on the spark host; represented via R5.
- **Phase 6 — prod cutover**
  - [ ] tailscale path for the in-cluster agent; flip the real club-host
        account to the chart install; retire the docker agent + old agent.yaml.
- **Phase 7 — article** (article/draft.md grows throughout; publish after 6).

## Open questions / risks

- **TODO (Brian): review spark's memory + storage for cleanup.** Found
  2026-06-12 during the trellis2 migration: swap 15/15Gi FULL (fossil
  pressure from running duplicate docker+k8s service copies), and docker
  hoards ~365GB reclaimable — 171GB across 36 stopped containers (99% of
  container space), 157GB of unused images (85 images, 22 active), 75GB of
  build cache, 36GB of dangling volumes. Needs a deliberate pass (some
  stopped containers may be experiments worth keeping) — see the storage
  dashboard PRD in 03-prd-spark-storage-dashboard.md for the visual way to
  do this.

- inference-club-agent has UNCOMMITTED video-support WIP (router.go,
  router_test.go, agent.yaml.example) predating this effort, with
  TestRouter_TruncatedBodyFallsBackSafely failing deterministically — needs
  Brian's attention before the next agent release ships from main.

- a2 reboot timing (flux outage window) — Brian schedules.
- Registry choice for local images (R7): in-cluster registry vs GHCR private.
- DGX Spark perf mystery (TRELLIS 10–15× slowdown, idle-wedge in mesh export)
  is still open — tracked outside this plan, but Phase 5 sequencing depends
  on it.
- k3s server is a single point of failure on a3; acceptable for a homelab,
  revisit (etcd + 2nd server) only if it bites.
