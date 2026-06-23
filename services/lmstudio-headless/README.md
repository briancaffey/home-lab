# lmstudio-headless

Headless [LM Studio](https://lmstudio.ai) running **inside** the cluster on the
spark (GB10, arm64), serving **Qwen3.6-27B** (multimodal + reasoning + tools) via
lms's OpenAI-compatible server. Replaces the old `services/lmstudio/` Service,
which was just a selector-less pointer at the LM Studio **desktop app** on the
host. Now the cluster owns it end to end.

## How it works

The container is deliberately tiny. The lms binary, the CUDA llama.cpp engines,
the `llmster` backend, and the 17.5 GB Qwen3.6-27B GGUF **already live on the
host** under `~/.lmstudio` — they are bind-mounted in, so **nothing is
re-downloaded**. The only libraries the engine links against that aren't already
present come from the cuda-runtime base image (`libcudart`, `libcublas`) and one
host-mounted lib (`libgomp.so.1`); the driver `libcuda` is injected by
`runtimeClassName: nvidia`.

`entrypoint.sh` runs `lms server start --bind 0.0.0.0` then
`lms load qwen/qwen3.6-27b` with an env-configurable context window / GPU offload,
and holds the foreground on a `/v1/models` health loop.

### Key facts discovered while building this

- **Writable `$HOME` is required.** The lms binary (Bun) writes
  `~/.lmstudio-home-pointer` one level *above* `.lmstudio`; we give it an
  `emptyDir` at `/home/brian` with the real `.lmstudio` mounted inside.
- **Absolute paths.** `llmster` hardcodes `/home/brian/.lmstudio/...`, so the dir
  must be mounted at that exact path and the pod runs as uid/gid 1000 (host
  `brian`).
- **Auth is mandatory.** The server rejects every request without a Bearer token
  (`sk-lm-…`) — even on loopback. The token lives in Secret `lmstudio-key`
  (`api-key`); the entrypoint and probes send it, and the agent reads the same
  secret via the Service's `api-key-secret` annotation.
- **Bind off-localhost.** Default LM Studio binds `127.0.0.1`; we pass
  `--bind 0.0.0.0` so the ClusterIP Service can reach it.
- **GPU without the device plugin.** The pod claims the GB10 via
  `runtimeClassName: nvidia` + `NVIDIA_VISIBLE_DEVICES=all` (no `nvidia.com/gpu`
  request) so it shares the GB10's 128 GiB unified memory with **acestep** (which
  holds the single `nvidia.com/gpu`).

## Configuration (Deployment env)

| env                  | default            | purpose                              |
|----------------------|--------------------|--------------------------------------|
| `LMS_MODEL`          | `qwen/qwen3.6-27b` | lms model key (`lms ls` to list)     |
| `LMS_CONTEXT_LENGTH` | `8192`             | **context window, set at load time** |
| `LMS_GPU`            | `max`              | GPU offload (`max`/`auto`/`0..1`)    |
| `LMS_PORT`           | `1234`             | server port                          |
| `LMS_API_TOKEN`      | (Secret)           | Bearer token the server requires     |

To resize the context window, bump `LMS_CONTEXT_LENGTH` (and the Service's
`context_length` annotation) and `kubectl rollout restart deploy/lmstudio-headless`.

## Deploy (default — no image build, no registry, no sudo)

The manifest runs the **stock** `nvidia/cuda:13.0.0-runtime-ubuntu24.04` image
(k3s pulls it from Docker Hub), mounts the host `~/.lmstudio` + `libgomp.so.1`,
and gets its entrypoint from a ConfigMap. Nothing to build or push:

```bash
kubectl apply -f lmstudio-headless.yaml
kubectl -n inference-club rollout status deploy/lmstudio-headless
```

Why this over a baked image: getting a custom arm64 image onto the spark needs a
privileged step either way — ghcr needs a `write:packages` PAT, and the
in-cluster registry needs `/etc/rancher/k3s/registries.yaml` installed on the
spark + a k3s-agent restart (it currently only serves the amd64 nodes). The stock
image sidesteps all of it.

## Optional: baked image

`Dockerfile` bakes the same logic (cuda runtime + `libgomp1` + `entrypoint.sh`)
into a single image, for when you'd rather pull one artifact than mount
`libgomp`. Build on the spark (native arm64), then either push to ghcr (needs a
`write:packages` PAT) or seed it into k3s containerd directly:

```bash
docker build -t ghcr.io/inference-club/lmstudio-headless:latest-spark-arm64 .
# push to ghcr (pulled via Secret ghcr-pull) ...
docker push ghcr.io/inference-club/lmstudio-headless:latest-spark-arm64
# ... or seed straight into k3s containerd (root-owned socket → one sudo):
docker save ghcr.io/inference-club/lmstudio-headless:latest-spark-arm64 \
  | sudo k3s ctr -n k8s.io images import -
```

To use it, point the Deployment `image:` at the tag and drop the `libgomp` +
`entrypoint` ConfigMap mounts (the baked image already has both).

### Smoke test

```bash
TOKEN=$(kubectl -n inference-club get secret lmstudio-key -o jsonpath='{.data.api-key}' | base64 -d)
kubectl -n inference-club run curl --rm -it --image=curlimages/curl --restart=Never -- \
  curl -s http://lmstudio-headless:1234/v1/chat/completions \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"model":"qwen/qwen3.6-27b","messages":[{"role":"user","content":"hi"}],"max_tokens":32}'
```
