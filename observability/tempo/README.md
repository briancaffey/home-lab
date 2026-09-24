# Grafana Tempo — traces (hermes-otel `type: tempo`)

[Tempo](https://grafana.com/oss/tempo/) single-binary from the community chart
`grafana-community/tempo` 3.0.0 (the Grafana/Tempo community charts moved to
`grafana-community.github.io` in Jan 2026; `grafana/tempo` on the old repo is a
stale 1.24.x) as a **Helm release**, StatefulSet on **a2** with a 20Gi local-path
PVC, 7-day retention. Traces only. No UI of its own: the existing Grafana has a
**Tempo** datasource (`clusters/home/monitoring/config/grafana-datasources.yml`).

## Access
- Grafana: https://grafana.lan/explore → datasource **Tempo** → TraceQL
  `{resource.service.name="hermes-agent"}`.
- OTLP: `tempo.observability.svc.cluster.local:4318` (HTTP) / `:4317` (gRPC);
  query API `:3200`.

## Deploy / remove
```bash
helm repo add grafana-community https://grafana-community.github.io/helm-charts
helm upgrade --install tempo grafana-community/tempo --version 3.0.0 \
  -n observability -f observability/tempo/values.yaml
helm uninstall tempo -n observability        # tear down
```

## hermes-otel
```yaml
backends:
  - type: tempo
    endpoint: http://tempo.observability.svc.cluster.local:4318/v1/traces
```
