# Rampart PII-redaction service — Node ONNX runtime + playground UI.
# Weights are baked in at build time (warmup.mjs) so pods start offline-safe.
#
# Build (Mac, amd64 target for a2) + push via crane (docker login to harbor.lan
# doesn't trust the mkcert CA — see docs/06-harbor.md):
#   docker buildx build --platform linux/amd64 \
#     -t harbor.lan/library/rampart:v1 --load clusters/home/rampart/image
#   docker save harbor.lan/library/rampart:v1 -o /tmp/rampart.tar
#   crane auth login harbor.lan -u <robot> -p <secret>   # creds: vault-secret.sh harbor-robot
#   crane push /tmp/rampart.tar harbor.lan/library/rampart:v1
FROM node:22-slim

ENV NODE_ENV=production \
    TRANSFORMERS_CACHE=/app/.hf-cache \
    PORT=8080

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY guard-runtime.mjs warmup.mjs server.mjs ./
COPY public ./public

# Download + verify the model at build time; the layer carries the weights.
RUN node warmup.mjs && chown -R node:node /app/.hf-cache

USER node
EXPOSE 8080
CMD ["node", "server.mjs"]
