# Langfuse — LLM tracing, prompts & evals

Self-hosted [Langfuse](https://langfuse.com) (v4, chart 2.1.1). Receives OTLP
traces from hermes-otel (and anything else speaking OTLP/HTTP) and is a
queryable backend for the hermes-otel dashboard's Langfuse adapter.

Deployed from the **official Helm chart** as a **Helm release** (not kustomize),
like Phoenix. The chart bundles Postgres (groundhog2k), Valkey (redis) and
SeaweedFS (S3); **ClickHouse is self-managed** (`clickhouse.yaml`, one node)
because the chart's own ClickHouse path needs the upstream ClickHouse operator
plus a Keeper cluster.

## Layout
- **App:** `langfuse-web` (UI + public API + OTLP, `:3000`) and `langfuse-worker`
  Deployments, pinned to **a3**.
- **Postgres:** `langfuse-postgresql` StatefulSet (a3, 10Gi local-path); credentials chart-managed in `langfuse-postgresql-auth`.
- **ClickHouse:** `langfuse-clickhouse` StatefulSet (a3, 30Gi local-path),
  `clickhouse/clickhouse-server:26.4.5` (Langfuse v4 needs ≥ 25.12 for its text
  indexes), no cluster DDL; own profiler logs disabled (`langfuse-clickhouse-config`).
- **Valkey:** `langfuse-redis` (a3). **SeaweedFS:** `langfuse-s3-all-in-one` (a3,
  10Gi local-path); every trace ingest is staged through its bucket.
- **Auth:** email/password login; the first user is created by the
  `LANGFUSE_INIT_*` bootstrap on first start (see below). Sign-up is open by
  default — LAN/tailnet only.

## Access
- LAN: https://langfuse.lan/ (Traefik, `langfuse-tls` mkcert secret, Homepage-discovered)
- Tailnet: https://langfuse.\<tailnet\>.ts.net/ (Tailscale operator)
- OTLP/HTTP for exporters: `https://langfuse.lan/api/public/otel/v1/traces`
  (Basic auth = project public key : secret key). In-cluster:
  `http://langfuse-web.observability.svc.cluster.local:3000/api/public/otel/v1/traces`.
- **v4 is "events-only":** the v3 read endpoints (`/api/public/traces`,
  `/observations`, `/metrics`) answer 404; read spans from
  `/api/public/v2/observations` (same Basic auth). `smoke-test.sh` exercises
  the whole path (health → OTLP export → span back via the v2 API).

## Secrets (created out-of-band — NOT committed, public repo)
```bash
kubectl -n observability create secret generic langfuse-secrets \
  --from-literal=salt="$(openssl rand -base64 32)" \
  --from-literal=encryption-key="$(openssl rand -hex 32)" \
  --from-literal=nextauth-secret="$(openssl rand -base64 32)" \
  --from-literal=clickhouse-password="$(openssl rand -hex 24)" \
  --from-literal=init-project-public-key="pk-lf-$(openssl rand -hex 16)" \
  --from-literal=init-project-secret-key="sk-lf-$(openssl rand -hex 16)" \
  --from-literal=init-user-email="admin@langfuse.lan" \
  --from-literal=init-user-password="$(openssl rand -base64 18)"
```
Read a value back, e.g. the login password or the project keys:
```bash
kubectl -n observability get secret langfuse-secrets -o jsonpath='{.data.init-user-password}' | base64 -d; echo
kubectl -n observability get secret langfuse-secrets -o jsonpath='{.data.init-project-public-key}' | base64 -d; echo
```
The `LANGFUSE_INIT_*` values only apply on the very first start (empty DB);
changing them later does nothing. `salt` / `encryption-key` must never change
once data exists (API-key hashes and encrypted fields depend on them).

## Deploy / upgrade
```bash
# 0. Secret above (one-time). 1. TLS secret for langfuse.lan (one-time / on rotation)
bash scripts/lan-certs.sh

# 2. ClickHouse (raw manifest), then the release
kubectl apply -f observability/langfuse/clickhouse.yaml
helm repo add langfuse https://langfuse.github.io/langfuse-k8s && helm repo update langfuse
helm upgrade --install langfuse langfuse/langfuse --version 2.1.1 \
  -n observability -f observability/langfuse/values.yaml

# 3. Ingresses (raw manifests)
kubectl apply -f observability/langfuse/ingress-lan.yaml
kubectl apply -k clusters/home/tailscale     # includes ingress-langfuse.yaml
```
First start runs Postgres + ClickHouse migrations; the web pod is ready after
roughly a minute, the worker follows.

## Recovery: `Error: P3009` (a migration was interrupted)
Seen on the very first install (2026-09-19): the chart's default liveness probe
killed `langfuse-web` mid-way through the 438 Prisma migrations, Prisma recorded
`20240104210051_add_model_indices` as *failed*, and every later start refused to
migrate (649 crash-loops). Postgres DDL is transactional, so nothing partial was
left behind — the fix is to tell Prisma the migration rolled back and start again:

```bash
# park the app, give the web container a shell
kubectl -n observability scale deploy langfuse-worker --replicas=0
kubectl -n observability patch deploy langfuse-web --type=json \
  -p '[{"op":"add","path":"/spec/template/spec/containers/0/command","value":["sleep","infinity"]}]'
POD=$(kubectl -n observability get pods -l app=web -o name | head -1)
kubectl -n observability exec $POD -- sh -c 'cd /app && \
  export DATABASE_URL="postgresql://$DATABASE_USERNAME:$DATABASE_PASSWORD@$DATABASE_HOST:5432/$DATABASE_NAME" DIRECT_URL="$DATABASE_URL" && \
  prisma migrate resolve --rolled-back <failed_migration_name> --schema=packages/shared/prisma/schema.prisma'
# restore the entrypoint; migrations run on the next start (liveness allows 10 min)
kubectl -n observability patch deploy langfuse-web --type=json \
  -p '[{"op":"remove","path":"/spec/template/spec/containers/0/command"}]'
kubectl -n observability scale deploy langfuse-worker --replicas=1
```
`prisma migrate status` inside the same shell shows what is pending. The
`values.yaml` liveness settings are what prevent a repeat.

Two more things the same first install taught (2026-09-22):
- `add_model_indices` uses `CREATE INDEX CONCURRENTLY`, which is *not*
  transactional: the kill left an **invalid** `observations_model_idx` behind
  and the re-run failed with "already exists". Check
  `select indexrelid::regclass from pg_index where not indisvalid;` and
  `DROP INDEX` the invalid one before the `migrate resolve`.
- ClickHouse's migrations are golang-migrate: a failure leaves
  `schema_migrations` **dirty** ("Dirty database version N. Fix and force
  version"). Fix the cause, then force back to the last good version:
  `INSERT INTO default.schema_migrations SELECT N-1, 0, max(sequence)+1 FROM default.schema_migrations;`
  (what `migrate force N-1` does), restart `langfuse-web`. Migration 0039's
  cause was ClickHouse 25.3 — Langfuse v4 needs **>= 25.12** (26.4 shipped here).

## Notes
- **Why no chart-managed ClickHouse:** chart ≥ 2.0 renders `ClickHouseCluster` +
  `KeeperCluster` CRs for the upstream ClickHouse operator (alpha per the chart),
  which is not installed here. `clickhouse.deploy: false` + `clickhouse.host`
  points the app at the StatefulSet instead; `cluster.enabled: false` turns off
  ON CLUSTER DDL for the single node.
- Ingestion is asynchronous (web → S3 event upload → worker → ClickHouse); a
  trace appears in the UI/API a few seconds after export.
- hermes-otel docs for the exporter side: https://briancaffey.github.io/hermes-otel/backends/langfuse
