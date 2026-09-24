# LGTM gateway — OTel Collector in front of Grafana + Tempo + Prometheus (hermes-otel `type: lgtm`)

hermes-otel's `lgtm` type is an OTLP receiver on `:4318` with Grafana behind it —
on a laptop that is the `grafana/otel-lgtm` demo container. That image has no
chart and no durable storage (home-lab#1 says not to port it), so the k3s
version is an **OpenTelemetry Collector gateway** (official chart
`open-telemetry/opentelemetry-collector` 0.173.1, contrib image, Deployment on
**a2**, release/Service name `lgtm`) fanning out to the real pieces:

| signal  | goes to | how |
|---|---|---|
| traces  | Tempo (`observability/tempo`) | `otlphttp` → `tempo:4318`; view in Grafana Explore → Tempo |
| metrics | Prometheus (`clusters/home/monitoring`) | `otlphttp` → `prometheus:9090/api/v1/otlp` (`--web.enable-otlp-receiver`) |
| logs    | Loki | **not yet** — Loki 2.9 (`loki-stack`) has no OTLP endpoint and collector-contrib dropped its `loki` exporter; the `logs` pipeline goes to the `debug` exporter until home-lab#14 (Loki 3) |
| all three | Parseable (`observability/parseable`) | `otlphttp` with `encoding: json` + Basic auth + `X-P-Stream` per signal — Parseable OSS rejects protobuf, so this is its only feed |

## Deploy / remove
```bash
helm repo add open-telemetry https://open-telemetry.github.io/opentelemetry-helm-charts
helm upgrade --install lgtm open-telemetry/opentelemetry-collector --version 0.173.1 \
  -n observability -f observability/lgtm/values.yaml
helm uninstall lgtm -n observability        # tear down
```
Needs Tempo up and the Prometheus OTLP receiver flag (both in git).

## hermes-otel
```yaml
backends:
  - type: lgtm
    endpoint: http://lgtm.observability.svc.cluster.local:4318/v1/traces
    metrics: true
```
Verify: Grafana Explore → Tempo → `{resource.service.name="hermes-agent"}`;
Prometheus → `hermes_llm_tokens_total` (metric names per the hermes-otel metrics
reference). Collector logs: `kubectl -n observability logs deploy/lgtm`.
