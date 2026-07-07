# 08 — Media Pipeline & Self-Hosted Storage Roadmap

*Drafted 2026-06-29. The home-lab plan for capturing everything the cluster (and
local dev) generates — music, images, video, PDFs, 3D meshes — into durable
storage and good self-hosted apps to browse, search, and stream it.*

This is a **home-lab** roadmap, distinct from inference.club product work. The
goal is to keep growing the cluster with real, well-run services and to practice
storage, ingest pipelines, and (eventually) backup/redundancy.

> **Status (2026-06-30):** Phases 0–3 are **built and verified** — MinIO
> `generations/` landing zone + scoped key, all four apps (Immich, Navidrome,
> Paperless, 3D gallery) on a2, the four fan-out CronJobs, and the `push-media`
> CLI (`scripts/push-media.sh`). Remaining: Phase 4 (inference.club sink, other
> repo) and Phase 5 (backups, deferred). One manual step per app: Immich needs an
> **External Library** pointed at `/import` (Settings → External Libraries).

---

## 1. The vision in one paragraph

You're generating a lot of media — `acestep` songs, `trellis2` 3D meshes,
`flux2`/InvokeAI images, `ltx2` videos, plus local Claude/HyperFrames PDFs and
videos. Today most of it lands in inference.club or scattered on your dev box.
The plan: **one canonical landing zone (MinIO) that any producer can push to,
and a set of purpose-built apps that ingest from it** so you can actually
*browse, search, and stream* what you make — semantic image search via CLIP, a
music player, a PDF library, and a 3D viewer.

---

## 2. Decisions locked (2026-06-29)

| Decision | Choice | Why |
|---|---|---|
| **Ingest architecture** | **MinIO landing zone + fan-out** | One source of truth; trivially backup-able; producers only learn "push to S3", decoupled from each app. |
| **Build-now scope** | **All four**: Immich, Navidrome, Paperless-ngx, 3D gallery | Each covers a distinct media type with a clear best-in-class (or only) option. |
| **Music app** | **Navidrome** (dedicated) | Purpose-built music UX + Subsonic clients on iOS/Apple TV; keeps AI songs out of your real media. |
| **Backups** | **Sketch now, defer the build** | Document the 3-2-1 strategy; stand it up in a later phase. |
| **Home node** | **a2** (~527 GB free) | Most headroom; already hosts Jellyfin/InvokeAI/Harbor. |

---

## 3. What you already have (the foundation)

| Piece | Role in this plan |
|---|---|
| **MinIO** (`platform` ns, S3, console `:30901`) | **The canonical landing zone.** Underused today — becomes central. |
| **Jellyfin** (a2, NVENC) | Stays the home for "real" video; Apple TV path already solved. |
| **Audiobookshelf** (a3) | Stays for audiobooks/podcasts — *not* the AI-music home. |
| **InvokeAI** (a2) | Image *generation* only — not a library/search tool (that's Immich's job). |
| **Postgres + pgvector / Qdrant** (`platform`) | Vector stores; Immich brings its own, but good to know they're there. |
| **Harbor** (a2) | Private registry for the 3D-gallery custom image. |
| **local-path storage** | a2 has the room. All new app PVCs pin to a2 via `nodeSelector`. |

**Generators feeding the pipeline:** `acestep` (music), `trellis2` (3D), `flux2`
+ InvokeAI (images), `ltx2` (video), `magpie-tts`/`dia` (audio), plus local
Claude/HyperFrames (PDFs, videos).

---

## 4. Architecture — MinIO landing zone + fan-out

```
  PRODUCERS                       CANONICAL STORE                 PRESENTATION APPS
                                                                  (browse / search / stream)
  inference.club ───┐
   (external sink)  │
                    ├──push──►  MinIO bucket: generations/   ──┐
  local dev CLI ────┘            ├── music/   (.mp3/.flac)    ├─►  Navidrome   music.lan
   (push-media)                  ├── images/  (.png/.jpg)     ├─►  Immich      immich.lan
                                 ├── video/   (.mp4)          ├─►  Immich / Jellyfin
                                 ├── pdf/     (.pdf)          ├─►  Paperless   paperless.lan
                                 ├── 3d/      (.glb/.gltf)    └─►  Manyfold  manyfold.lan
                                 (custom 3D gallery retired 2026-07-07, home-lab#11)
                                 └── _meta/   (sidecar .json)
                                                                  fan-out = small `mc mirror`
                                                                  CronJobs / watchers per app
```

**Principles**
1. **MinIO is the source of truth.** Every artifact lands there first, named
   `generations/<type>/<id>.<ext>`, with an optional `_meta/<id>.json` sidecar
   (prompt, model, tags, created-at). Back this one bucket up → back up
   everything.
