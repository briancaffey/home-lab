# Uptrace — traces + metrics + logs (hermes-otel `type: uptrace`)

[Uptrace](https://uptrace.dev) 2.0 from the official chart `uptrace/uptrace`
2.0.2 as a **Helm release** — app only. The chart's bundled stores are operator
CRs (Altinity `ClickHouseInstallation`, CloudNativePG `Cluster`, an
`OpenTelemetryCollector`), so they are disabled and the stores are two plain
StatefulSets here: `clickhouse.yaml` (ClickHouse 25.3, 20Gi) and `postgres.yaml`
(Postgres 17, 5Gi). All on **a2**.

Every credential in `values.yaml` is a `${VAR}` that Uptrace expands from the
environment; the env comes from the ESO-managed Secret `uptrace-secrets`
(Vaultwarden item `observability-uptrace-secrets`: `UPTRACE_SECRET`,
`UPTRACE_ADMIN_PASSWORD`, `UPTRACE_USER_TOKEN`, `UPTRACE_PROJECT_TOKEN`,
`CH_PASSWORD`, `PG_PASSWORD`, plus the composed `UPTRACE_DSN` for Hermes).

## Access
- LAN: https://uptrace.lan/ (Traefik, `uptrace-tls`, Homepage-discovered)
- Login: `admin@uptrace.lan` / `UPTRACE_ADMIN_PASSWORD`. Project `hermes-agent`.
- OTLP/HTTP: `http://uptrace.observability.svc.cluster.local:80/v1/{traces,metrics,logs}`,
  auth via the `uptrace-dsn` header:
  `http://<UPTRACE_PROJECT_TOKEN>@uptrace.observability.svc.cluster.local:80?grpc=4317`

## Deploy / remove
```bash
helm repo add uptrace https://charts.uptrace.dev
kubectl apply -f observability/uptrace/clickhouse.yaml -f observability/uptrace/postgres.yaml
helm upgrade --install uptrace uptrace/uptrace --version 2.0.2 \
  -n observability -f observability/uptrace/values.yaml
kubectl apply -f observability/uptrace/ingress-lan.yaml
helm uninstall uptrace -n observability && kubectl delete -f observability/uptrace/clickhouse.yaml -f observability/uptrace/postgres.yaml   # tear down
```

## hermes-otel
```yaml
backends:
  - type: uptrace
    endpoint: http://uptrace.observability.svc.cluster.local:80/v1/traces
    dsn_env: UPTRACE_DSN            # hermes-secrets/uptrace-dsn
    metrics: true
    metrics_temporality: delta
```
Verify: UI → project hermes-agent → Traces → service `hermes-agent`, or
`clickhouse-client -u uptrace -q "select service_name, count() from uptrace.spans_index group by 1"`
in `uptrace-clickhouse-0`. On every restart Uptrace logs one
`fixture.Load failed … bills_org_id_start_date_end_date_unq` (seed_data re-applied
over an existing org); it carries on serving and can be ignored.
