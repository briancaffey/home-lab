# FLUX.3 image klein — NVIDIA NIM (`flux-3-image-klein-nim`)

NVIDIA's packaged FLUX.3 image klein (`nvcr.io/nim/black-forest-labs/flux-3-image-klein`,
NIM 1.0.1, SGLang Diffusion backend) on spark. OpenAI-compatible:
`POST /v1/images/generations` and `POST /v1/images/edits` (up to 8 reference images).

## Three klein deployments — keep them straight

| model id (inference.club)  | stack                          | precision | node      | dir                      |
|----------------------------|--------------------------------|-----------|-----------|--------------------------|
| `flux-3-image-klein`       | BFL reference package + upsampler | bf16   | spark     | `services/flux3-klein`   |
| `flux-3-image-klein-fp8`   | BFL reference package          | fp8       | a1 (4090) | `services/flux3-klein/a1`|
| `flux-3-image-klein-nim`   | **NVIDIA NIM** (this)          | fp8       | spark     | `services/flux3-klein-nim` |

The NIM would serve `flux-3-image-klein` by default; `NIM_SERVED_MODEL_NAME`
renames it so routing never collides.

## Where it can run

NVIDIA's support matrix: Ampere or newer, **≥48 GB GPU memory**, 48 GB RAM
(64 recommended), x86_64 or aarch64. The image is multi-arch (amd64 + arm64).
spark's GB10 (128 GB unified, Blackwell) is the supported fit; a 4090 (24 GB)
is below the stated minimum.

## Versions and profiles (NIM 1.0.1 — ids differ from the 1.0.0 docs)

`NIM_MODEL_VERSION` picks the checkpoint (NIM's default is `-base`; we run the
step-distilled one). The container auto-selects BF16; pin FP8 with
`NIM_MODEL_PROFILE`:

| version                   | precision | profile id |
|---------------------------|-----------|------------|
| `flux-3-image-klein`      | bf16      | `be8df2f08b13dbe865bf7ebb54de81df4202187010c7b78be98c45c1a3cdb9d7` |
| `flux-3-image-klein`      | fp8       | `2c9b9ddf24cf4c98f7f2f70c22f6332ff48b151917d312df980b8d099129c224` |
| `flux-3-image-klein-base` | bf16      | `ecc746ea06970891b2619357a921cc22135aa725947057b1b12bc9add937597c` |
| `flux-3-image-klein-base` | fp8       | `75c38c9510e59f5b7ecb58bcf75d25827b174daab34ee81f6237da473b627cc0` |

List them in the running pod with `list-model-profiles`.

## Notes

- NIM bundles an NVIDIA Cosmos guardrail + a SigLIP content-safety filter; both
  download with the weights.
- Weights land in spark's `~/.cache/nim` (hostPath), downloaded once.
- The image was pre-pulled on spark with a retry loop (WiFi truncates multi-GB
  layers) — after a version bump, pre-pull again before pushing the new tag.
- Credentials: `ngc-api-key` (image + NGC model files) and `hf-token` (gated BFL
  repos; licence accepted on that HF account), both ESO-managed.

## Measured (2026-11-08, step-distilled, 16 steps unless noted)

| test                      | spark BF16 | spark FP8 | a2 RTX 4090 FP8 |
|---------------------------|-----------:|----------:|----------------:|
| 1024² text-to-image       | 10.3 s     | 8.5 s     | 8.2 s           |
| 1024², 4 steps            | 3.3 s      | 3.0 s     | 2.7 s           |
| single edit               | 22 s       | 24 s      | 10.6 s          |
| edit with 8 references    | 26.5 s     | 24.9 s    | 11.8 s          |
| model process memory      | 28.2 GB    | 20.7 GB   | ~15 GB VRAM     |

- **FP8 is the production profile here**: same composition per seed as BF16,
  faster, ~7.5 GB less of spark's shared memory.
- **A 4090 works** with the FP8 profile despite the 48 GB guidance (~15 GB
  VRAM) and is the fastest box; spark stays the home because the 4090s are
  committed (a1 BFL fp8 klein, a2 TRELLIS.2, a3 control plane).
- Output is capped at ~1.06 MP (`1024x1024`, `1568x672`, …); off-grid sizes
  are silently snapped (1000² → 992²). One request at a time (no batching).
- The distilled version rejects `cfg_scale != 1` and `negative_prompt`; those
  need `-base`, whose HF licence must be accepted on the hf-token account
  (download currently 403).
- The Cosmos guardrail + SigLIP filter give false positives ("a red brick
  wall", "…mounted on a brick wall") → HTTP 422 "filtered by the safety
  checker".
- Replicas are ignored by Argo (scale by hand to free spark memory).
