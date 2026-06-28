# home-lab

Brian's home cluster: a GPU inference fleet **and** a growing set of self-hosted
services, all on k3s. Four Ubuntu boxes on one LAN, registered to inference.club
via the inference-club-agent.

| node  | LAN IP        | arch    | GPU             | role                      |
|-------|---------------|---------|-----------------|---------------------------|
| a3    | 192.168.5.173 | amd64   | RTX 4090        | k3s server (control plane) + workloads |
| a1    | 192.168.5.253 | amd64   | RTX 4090        | k3s agent                 |
| a2    | 192.168.5.96  | amd64   | RTX 4090        | k3s agent (⚠ needs reboot: NVML driver mismatch) |
| spark | 192.168.6.19  | arm64   | DGX Spark (GB10)| k3s agent                 |

- **👉 What's running & how to reach it:** [docs/05-service-directory.md](docs/05-service-directory.md)
- **👉 Stand up / apply the LAN service stack:** [clusters/home/README.md](clusters/home/README.md)

## LAN web services

Self-hosted apps, each reachable over HTTPS at `https://<name>.lan/` (Traefik
ingress + mkcert TLS) and auto-listed on the Homepage dashboard.

| service        | url               | what it is                                   |
|----------------|-------------------|----------------------------------------------|
| Homepage       | `home.lan`        | dashboard / launcher (auto-discovers ingresses) |
| Headlamp       | `headlamp.lan`    | Kubernetes dashboard                          |
| Grafana        | `grafana.lan`     | metrics + **Loki** logs + **NVIDIA DCGM** GPU dashboards |
| Open WebUI     | `openwebui.lan`   | chat UI for local LLMs (via the LiteLLM gateway) |
| JupyterLab     | `jupyter.lan`     | GPU notebooks (a2, shared 4090)               |
| InvokeAI       | `invokeai.lan`    | image generation (a2)                         |
| Jellyfin       | `jellyfin.lan`    | media server (a2, NVENC transcoding)          |
| Audiobookshelf | `abs.lan`         | audiobooks & podcasts (a3)                    |
| Vaultwarden    | `vault.lan`       | passwords & secrets (Bitwarden-compatible, a3) |

## How LAN access works

The pattern every web service follows (details + apply commands in
[clusters/home/README.md](clusters/home/README.md)):

1. **Traefik** (k3s built-in) is the single ingress on ports 80/443 of every node.
2. Each service is a `ClusterIP` Service + an `Ingress` (class `traefik`) for `<name>.lan`.
3. **TLS**: a local **mkcert** CA. `scripts/lan-certs.sh` issues one leaf cert for
   all `*.lan` hosts and creates the `*-tls` Secrets (private keys never enter git —
   see `.gitignore`). Run `mkcert -install` once per client to trust the CA.
4. **DNS** (client-side only, no network changes): a local `dnsmasq` wildcard
   resolving `*.lan` → `192.168.5.173`, or `/etc/hosts` entries per host.
5. **Homepage discovery**: ingress annotations `gethomepage.dev/{enabled,name,group,icon,href}`
   make a service appear on the dashboard automatically.

## Layout

```
docs/          00-plan / 01-inventory / 02-k8s-discovery / 05-service-directory …
clusters/home/ cluster-scoped config + per-service bases:
               namespaces, gpu (runtime + device plugin), monitoring
               (Prometheus/Grafana/Loki/DCGM), registry, agent, and one dir per
               LAN web service (homepage, headlamp, open-webui, jupyter, invokeai,
               jellyfin, audiobookshelf, vaultwarden, loki). README.md there has apply steps.
services/      one kustomize base per GPU inference service (vLLM, etc.)
mcp/           MCP backends for Claude (searxng, excalidraw, browserless)
observability/ litellm gateway, phoenix
platform/      postgres, redis, minio, qdrant
scripts/       install-k3s-*.sh (node bootstrap) · lan-certs.sh (TLS Secrets)
article/       "from docker sprawl to k3s" write-up
```

Two kinds of base live under `clusters/home/`:
- **Raw manifests** (e.g. monitoring, jupyter, invokeai, jellyfin) — `kubectl apply -k`.
- **Helm-via-kustomize** (homepage, open-webui, loki, …) — `helmCharts` + pinned
  versions + committed `values.yaml`; build with the **standalone** `kustomize
  build --enable-helm` (kubectl's embedded kustomize is too old for Helm v4).
  Kept out of the top-level kustomization so plain `kubectl apply -k clusters/home`
  still works.

## Conventions

- **GPU**: discrete-GPU pods use `runtimeClassName: nvidia`; either an exclusive
  `resources.limits nvidia.com/gpu: 1` claim, or shared access via
  `NVIDIA_VISIBLE_DEVICES=all` (no claim) when a node's single GPU is already in use.
- **Secrets** are created out-of-band (never committed) — TLS via `scripts/lan-certs.sh`;
  others with `kubectl create secret`. Retrieve a value with
  `kubectl -n <ns> get secret <name> -o jsonpath='{.data.<key>}' | base64 -d`.

## Related repos

- [inference-club-agent](https://github.com/briancaffey/inference-club-agent) —
  the agent itself; grows a `kubernetes` discovery mode and a Helm chart
  (chart lives THERE so any provider can use it; this repo only holds values).
- [inference.club](https://github.com/inference-club/inference.club) — the platform.
