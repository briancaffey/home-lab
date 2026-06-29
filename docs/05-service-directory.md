# 05 — Service Directory

Everything running on the home cluster, what it does, and where to reach it on the
LAN. Live as of 2026-06-27.

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

Consumed through the inference.club platform/agent, or directly where noted.

| Service | What it does | Reach it |
|---|---|---|
| nemotron-omni | LLM (multimodal, vLLM) | `spark:8000` · or via LiteLLM |
| lmstudio | LLM (host app) | `spark:1234` |
| flux2-klein | Image generation | `a2:8000` |
| ltx2 | Video generation | `a3:8023` |
| dia | Voice cloning / dialogue | `a1:8491` |
| acestep | Music generation | cluster DNS `:8015` |
| magpie-tts | Text-to-speech | cluster DNS `:9000` |
| nemotron-asr | Speech-to-text | cluster DNS `:8105` |
| trellis2 | 3D mesh generation | cluster DNS `:8000` |
| firecrawl | URL → markdown scraping | cluster DNS `:3002` |

---

## 🧠 Gateway & data layer  (`observability` + `platform` ns)

| Service | What it does | Reach it |
|---|---|---|
| **LiteLLM** | One OpenAI-compatible URL for all LLMs (budgets, fallback, tracing) | http://192.168.5.173:30400 (UI `/ui`) |
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
| Open WebUI | Chat UI for local LLMs (via LiteLLM) | https://openwebui.lan/ |
| Grafana | Dashboards (also NodePort 30030) | https://grafana.lan/ |
| Jupyter | GPU JupyterLab (a2) | https://jupyter.lan/ |
| InvokeAI | Image generation (a2) | https://invokeai.lan/ |
| Jellyfin | Media server (a2, NVENC) | https://jellyfin.lan/ |
| Audiobookshelf | Audiobooks & podcasts (a3) | https://abs.lan/ |
| Vaultwarden | Passwords & secrets (Bitwarden-compatible, a3) | https://vault.lan/ |
| Harbor | Private container registry + UI (a2) | https://harbor.lan/ · `docker/crane … harbor.lan/<project>/<repo>` |
| Speedtest | WAN/ISP speed tracker (a2) → Grafana | https://speedtest.lan/ · dash "Speedtest — WAN/ISP" |

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
