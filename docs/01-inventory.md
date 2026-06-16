# Fleet inventory (pre-migration, captured 2026-06-11 via ssh)

Ground truth of what actually runs where — note the drift from agent.yaml:
qwen3-asr (declared on a3:8000) is NOT running; flux (declared on a2:8000) is
a bare process, not a container; maxine-studio-voice (a1) and the open-webui
instances are unregistered.

## Nodes

| node | LAN IP | arch | GPU | notes |
|---|---|---|---|---|
| a1 | 192.168.5.253 | amd64 | RTX 4090 24GB | |
| a2 | 192.168.5.96 | amd64 | RTX 4090 24GB | ⚠ NVML driver/library mismatch (userspace 580.159 vs older loaded module). New GPU processes fail until reboot; the long-running flux process survives because it predates the upgrade. |
| a3 | 192.168.5.173 | amd64 | RTX 4090 24GB | becomes k3s control plane |
| spark | 192.168.6.19 | arm64 | DGX Spark GB10, 121GB unified | ⚠ open perf mystery: TRELLIS pipeline ~10-15x slower than 2026-06-08 baseline, mesh-export phase never completes (no throttling/driver/swap cause found). Also hosts LM Studio on :1234 (host app, stays outside k8s). |

## flux2-klein (a2) — bare process, not docker

- command: `/home/brian/git/flux2-openai-server/.venv/bin/python3 .venv/bin/flux2-klein-server`
- launched via `uv run flux2-klein-server`, cwd `/home/brian/git/flux2-openai-server`, running since May 19
- listens 0.0.0.0:8000; registered in agent.yaml as `flux-images` / model `flux-2-klein`
- has a `pyproject.toml` → containerization candidate (Phase 0)

## Containers

### magpie-tts-multilingual (a1)

- image: `nvcr.io/nim/nvidia/magpie-tts-multilingual:latest`
- entrypoint: `/bin/bash -c $SERVER_START_SCRIPT_PATH`
- network: `bridge` | restart: `no` | runtime: `nvidia` | gpu: yes
- ports: 50051/tcp→50051, 9000/tcp→9000
- mounts:
  - `/mnt/d/nim -> /opt/nim/.cache (bind)`
- env (secrets redacted):
  - `NIM_HTTP_API_PORT=9000`
  - `NIM_GRPC_API_PORT=50051`
  - `NIM_TAGS_SELECTOR=name=magpie-tts-multilingual,batch_size=8`
  - `GDRCOPY_VERSION=2.5`
  - `HPCX_VERSION=2.24`
  - `MOFED_VERSION=5.4-rdmacore56.0`
  - `OPENUCX_VERSION=1.19.0`
  - `OPENMPI_VERSION=4.1.7`
  - `RDMACORE_VERSION=56.0`
  - `EFA_VERSION=1.38.1`
  - `AWS_OFI_NCCL_VERSION=1.14.0`
  - `OPAL_PREFIX=/opt/hpcx/ompi`
  - `OMPI_MCA_coll_hcoll_enable=0`
  - `CUDA_DRIVER_VERSION=580.65.06`
- secret env vars (values NOT captured → become k8s Secrets): `NGC_API_KEY`

### maxine-studio-voice (a1)

- image: `nvcr.io/nim/nvidia/maxine-studio-voice:latest`
- entrypoint: `/bin/bash -c $SERVER_START_SCRIPT_PATH`
- network: `bridge` | restart: `no` | runtime: `nvidia` | gpu: yes
- ports: 8000/tcp→8000, 8001/tcp→8001
- env (secrets redacted):
  - `LOCAL_NIM_CACHE=/mnt/d/nim`
  - `FILE_SIZE_LIMIT=36700160`
  - `LD_LIBRARY_PATH=/usr/local/nvidia/lib:/usr/local/nvidia/lib64:/opt/tritonserver/backends/audiofx`
  - `NVIDIA_VISIBLE_DEVICES=all`
  - `NVIDIA_DRIVER_CAPABILITIES=compute,utility`
  - `NVIDIA_PRODUCT_NAME=Triton Server`
  - `SHELL=/bin/bash`
  - `TRT_VERSION=10.4.0.26`
  - `_CUDA_COMPAT_PATH=/usr/local/cuda/compat`
  - `TRITON_SERVER_VERSION=2.50.0`
  - `NVIDIA_TRITON_SERVER_VERSION=24.09`
  - `UCX_MEM_EVENTS=no`
  - `TF_ADJUST_HUE_FUSED=1`
  - `TF_ADJUST_SATURATION_FUSED=1`
