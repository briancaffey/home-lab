# vLLM model slot (`spark-llm`)

One reusable vLLM (OpenAI-compatible) serving skeleton, with each model defined
as a thin overlay. Solves the "every model needs a *different set* of serve
flags, but 130 lines of boilerplate are identical" problem: the boilerplate
lives once in `base/`, and a model is ~30 lines carrying only what's unique.

```
base/                     shared skeleton — spark pin, nvidia runtime, hostIPC,
                          HF cache, probes, ports, the env tunables. NOT applied
                          directly (fails loud). Deployment/Service name = spark-llm.
models/<name>/            per-model overlay: patches image + `vllm serve` recipe
                          + env overrides + the inference-club discovery annotation.
active/                   points at the ONE model currently loaded (see below).
```

## Strict one-at-a-time (spark has a single GB10)

Every overlay keeps the name `spark-llm`, so the whole fleet is one Deployment.
Switching models is a rolling `Recreate` — the old pod releases the GPU before
the new one starts. Change the active model in one place:

```sh
# edit active/kustomization.yaml → point at models/<name>, then:
kubectl apply -k services/vllm/active
```

## Add a new model

1. `cp -r models/nemotron-omni models/<name>` (or the qwen overlay).
2. In `deployment.yaml`: set `image:` (the **vLLM version** — `:nightly` for
   bleeding-edge quant/arch support, a pinned `:vX.Y.Z` for stable), the env
   tunables (`GPU_MEM_UTIL`, `MAX_MODEL_LEN`, `MAX_NUM_SEQS`), and the
   `vllm serve <model> <flags>` recipe.
3. In `service.yaml`: set the `inference-club.com/models` annotation (its `id`
   must match `--served-model-name`) — this is what the control center shows.
4. `kustomize build models/<name>` to validate, then point `active/` at it.

## What the control center sees

The inference-club agent discovers the **running** Service (`inference-club.com/
managed: true` + the `inference-club.com/models` annotation), so the dashboard
always reflects the model currently loaded in the slot — not a menu of idle
overlays. (A UI *switcher* over the overlay catalog would be a separate agent
feature.)

## Notes

- **Not the same as `services/lmstudio-headless`** — that's the LM Studio GGUF
  path for `qwen/qwen3.6-27b`. This is the vLLM/NVFP4 path. Both want the one
  GB10, so scale the other to 0 before loading.
- Boot-time `pip install` (nemotron) is slow on every restart; a baked arm64
  vLLM image would speed swaps up, but needs the multi-arch CI path (the
  in-cluster Forgejo runner is amd64-only). Tracked as a follow-up.
