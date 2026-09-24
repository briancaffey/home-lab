# Parseable — logs + traces + metrics (hermes-otel `type: parseable` / `otlp`)

[Parseable](https://www.parseable.com) OSS standalone (`local-store`) from the
official chart `parseable/parseable` 3.2.3 as a **Helm release**, one pod on
**a2** with data (20Gi) + staging (5Gi) local-path PVCs. Datasets are created on
first ingest; hermes-otel uses `hermes-traces`, `hermes-metrics`, `hermes-logs`.

## Access
- LAN: https://parseable.lan/ (Traefik, `parseable-tls`, Homepage-discovered)
- Login: `admin` / password in Vaultwarden item `observability-parseable-env-secret`
  (ESO → Secret `parseable-env-secret`, the chart's env secret: addr, username, password).
- OTLP/HTTP: `http://parseable-standalone-service.observability.svc.cluster.local:80/v1/{traces,metrics,logs}`
  with `X-P-Stream: <dataset>` + `X-P-Log-Source: otel-{traces,metrics,logs}` headers.

## Auth gotcha (OSS)
hermes-otel's `type: parseable` authenticates with `X-API-Key` only. Parseable
**OSS 3.2 has no API keys** (`/api/v1/apikeys` → 404) and rejects any request that
carries the header, so the explicit type does not work against this instance
(tracked upstream: briancaffey/hermes-otel — Parseable OSS Basic auth). Until
that lands, use three generic `otlp` entries with Basic auth, one per signal:
```yaml
backends:
  - type: otlp
    name: parseable-traces
    endpoint: http://parseable-standalone-service.observability.svc.cluster.local:80/v1/traces
    headers: { Authorization: "Basic ${PARSEABLE_BASIC_AUTH}", X-P-Stream: hermes-traces, X-P-Log-Source: otel-traces }
    metrics: false
    logs: false
  - type: otlp
    name: parseable-metrics
    endpoint: http://parseable-standalone-service.observability.svc.cluster.local:80/v1/traces
    headers: { Authorization: "Basic ${PARSEABLE_BASIC_AUTH}", X-P-Stream: hermes-metrics, X-P-Log-Source: otel-metrics }
    traces: false
    metrics: true
    logs: false
  - type: otlp
    name: parseable-logs
    endpoint: http://parseable-standalone-service.observability.svc.cluster.local:80/v1/traces
    headers: { Authorization: "Basic ${PARSEABLE_BASIC_AUTH}", X-P-Stream: hermes-logs, X-P-Log-Source: otel-logs }
    traces: false
    metrics: false
    logs: true
```
`PARSEABLE_BASIC_AUTH` = base64(`admin:<password>`), field `basic_auth_b64` on the
same Vaultwarden item, synced into `hermes-secrets/parseable-basic-auth`.

## Deploy / remove
```bash
helm repo add parseable https://charts.parseable.com
helm upgrade --install parseable parseable/parseable --version 3.2.3 \
  -n observability -f observability/parseable/values.yaml
kubectl apply -f observability/parseable/ingress-lan.yaml
helm uninstall parseable -n observability        # tear down
```
Verify: UI → Datasets → `hermes-traces` (Explore), or Traces/Agents views.