- secret env vars (values NOT captured → become k8s Secrets): `NGC_API_KEY`

### ltx2-proxy (a3)

- image: `ltx2-server-dev`
- cmd: `uvicorn ltx_server.app:app --host 0.0.0.0 --port 8023`
- network: `host` | restart: `no` | runtime: `runc` | gpu: no
- mounts:
  - `/home/brian/git/LTX-2/server/workflows -> /app/workflows (bind)`
  - `/home/brian/git/LTX-2/server/ltx_server -> /app/ltx_server (bind)`
- env (secrets redacted):
  - `LTX_COMFY_URL=http://localhost:8188`
  - `LTX_OUTPUT_DIR=/tmp/out`
  - `LTX_MOCK=0`
  - `LTX_BACKEND=comfyui`
- secret env vars (values NOT captured → become k8s Secrets): `GPG_KEY`

### ltx2-comfy (a3)

- image: `ltx2-comfy`
- entrypoint: `/opt/nvidia/nvidia_entrypoint.sh`
- cmd: `python main.py --listen 0.0.0.0 --port 8188`
- network: `bridge` | restart: `no` | runtime: `runc` | gpu: yes
- ports: 8188/tcp→8188
- mounts:
  - `/mnt/d/huggingface/comfy-models -> /opt/ComfyUI/models (bind)`
- env (secrets redacted):
  - `LD_LIBRARY_PATH=/usr/local/nvidia/lib:/usr/local/nvidia/lib64`
  - `NVIDIA_VISIBLE_DEVICES=all`
  - `NVIDIA_DRIVER_CAPABILITIES=compute,utility`
  - `NVIDIA_PRODUCT_NAME=CUDA`

### trellis2-api (spark)

- image: `trellis2-dgx-spark-docker-trellis2-api`
- entrypoint: `/entrypoint.sh`
- network: `trellis2-dgx-spark-docker_default` | restart: `no` | runtime: `runc` | gpu: yes
- ports: 8000/tcp→8000
- mounts:
  - `/home/brian/git/Trellis2-DGX-Spark-Docker/triton_cache -> /workspace/cache/triton (rw)`
  - `/home/brian/git/Trellis2-DGX-Spark-Docker/torch_cache -> /workspace/cache/torch (rw)`
  - `/home/brian/git/Trellis2-DGX-Spark-Docker/TRELLIS.2 -> /workspace/TRELLIS.2 (rw)`
  - `/home/brian/git/Trellis2-DGX-Spark-Docker/api -> /workspace/TRELLIS.2/api (rw)`
  - `/home/brian/git/Trellis2-DGX-Spark-Docker/hf_cache -> /workspace/cache/huggingface (rw)`
- env (secrets redacted):
  - `HF_HOME=/workspace/cache/huggingface`
  - `NVIDIA_VISIBLE_DEVICES=all`
  - `TRELLIS2_DEFAULT_VARIANT=bf16`
  - `CUDA_HOME=/usr/local/cuda-12.9`
  - `UID=1000`
  - `API_PORT=8000`
  - `TORCH_HOME=/workspace/cache/torch`
  - `APP_SCRIPT=api`
  - `NVIDIA_DRIVER_CAPABILITIES=compute,utility`
  - `ATTN_BACKEND=flash-attn`
  - `API_HOST=0.0.0.0`
  - `TRITON_CACHE_DIR=/workspace/cache/triton`
  - `GID=1000`
  - `LD_LIBRARY_PATH=/usr/local/cuda-12.9/lib64:/usr/local/cuda/lib64`
