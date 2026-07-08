# Derived Hermes image: upstream + OpenTelemetry libs for the hermes-otel
# plugin (briancaffey/hermes-otel). The plugin imports opentelemetry from the
# hermes venv, but /opt/hermes/.venv is root-owned/read-only at runtime and
# lazy installs are disabled — so the deps must be baked in at build time.
# Without them the plugin silently degrades to NoopSpan (no traces).
#
# Build (Mac, amd64 target) + push via crane (docker login to harbor.lan
# doesn't trust the mkcert CA — see docs/06-harbor.md):
#   docker buildx build --platform linux/amd64 \
#     -t harbor.lan/library/hermes-agent:v2026.6.19-otel \
#     --load clusters/home/hermes/image
#   docker save harbor.lan/library/hermes-agent:v2026.6.19-otel -o /tmp/hermes.tar
#   crane auth login harbor.lan -u <robot> -p <secret>   # creds: vault-secret.sh harbor-robot
#   crane push /tmp/hermes.tar harbor.lan/library/hermes-agent:v2026.6.19-otel
FROM nousresearch/hermes-agent:v2026.7.7

# The venv is uv-managed and ships without pip — install via uv.
RUN uv pip install --no-cache --python /opt/hermes/.venv/bin/python \
    opentelemetry-api opentelemetry-sdk opentelemetry-exporter-otlp-proto-http
