# 05 — Service Directory

Everything running on the home cluster, what it does, and where to reach it on the
LAN. Live as of 2026-06-29.

**Nodes:** a1 `192.168.5.253` · a2 `192.168.5.96` · a3 `192.168.5.173` · spark `192.168.6.19`

**How access works:**
- **NodePort (`:30xxx`)** — open a browser to that port on *any* node IP (examples
  below use the node the service runs on).
- **Cluster-DNS only** — reachable from inside the cluster at
  `<svc>.<ns>.svc.cluster.local:<port>`; from your laptop use
  `kubectl port-forward` or go through the gateway/agent.
- GPU inference services **load in and out**, so some are only up when in use.

---

## 🤖 Inference — the AI models  (`inference-club` ns)

Consumed through the inference.club platform/agent, or directly. Every service
has a stable `.lan` hostname (`clusters/home/inference-lan`) — point scripts
and containers at these instead of IP:port. `/docs` on each = OpenAPI UI.

| Service | What it does | Reach it |
|---|---|---|
| nemotron-omni | LLM (multimodal, vLLM) | **https://omni.lan** · or via LiteLLM |
| nemotron-asr | Speech-to-text | **https://asr.lan** |
| magpie-tts | Text-to-speech | **https://magpie.lan** |
| flux2-klein | Image generation | **https://flux.lan** |
| ltx2 | Video generation | **https://ltx.lan** |
| studio-voice | Speech enhancement | **https://studio-voice.lan** |
| firecrawl | URL → markdown scraping | **https://firecrawl.lan** (no /docs) |
| acestep | Music generation (parked) | **https://acestep.lan** |
| dia | Voice cloning / dialogue (parked) | **https://dia.lan** |
| trellis2 | 3D mesh generation (parked) | **https://trellis.lan** |
| lmstudio | LLM headless (parked) | **https://lmstudio.lan** |

---

## 🧠 Gateway & data layer  (`observability` + `platform` ns)

| Service | What it does | Reach it |
|---|---|---|
| **LiteLLM** | One OpenAI-compatible URL for all LLMs — Admin UI, virtual keys, budgets, fallback (local→Groq/OpenRouter/NVIDIA), tracing; cloud-bound traffic is PII-redacted via Rampart | https://litellm.lan/ui · `http://192.168.5.173:30400` · `litellm.observability.svc:4000` |
| Rampart | Local PII redaction (nationaldesignstudio/rampart ONNX, a1) — playground UI + API; guards LiteLLM's cloud calls | https://rampart.lan/ · `rampart.rampart.svc:8080` |
| Postgres + pgvector | Shared SQL + vector store | `a3:5432` / `postgres.platform.svc:5432` |
| Redis | Shared cache / queue | `redis.platform.svc:6379` |
| MinIO | S3-compatible object storage | console http://192.168.5.173:30901 · S3 `:30900` |
| Qdrant | Vector database (RAG / memory) | http://192.168.5.173:30633/dashboard |

---

## 📊 Observability  (`monitoring` + `observability` ns)

| Service | What it does | Reach it |
|---|---|---|
| **Grafana** | Dashboards (GPU, host, vLLM) | http://192.168.5.173:30030 |
| Prometheus | Metrics store + scraper | http://192.168.5.173:30090 |
| Phoenix | LLM traces & evals (OTLP) | UI http://192.168.5.173:30606 · OTLP grpc `:4317` |
| dcgm-exporter | Per-GPU metrics → Prometheus | (feeds Grafana) |
| node-exporter | Host CPU/RAM/disk → Prometheus | (feeds Grafana) |

---

## 🌐 Web UIs — LAN  (`*.lan`, Traefik + mkcert TLS)

Browse over HTTPS once the name resolves — either a local `dnsmasq` wildcard
(`*.lan` → `192.168.5.173`, client-side only) or a `/etc/hosts` entry per host.
The one `*.lan` mkcert cert covers them all (copied into each namespace as a Secret;
run `mkcert -install` once per client to trust the CA).

| Service | What it does | Reach it |
|---|---|---|
| Homepage | Service dashboard (auto-discovers ingresses) | https://home.lan/ |
| Headlamp | Kubernetes dashboard | https://headlamp.lan/ |
| Kube Ops View | Live node→pod resource map (bin-packing aid) | https://kube-ops-view.lan/ |
| Open WebUI | Chat UI for local LLMs (via LiteLLM) | https://openwebui.lan/ |
| Grafana | Dashboards (also NodePort 30030) | https://grafana.lan/ |
| Jupyter | GPU JupyterLab (a2) | https://jupyter.lan/ |
| InvokeAI | Image generation (a2) | https://invokeai.lan/ |
| Jellyfin | Media server (a2, NVENC) | https://jellyfin.lan/ |
| Immich | Photos & video, CLIP semantic search + faces (a2) | https://immich.lan/ · app → `http://192.168.5.96:30283` |
| 3D Gallery | trellis2 meshes, `<model-viewer>` (a2) | https://models.lan/ |
| Navidrome | Music streaming — AI songs (a2) | https://music.lan/ · Subsonic clients → `http://192.168.5.96:30533` |
| Audiobookshelf | Audiobooks & podcasts (a3) | https://abs.lan/ |
| Paperless | PDF & document library, OCR + search (a2) | https://paperless.lan/ (user `admin`) |
| Vaultwarden | Passwords & secrets (Bitwarden-compatible, a3) | https://vault.lan/ |
| Harbor | Private container registry + UI (a2) | https://harbor.lan/ · `docker/crane … harbor.lan/<project>/<repo>` |
| Mailpit | SMTP sink + inbox for test/alert email | https://mailpit.lan/ · SMTP `mailpit-smtp.mailpit.svc.cluster.local:1025` |
| Speedtest | WAN/ISP speed tracker (a2) → Grafana | https://speedtest.lan/ · dash "Speedtest — WAN/ISP" |
| Pi-hole | Network-wide DNS ad-blocker (a2) | https://pihole.lan/admin · **DNS → `192.168.5.96:53`** (hostPort) |
| Hermes Agent | Nous Research agent — dashboard + OpenAI-compatible API, LiteLLM-driven (x1) | https://hermes.lan/ · API `https://hermes.lan/v1` (bearer key) |

---

## 🔌 MCP backends — for Claude  (`mcp` ns)

| Service | What it does | Reach it |
|---|---|---|
| SearXNG | Private, key-less web search | http://192.168.5.253:30808 |
| Excalidraw | Diagram canvas | http://192.168.5.253:30505 |
| browserless | Headless Chromium (automation) | ws://192.168.5.253:30330 · debugger `/docs` |
| firecrawl | URL scraping (also an MCP) | cluster DNS `:3002` |

---

*Secrets live only in-cluster — retrieve a value with*
`kubectl -n <ns> get secret <name> -o jsonpath='{.data.<key>}' | base64 -d`.
*Full design + apply steps: [04-services-expansion.md](04-services-expansion.md).*
