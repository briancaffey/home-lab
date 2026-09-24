# OpenObserve — traces + metrics + logs (hermes-otel `type: openobserve`)

Self-hosted [OpenObserve](https://openobserve.ai) standalone: one pod, embedded
SQLite metadata, parquet on a local-path PVC. The lightest backend that takes all
three OTLP signals. Official chart `openobserve/openobserve-standalone` 1.0.1 as a
**Helm release** (values in `values.yaml`), pinned to **a2**.

## Access
- LAN: https://openobserve.lan/ (Traefik, `openobserve-tls`, Homepage-discovered)
- Login: `admin@openobserve.lan` / password in Vaultwarden item
  `observability-openobserve-root` (ESO → Secret `openobserve-root`).
  OpenObserve enforces a password policy (upper + lower + digit + special).
- OTLP/HTTP (org `default`): `http://openobserve-openobserve-standalone.observability.svc.cluster.local:5080/api/default/v1/{traces,metrics,logs}`
  with HTTP Basic auth. Retention 14 days (`ZO_COMPACT_DATA_RETENTION_DAYS`).

## Deploy / remove
```bash
helm repo add openobserve https://charts.openobserve.ai
helm upgrade --install openobserve openobserve/openobserve-standalone --version 1.0.1 \
  -n observability -f observability/openobserve/values.yaml
kubectl apply -f observability/openobserve/ingress-lan.yaml
# tear down (keeps the PVC unless you delete it):
helm uninstall openobserve -n observability
```

## hermes-otel
```yaml
backends:
  - type: openobserve
    endpoint: http://openobserve-openobserve-standalone.observability.svc.cluster.local:5080/api/default/v1/traces
    user: admin@openobserve.lan
    password_env: OPENOBSERVE_PASSWORD     # hermes-secrets/openobserve-password
    metrics: true
```
Verify: UI → Traces → stream `default`, service `hermes-agent`.
