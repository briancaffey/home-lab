# SigNoz — traces + metrics + logs (hermes-otel `type: signoz`)

[SigNoz](https://signoz.io) from the official chart `signoz/signoz` 0.143.0 as a
**Helm release**: ClickHouse (single node, managed by the chart's bundled Altinity
clickhouse-operator — note it installs a cluster-scoped operator) + ZooKeeper +
`signoz` (UI/API/alerting, SQLite) + `signoz-otel-collector` + a schema migrator
Job. Everything pinned to **a2**, PVCs on local-path (ClickHouse 30Gi). The
heaviest of the new backends (~2–3 GB RAM idle).

## Access
- LAN: https://signoz.lan/ (Traefik, `signoz-tls`, Homepage-discovered).
- Login: `admin@signoz.lan` / password in Vaultwarden item `observability-signoz-admin`
  (registered once via `POST /api/v1/register`; self-hosted ingest needs no key).
  **Until the first user/org exists the collector accepts nothing**: its OpAMP
  registration fails (`failed to find or create agent` in `signoz-0`) and port
  4318 stays closed — register first, then ingest.
- OTLP: `signoz-otel-collector.observability.svc.cluster.local:4318` (HTTP) / `:4317` (gRPC).

## Deploy / remove
```bash
helm repo add signoz https://charts.signoz.io
helm upgrade --install signoz signoz/signoz --version 0.143.0 \
  -n observability -f observability/signoz/values.yaml
kubectl apply -f observability/signoz/ingress-lan.yaml
helm uninstall signoz -n observability        # tear down (PVCs + the CHI CR may need manual deletion)
```
First start takes a few minutes (operator → ClickHouse → migrator → collector).

## hermes-otel
```yaml
backends:
  - type: signoz
    endpoint: http://signoz-otel-collector.observability.svc.cluster.local:4318/v1/traces
    metrics: true
    metrics_temporality: delta      # SigNoz's preference
```
Verify: UI → Traces → service `hermes-agent`; Metrics explorer → `hermes_*`.
