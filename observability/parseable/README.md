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

## OSS gotchas (why Hermes goes through the collector)
Two things make the direct `type: parseable` backend unusable against **Parseable OSS** (3.2):
1. **No API keys.** The explicit type authenticates with `X-API-Key` only;
   OSS has no `/api/v1/apikeys` (404) and rejects any request carrying the header (401).
2. **No protobuf.** OSS answers `400 Protobuf ingestion is not supported in
   Parseable OSS` to OTLP/protobuf, which is all the Python OTLP exporter sends.

So Hermes does not talk to Parseable directly. The **lgtm collector gateway**
(`observability/lgtm`) has three `otlphttp` exporters with `encoding: json`,
Basic auth and the `X-P-Stream` / `X-P-Log-Source` headers, one per signal, so
everything hermes-otel sends to `type: lgtm` also lands in `hermes-traces`,
`hermes-metrics` and `hermes-logs`. Datasets are created on first ingest.
(Upstream: the hermes-otel Parseable docs assume Parseable Cloud/Enterprise.)

## Deploy / remove
```bash
helm repo add parseable https://charts.parseable.com
helm upgrade --install parseable parseable/parseable --version 3.2.3 \
  -n observability -f observability/parseable/values.yaml
kubectl apply -f observability/parseable/ingress-lan.yaml
helm uninstall parseable -n observability        # tear down
```
Verify: UI → Datasets → `hermes-traces` (Explore), or Traces/Agents views.