- secret env vars (values NOT captured → become k8s Secrets): `HF_TOKEN`

### acestep-api (spark)

- image: `ace-step-1.5:spark`
- entrypoint: `/app/docker-entrypoint.sh`
- network: `ace-step-15_default` | restart: `unless-stopped` | runtime: `runc` | gpu: yes
- ports: 8001/tcp→8015
- mounts:
  - `/var/lib/docker/volumes/ace-step-15_hf_cache/_data -> /root/.cache/huggingface (rw)`
  - `/home/brian/git/ACE-Step-1.5/output -> /app/output (rw)`
  - `/home/brian/git/ACE-Step-1.5/checkpoints -> /app/checkpoints (rw)`
- env (secrets redacted):
  - `ACESTEP_CONFIG_PATH=acestep-v15-turbo`
  - `NVIDIA_VISIBLE_DEVICES=all`
  - `ACESTEP_LM_BACKEND=pt`
  - `ACESTEP_LM_MODEL_PATH=acestep-5Hz-lm-4B`
  - `ACESTEP_API_HOST=0.0.0.0`
  - `ACESTEP_USE_FLASH_ATTENTION=false`
  - `ACESTEP_API_PORT=8001`
  - `ACESTEP_MODE=api`
  - `ACESTEP_DOWNLOAD_SOURCE=huggingface`
  - `ACESTEP_INIT_LLM=true`
  - `LD_LIBRARY_PATH=/usr/local/cuda/lib64`
  - `NVIDIA_DRIVER_CAPABILITIES=compute,utility`
  - `NVIDIA_PRODUCT_NAME=CUDA`
  - `GRADIO_SERVER_NAME=0.0.0.0`
- secret env vars (values NOT captured → become k8s Secrets): `TOKENIZERS_PARALLELISM`

### nemotron-asr-server (spark)

- image: `nemotron-asr-server:latest`
- entrypoint: `/opt/nvidia/nvidia_entrypoint.sh`
- cmd: `python -m uvicorn app.main:app --host 0.0.0.0 --port 8000`
- network: `nemotron-asr-server_default` | restart: `unless-stopped` | runtime: `runc` | gpu: yes
- ports: 8000/tcp→8105
- mounts:
  - `/home/brian/.cache/huggingface -> /root/.cache/huggingface (rw)`
- env (secrets redacted):
  - `NEMOTRON_ASR_EAGER_LOAD=true`
  - `HF_HOME=/root/.cache/huggingface`
  - `NEMOTRON_ASR_MODEL=nvidia/nemotron-3.5-asr-streaming-0.6b`
  - `NEMOTRON_ASR_DEFAULT_LANGUAGE=auto`
  - `GDRCOPY_VERSION=2.5`
  - `HPCX_VERSION=2.24.1`
  - `MOFED_VERSION=5.4-rdmacore56.0`
  - `OPENUCX_VERSION=1.19.0`
  - `OPENMPI_VERSION=4.1.7`
  - `RDMACORE_VERSION=56.0`
  - `EFA_VERSION=1.38.1`
  - `AWS_OFI_NCCL_VERSION=1.14.0`
  - `OPAL_PREFIX=/opt/hpcx/ompi`
  - `OMPI_MCA_coll_hcoll_enable=0`

## Migration-relevant observations

1. Almost everything is `restart: no` — a box reboot silently loses services.
2. Four images are locally built with no registry (`trellis2-*`, `ace-step-1.5:spark`,
   `nemotron-asr-server`, `ltx2-*`) — R7 in the plan.
3. ltx2-proxy uses host networking — needs unwinding into a normal Service.
4. Secrets ride as plain `-e` env vars today.
5. Raw `docker inspect` JSON archived alongside this doc would carry secrets —
   intentionally NOT committed; this summary is the durable record.
