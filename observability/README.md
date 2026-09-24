# observability/ — OTLP backends for the agents (and LiteLLM)

Every self-hostable backend that [hermes-otel](https://github.com/briancaffey/hermes-otel)
supports runs here from its **official Helm chart** as a Helm release (values in git,
secrets via External Secrets ← Vaultwarden), each with a `<name>.lan` Traefik
ingress and a Homepage tile. They are dev/validation targets: single-node, pinned
to **a2** (Phoenix/Langfuse/LiteLLM on a3), `local-path` PVCs. Bring one up or tear
it down with the `helm upgrade --install` / `helm uninstall` in its README; the
cluster Hermes (`clusters/home/hermes/hermes-otel-config.yaml`) fans every turn out
to all of them, so a backend that is down only costs dropped batches.

| dir | backend | hermes-otel `type` | traces | metrics | logs | UI | chart |
|---|---|---|---|---|---|---|---|
| `phoenix/` | Arize Phoenix | `phoenix` | ✅ | ❌ | ❌ | https://phoenix.lan | `arizephoenix/phoenix-helm` (OCI) |
| `langfuse/` | Langfuse v4 | `langfuse` | ✅ | ❌ | ❌ | https://langfuse.lan | `langfuse/langfuse` |
| `openobserve/` | OpenObserve | `openobserve` | ✅ | ✅ | ✅ | https://openobserve.lan | `openobserve/openobserve-standalone` |
| `jaeger/` | Jaeger v2 | `jaeger` | ✅ | ❌ | ❌ | https://jaeger.lan | `jaegertracing/jaeger` |
| `tempo/` | Grafana Tempo | `tempo` | ✅ | ❌ | ❌ | Grafana Explore | `grafana-community/tempo` |
| `lgtm/` | OTel Collector gateway → Tempo + Prometheus | `lgtm` | ✅ | ✅ | ⏳ Loki 3 (#14) | Grafana | `open-telemetry/opentelemetry-collector` |
| `signoz/` | SigNoz | `signoz` | ✅ | ✅ | ✅ | https://signoz.lan | `signoz/signoz` |
| `uptrace/` | Uptrace | `uptrace` | ✅ | ✅ | ✅ | https://uptrace.lan | `uptrace/uptrace` (+ own ClickHouse/Postgres) |
| `parseable/` | Parseable OSS | `otlp` ×3 (see README) | ✅ | ✅ | ✅ | https://parseable.lan | `parseable/parseable` |
| `litellm/` | LiteLLM gateway (exports to Phoenix) | — | | | | https://litellm.lan | raw manifests |

SaaS-only hermes-otel backends (LangSmith, Honeycomb, W&B Weave, telemetry.dev)
are not deployed; Weave stays configured as a cloud backend. Tracking:
home-lab#1 and the per-backend issues #6–#15; upstream backend list in
briancaffey/hermes-otel#232.

## Shared conventions
- Namespace `observability`. Helm repos are added in each README.
- LAN TLS: add the host to `scripts/lan-certs.sh` (`HOSTS` + `<name>-tls:observability`), run it.
- Secrets: Vaultwarden items `observability-<secret>` → `clusters/home/external-secrets/secrets/observability-<secret>.yaml`.
  The Hermes-side credentials are mirrored into `hermes-secrets` from the same items.
- Argo CD does not manage these releases (helm CLI, like Phoenix and Langfuse);
  the Hermes config, External Secrets and monitoring changes are Argo-managed
  and only take effect after a push.
- Smoke test an OTLP endpoint from inside the cluster:
  `kubectl -n observability run curl --image=curlimages/curl --rm -it --restart=Never -- curl -X POST -H 'Content-Type: application/json' -d '{"resourceSpans":[]}' http://<svc>:4318/v1/traces`
