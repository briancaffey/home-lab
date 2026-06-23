# Minimal headless LM Studio runtime for the GB10 (arm64 / Blackwell, CUDA 13).
#
# The lms binary, inference engines, the llmster backend, and the downloaded
# GGUF models all live on the spark HOST under ~/.lmstudio and are bind-mounted
# into the pod at runtime (see lmstudio-headless.yaml). So this image deliberately
# carries NONE of that — it only supplies the userspace libraries the CUDA
# llama.cpp engine links against that the nvidia container runtime does NOT
# inject:
#   * libcudart.so.13 / libcublas.so.13  -> from the cuda-runtime base image
#   * libgomp.so.1 (GNU OpenMP)          -> apt libgomp1
#   * libcuda.so.1 (the driver)          -> injected by runtimeClassName: nvidia
#
# Base is pinned to ubuntu24.04 to match the host glibc (2.39) the lms binary +
# engines were built against. arm64 only (the GB10 is the cluster's sole arm64
# node).
#
# Build + publish (on the spark, native arm64 — same flow as acestep/nemotron-asr):
#   docker build -t ghcr.io/inference-club/lmstudio-headless:latest-spark-arm64 .
#   docker push  ghcr.io/inference-club/lmstudio-headless:latest-spark-arm64
# Or, with no ghcr write credentials, seed it straight into k3s containerd:
#   docker save ghcr.io/inference-club/lmstudio-headless:latest-spark-arm64 \
#     | sudo k3s ctr -n k8s.io images import -
FROM nvidia/cuda:13.0.0-runtime-ubuntu24.04

RUN apt-get update \
 && apt-get install -y --no-install-recommends libgomp1 ca-certificates curl tini \
 && rm -rf /var/lib/apt/lists/*

# NVIDIA_* let the pod claim the GPU via runtimeClassName: nvidia WITHOUT holding
# the device-plugin's single nvidia.com/gpu resource, so it co-exists with
# acestep on the GB10's unified memory (see manifest).
ENV NVIDIA_VISIBLE_DEVICES=all \
    NVIDIA_DRIVER_CAPABILITIES=all \
    LMS_HOME=/home/brian \
    LMS_PORT=1234 \
    LMS_BIND=0.0.0.0 \
    LMS_MODEL=qwen/qwen3.6-27b \
    LMS_CONTEXT_LENGTH=8192 \
    LMS_GPU=max

COPY entrypoint.sh /usr/local/bin/lms-entrypoint.sh
RUN chmod +x /usr/local/bin/lms-entrypoint.sh

ENTRYPOINT ["tini", "--", "/usr/local/bin/lms-entrypoint.sh"]
