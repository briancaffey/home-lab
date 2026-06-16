# 04 — Services Expansion: platform, observability, MCP backends

Status: **proposed + scaffolded** (2026-06-15). Manifests authored, not yet applied.

This doc plans an aggressive expansion of the home-cluster beyond raw inference:
a shared **platform data layer**, **LLM + GPU observability**, and **MCP backends**
that Claude (and the inference.club apps) lean on. It follows the existing
conventions exactly — one YAML per service, `inference-club.com/box` nodeSelectors,
local-path PVCs pinned to a node, hostPort/NodePort for LAN reach, k8s Secrets for
creds. See [00-plan.md](00-plan.md) and the [README](../README.md) for the base fleet.

## Guiding principles

1. **GPUs are the scarce resource.** Every service here is CPU/RAM-only (no
   `nvidia.com/gpu` limit) unless explicitly noted, so none of this competes with
   inference capacity. The one exception (text-embeddings-inference) takes a small,
   optional GPU slice.
2. **Shared data layer, reused everywhere.** Postgres+pgvector, Redis, MinIO and
   Qdrant are stood up once in a `platform` namespace; new services become thin
   manifests instead of full stacks (firecrawl still ships its own Redis/PG — fine,
   leave it; consolidate later if desired).
3. **Each phase is independently deployable.** No hard cross-service dependency:
   Phoenix and LiteLLM self-store; the data layer is *available for* RAG/MCP, not
   *required by* observability.
4. **arm64 caveat for `spark`.** Many platform images are amd64-first. All CPU-only
   platform/observability/MCP services are pinned to the amd64 4090 nodes
   (`a1`/`a3`); `spark`'s unified memory is reserved for inference.
5. **a2 is parked.** README flags a2 as needing a reboot (NVML driver mismatch), so
   nothing stateful is pinned there until it's healthy.

## New namespaces

| namespace       | purpose                                            |
|-----------------|----------------------------------------------------|
| `platform`      | shared data layer (Postgres, Redis, MinIO, Qdrant) |
| `observability` | LLM observability + gateway (Phoenix, LiteLLM)     |
| `mcp`           | Claude-facing backends (SearXNG, Excalidraw, browserless) |

Wired into `clusters/home/kustomization.yaml`; create them first with
`kubectl apply -k clusters/home` before applying the per-service files.

## Node / port map (new)

All NodePort UIs follow the Grafana/Prometheus pattern (reachable on every node IP;
canonical access via the pinned node).

| service       | ns            | node | in-cluster DNS                                   | NodePort | notes |
|---------------|---------------|------|--------------------------------------------------|----------|-------|
| postgres      | platform      | a3   | `postgres.platform.svc:5432`                     | hostPort 5432 (a3) | pgvector |
| redis         | platform      | a3   | `redis.platform.svc:6379`                        | —        | shared cache |
| minio         | platform      | a3   | `minio.platform.svc:9000` (s3) / `:9001` (ui)    | 30900 / 30901 | object store |
| qdrant        | platform      | a3   | `qdrant.platform.svc:6333`                       | 30633    | vector DB; UI at `/dashboard` |
| phoenix       | observability | a3   | `phoenix.observability.svc:6006` / `:4317` otlp  | 30606    | LLM traces/evals |
| litellm       | observability | a3   | `litellm.observability.svc:4000`                 | 30400    | OpenAI-compatible gateway |
| searxng       | mcp           | a1   | `searxng.mcp.svc:8080`                           | 30808    | private metasearch |
| excalidraw    | mcp           | a1   | `excalidraw.mcp.svc:80`                          | 30505    | diagram canvas |
| browserless   | mcp           | a1   | `browserless.mcp.svc:3000`                       | 30330    | headless chromium |
| dcgm-exporter | monitoring    | all  | DaemonSet `:9400/metrics`                        | —        | per-GPU metrics → Prometheus |
| node-exporter | monitoring    | all  | DaemonSet `:9100/metrics`                        | —        | host metrics → Prometheus |

## Phase A — platform data layer (`platform/`)

- **Postgres + pgvector** (`pgvector/pgvector:pg17`) — shared relational + vector
  store. 20Gi local-path PVC on a3. Root creds in Secret `platform-postgres`.
- **Redis** (`redis:alpine`) — shared cache/queue, ephemeral.
- **MinIO** (`minio/minio`) — S3-compatible object store for artifacts/datasets/
  traces. 50Gi local-path PVC. Root creds in Secret `platform-minio`.
