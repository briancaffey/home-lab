# Jaeger v2 — traces (hermes-otel `type: jaeger`)

[Jaeger](https://www.jaegertracing.io) v2 (one all-in-one binary built on the
OpenTelemetry Collector) from the official chart `jaegertracing/jaeger` 4.14.0 as
a **Helm release**, pinned to **a2**. The chart's default storage is in-memory;
`values.yaml` overrides the v2 config (`userconfig`) to **Badger** on the
`jaeger-badger` PVC (`pvc.yaml`, 10Gi local-path, spans kept 7 days). Traces only.

Gotcha: the chart mounts the config via `subPath`, so a values change does not
reach a running pod — `kubectl -n observability rollout restart deploy/jaeger`
after `helm upgrade`.

## Access
- LAN: https://jaeger.lan/ (Traefik, `jaeger-tls`, Homepage-discovered), no auth.
- OTLP: `jaeger.observability.svc.cluster.local:4318` (HTTP) / `:4317` (gRPC).

## Deploy / remove
```bash
helm repo add jaegertracing https://jaegertracing.github.io/helm-charts
kubectl apply -f observability/jaeger/pvc.yaml
helm upgrade --install jaeger jaegertracing/jaeger --version 4.14.0 \
  -n observability -f observability/jaeger/values.yaml
kubectl apply -f observability/jaeger/ingress-lan.yaml
helm uninstall jaeger -n observability        # tear down
```

## hermes-otel
```yaml
backends:
  - type: jaeger
    endpoint: http://jaeger.observability.svc.cluster.local:4318/v1/traces
```
Verify: UI → service `hermes-agent` → Find Traces.