2. **Producers only speak S3.** inference.club and the local CLI just need an
   endpoint + bucket + prefix + credentials. They never learn how Immich or
   Navidrome work.
3. **Fan-out is a cluster concern.** Each app gets a tiny sync that pulls its
   slice of the bucket into the shape the app wants. Swap/extend apps without
   touching producers.

**Fan-out mechanism (keep it boring):** one lightweight `mc mirror` per
destination — either a `CronJob` (every few minutes) or a long-running
`mc mirror --watch` sidecar. MinIO ships the `mc` client; no custom code needed
for v1.

| Destination | Sync | App behavior |
|---|---|---|
| Navidrome | `mc mirror generations/music/ → /music` PVC | auto-scans library |
| Paperless-ngx | `mc mirror generations/pdf/ → consume/` | consumes + OCRs, then removes |
| Immich | `mc mirror generations/{images,video}/ → /import` PVC | **External Library** (read-only) indexes folder |
| Manyfold | *(replaced the custom 3D gallery — home-lab#11)* | library PVC `manyfold-library`; MinIO `generations/3d/` seed/sync still to wire |

---

## 5. Service plans (build-now)

### 5.1 Immich — images + video + **CLIP** *(highest value)*
- **What:** self-hosted photo/video library with a great mobile app, **CLIP
  semantic search** ("find the picture of X"), face recognition, albums, and a
  real **API + `immich` CLI** for pipelines. This is also how you "get a CLIP
  model set up" — its ML container does it out of the box.
- **Where:** a2. Components: server, ML (CLIP/face), Postgres (pgvecto.rs),
  Redis. PVCs pinned to a2 (`local-path`).
- **CLIP/GPU note:** a2's GPU is exclusively `flux2-klein`. Run the ML container
  **on CPU first** (fine for a personal library; indexing just runs slower), or
  share the GPU later with `NVIDIA_VISIBLE_DEVICES=all` (no device-plugin claim)
  if VRAM allows. Start CPU.
- **Ingest:** `generations/images/` + `generations/video/` → synced folder →
  Immich **External Library** (read-only import; originals stay in MinIO).
- **Expose:** `immich.lan` (Traefik + mkcert); Homepage annotations; consider a
  Tailscale ingress for the mobile app on the go. Immich has its own auth.
- **Alt considered:** PhotoPrism — lighter, but weaker search and no clean
  ingest API. Immich wins.

### 5.2 Navidrome — music for `acestep` songs
- **What:** tiny, fast, Subsonic-compatible music server. Watches a folder,
  serves a clean web player, and works with a big ecosystem of iOS/Apple TV
  Subsonic clients (e.g. Amperfy, play:Sub).
- **Where:** a2. Single container + a small SQLite DB on a `local-path` PVC.
- **Ingest:** `mc mirror generations/music/ → /music`; Navidrome auto-scans.
  Embed tags (title/artist=model/prompt) in the file or a sidecar so the library
  is browsable.
- **Expose:** `music.lan`; Homepage; optional Tailscale ingress.
- **Alt considered:** reuse Jellyfin's music library (zero new service) — simpler
  but mediocre music UX and mixes AI tracks into real media. Funkwhale — overkill.

### 5.3 Paperless-ngx — PDF library
- **What:** drop a PDF in a consume folder → OCR, full-text search, tags,
  correspondents, a clean web viewer. Ideal for your "interesting debugging
  PDFs" and HyperFrames/Claude outputs.
- **Where:** a2. Components: webserver, Postgres, Redis, broker. PVCs on a2.
- **Ingest:** `mc mirror generations/pdf/ → consume/`; Paperless ingests and
  removes from the consume dir (originals remain in MinIO).
- **Expose:** `paperless.lan`; Homepage. Has its own auth.
- **Alt considered:** Stirling-PDF — that's PDF *tools* (merge/split/sign), a
  complement, not a library. Could add later.

### 5.4 3D gallery — `trellis2` meshes *(small custom build)*
- **What:** the weak spot — no mature "Immich for 3D." Plan: a tiny static web
  app that lists `generations/3d/` from MinIO and renders each `.glb`/`.gltf`
  inline with Google's `<model-viewer>` web component (orbit/zoom in-browser).
- **Where:** a2. A small Nginx/Go/Node image built via CI → Harbor → deployed.
  Reads MinIO via presigned URLs; no separate storage needed.
- **Ingest:** none — the gallery reads the bucket directly. `trellis2` outputs
  should be exported/converted to `.glb` on the way into `generations/3d/`.
- **Expose:** `models.lan`; Homepage. (No native auth — keep LAN-only, or put
  behind forward-auth when SSO lands — see §8.)
- **Alt considered:** just store in MinIO and view ad hoc — fine as a stopgap if
  the custom build slips.

---

## 6. The producer contract (how things get pushed)

### 6.1 Local dev — a `push-media` CLI
A thin wrapper around `mc cp` (or `aws s3 cp`) so any local artifact is one
command away from the cluster:

```
push-media song.mp3   --type music   [--tags "prompt=...,model=acestep"]
push-media debug.pdf  --type pdf
push-media render.mp4  --type video
push-media mesh.glb    --type 3d
```

It uploads to `generations/<type>/<id>.<ext>` and writes `_meta/<id>.json`. Ship
it as a small script in `~/bin` (and/or a repo `scripts/push-media.sh`).

### 6.2 inference.club — a generic "external sink"
Add an optional **media sink** to inference.club: an env/config block
(`MEDIA_SINK_S3_ENDPOINT`, `_BUCKET`, `_PREFIX`, `_ACCESS_KEY`, `_SECRET`). When
set, every generation is mirrored to your MinIO alongside its primary storage —
the same `generations/<type>/` contract as the local CLI. This is the "push
media to a configurable place" idea, kept minimal: inference.club stays the
authoritative store; the cluster gets a copy to present locally. *(Lives in the
inference.club repo, not here — tracked as a roadmap item.)*

---

## 7. Storage & backup strategy *(sketched — build deferred)*

Today the cluster has **no backups** (a known, flagged risk after a near
data-loss). The MinIO-as-source-of-truth design makes this tractable: protect a
short list of things and you've protected everything.

**What must be backed up**
- MinIO `generations/` bucket (the originals).
- App databases/state: Immich Postgres, Paperless Postgres + media, Navidrome
  SQLite. (3D gallery is stateless — it reads MinIO.)

**Recommended approach (when we build it):** `restic` CronJobs → **offsite S3
(Backblaze B2)** for real 3-2-1 (on-cluster + offsite). Add second-node/Longhorn
replication later for on-LAN mobility/redundancy (already on the cluster
roadmap). **Note:** the NTFS `d`/`e` drives are read-only — they cannot be backup
*targets*.

**Restore drill** belongs in the plan: a backup you've never restored isn't a
backup. *(All of this is DEFERRED — documented, not yet stood up.)*

---

## 8. Cross-cutting concerns

- **TLS / DNS:** new hosts `immich.lan`, `music.lan`, `paperless.lan`,
  `models.lan` — add each to `scripts/lan-certs.sh` and re-run (mkcert leaf).
- **Homepage discovery:** ingress **annotations** (`gethomepage.dev/*`), grouped
  e.g. under a new **"Media"** group; pod-selector for status lights.
- **Remote (Tailscale):** expose only what you'll actually use on the go — Immich
  (mobile app) and maybe Navidrome. One Ingress each in `clusters/home/tailscale/`.
- **Auth:** Immich, Paperless, Navidrome each have their own login (good). The
  3D gallery has none — keep it LAN-only for now. As user-facing apps grow,
  revisit forward-auth SSO (Authelia/Authentik) — tracked with the existing
  Headlamp/InvokeAI no-auth debt.
- **GPU:** only Immich ML wants a GPU, and a2's is taken — **CPU-first**, share
  later if needed.

---

## 9. Phased build order

| Phase | Deliverable | Notes |
|---|---|---|
| **0 — Contract** | MinIO `generations/` buckets + scoped creds + `push-media` CLI | The foundation everything else rides on. Do first. |
| **1 — Immich** | Images/video library + CLIP search on a2 | Highest value; also stands up CLIP. |
| **2 — Navidrome + Paperless** | Music player + PDF library on a2 | Quick wins; both are lightweight. |
| **3 — 3D gallery** | `<model-viewer>` gallery reading MinIO | Small custom image via CI → Harbor. |
| **4 — inference.club sink** | "External sink" S3 mirror in the product | In the inference.club repo. |
| **5 — Backups (deferred)** | restic → B2 + restore drill | Documented in §7; build when ready. |

---

## 10. Open questions / follow-ups

- **`acestep` / `trellis2` export formats** — confirm songs come out as a
  taggable audio format and meshes can export `.glb` (for `<model-viewer>`).
- **MinIO capacity & lifecycle** — `generations/` will grow; decide retention /
  lifecycle rules once volumes are real.
- **Metadata richness** — how much of the prompt/model/params to carry in the
  `_meta/` sidecars (drives search quality in Immich/Paperless).
- **inference.club sink ownership** — design the env contract in that repo; this
  doc only defines the bucket/prefix convention it must follow.