- **Qdrant** (`qdrant/qdrant`) — dedicated vector DB for RAG + MCP memory. 20Gi PVC.

## Phase B — LLM observability + gateway (`observability/`)

- **Arize Phoenix** (`arizephoenix/phoenix`) — self-hosted OTLP trace/eval backend.
  Runs with built-in storage on a 10Gi PVC (postgres backing is a one-line swap,
  noted in the manifest). UI on 30606; OTLP grpc on 4317.
- **LiteLLM proxy** (`ghcr.io/berriai/litellm`) — single OpenAI-compatible gateway
  in front of every in-cluster LLM endpoint (nemotron-omni, lmstudio; add image/
  embeddings as they come online). Emits OTel → Phoenix and `/metrics` → Prometheus.
  Stateless + master key (Secret `litellm-secret`); add a Postgres `DATABASE_URL`
  later for virtual keys / the admin UI. **This is the keystone** — point Claude,
  apps, and the agent at one URL with per-key budgets, fallback, and full tracing.

## Phase C — deepen infra observability (extend `clusters/home/monitoring/`)

- **DCGM exporter** (`nvcr.io/nvidia/k8s/dcgm-exporter`) — DaemonSet on GPU nodes;
  per-GPU util/mem/temp/power across all four boxes (the metric most missing today).
- **node-exporter** (`prom/node-exporter`) — DaemonSet; host CPU/RAM/disk/net.
- New Prometheus scrape jobs (`dcgm`, `node`) added to `config/prometheus.yml`.
- *Future:* Loki+Promtail (logs) and Tempo (traces) into the same Grafana, both
  backed by MinIO. Scaffold lands in a follow-up to keep this change reviewable.

## Phase D — MCP backends (`mcp/`)

- **SearXNG** (`searxng/searxng`) — private, key-less metasearch → a self-hosted
  web-search MCP with no rate limits.
- **Excalidraw** (`excalidraw/excalidraw`) — diagram canvas; pairs with the
  `excalidraw-diagram-generator` skill and an MCP server for persist/update.
- **browserless/chromium** (`ghcr.io/browserless/chromium`) — headless browser grid
  for a browser-automation MCP (complements firecrawl's scraping).
- **firecrawl-as-MCP** — *already deployed*; just point a `firecrawl-mcp` client at
  the running `firecrawl.inference-club.svc:3002`. Zero new infra.

## Phase E — workflow & utility (documented, not yet scaffolded)

n8n/Windmill (automation glue), text-embeddings-inference (TEI, small GPU slice for
RAG embeddings → Qdrant/pgvector), Docling/Tika (doc → markdown), code-server,
JupyterHub. Add opportunistically.

## Meta (optional, recommended at this scale)

- **GitOps** (ArgoCD/Flux) pointed at this repo — auto-sync + drift detection as the
  service count triples under manual `kubectl apply`.
- **sealed-secrets / external-secrets** — get Secrets into git safely instead of
  one-off `kubectl create secret`.

## Apply order

```bash
# 1. namespaces
kubectl apply -k clusters/home

# 2. secrets (fill in real values — see each manifest header)
kubectl -n platform create secret generic platform-postgres \
  --from-literal=password=<PG_PASSWORD>
kubectl -n platform create secret generic platform-minio \
  --from-literal=root-user=minio --from-literal=root-password=<MINIO_PASSWORD>
kubectl -n observability create secret generic litellm-secret \
  --from-literal=master-key=sk-<MASTER_KEY>
kubectl -n mcp create secret generic searxng-secret \
  --from-literal=secret-key=<RANDOM_HEX>

# 3. services
kubectl apply -f platform/postgres/postgres.yaml
kubectl apply -f platform/redis/redis.yaml
kubectl apply -f platform/minio/minio.yaml
kubectl apply -f platform/qdrant/qdrant.yaml
kubectl apply -f observability/phoenix/phoenix.yaml
kubectl apply -f observability/litellm/litellm.yaml
kubectl apply -f mcp/searxng/searxng.yaml
kubectl apply -f mcp/excalidraw/excalidraw.yaml
kubectl apply -f mcp/browserless/browserless.yaml

# 4. monitoring extensions
kubectl apply -f clusters/home/monitoring/dcgm-exporter.yaml
kubectl apply -f clusters/home/monitoring/node-exporter.yaml
kubectl -n monitoring rollout restart deploy/prometheus
```
