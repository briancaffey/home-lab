#!/usr/bin/env bash
# Headless LM Studio entrypoint.
#
# Starts the local OpenAI-compatible server bound to the pod network, loads ONE
# model with a configurable context window / GPU offload, then holds the
# foreground tied to server liveness so Kubernetes can probe and restart it.
#
# This is the canonical runtime script. It is shipped two ways (same logic):
#   * mounted from a ConfigMap onto the stock nvidia/cuda image (default deploy,
#     see lmstudio-headless.yaml), and
#   * COPYd into the baked image (see Dockerfile).
# It uses only bash + the lms binary — NO curl/wget — because the stock cuda
# image ships neither.
#
# Env (defaults overridable in the Deployment):
#   LMS_HOME            HOME containing .lmstudio (default /home/brian)
#   LMS_PORT            server port              (default 1234)
#   LMS_BIND            bind address             (default 0.0.0.0 — reachable via the Service)
#   LMS_MODEL           lms model key            (default qwen/qwen3.6-27b)
#   LMS_CONTEXT_LENGTH  context window at load   (default 8192)   <-- set this to resize context
#   LMS_GPU             GPU offload (max|auto|0..1, default max)
#   LMS_IDENTIFIER      served model id          (default = LMS_MODEL)
#   LMS_EXTRA_LOAD_ARGS extra flags appended to `lms load`
set -euo pipefail

export HOME="${LMS_HOME:-/home/brian}"
export PATH="$HOME/.lmstudio/bin:$PATH"

PORT="${LMS_PORT:-1234}"
BIND="${LMS_BIND:-0.0.0.0}"
MODEL="${LMS_MODEL:-qwen/qwen3.6-27b}"
CTX="${LMS_CONTEXT_LENGTH:-8192}"
GPU="${LMS_GPU:-max}"
IDENT="${LMS_IDENTIFIER:-$MODEL}"

echo "[lms] starting server on ${BIND}:${PORT}"
lms server start --bind "$BIND" --port "$PORT"

echo "[lms] loading ${MODEL} (ctx=${CTX} gpu=${GPU} id=${IDENT})"
# shellcheck disable=SC2086
lms load "$MODEL" --context-length "$CTX" --gpu "$GPU" --identifier "$IDENT" -y ${LMS_EXTRA_LOAD_ARGS:-}
lms ps

# Hold the foreground on a pure-bash TCP liveness check; exit non-zero if the
# server port stops accepting so Kubernetes restarts the pod.
echo "[lms] ready; holding foreground on tcp://127.0.0.1:${PORT}"
while bash -c "exec 3<>/dev/tcp/127.0.0.1/${PORT}" 2>/dev/null; do
  sleep 15
done

echo "[lms] server port closed; exiting for restart" >&2
exit 1
