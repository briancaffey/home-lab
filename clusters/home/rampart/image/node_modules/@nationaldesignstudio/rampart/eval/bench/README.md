# Native benchmark

The benchmark runs the **shipped TypeScript pipeline** — the exact
`@nationaldesignstudio/rampart` code that consumers run — over a frozen
held-out slice of [`ai4privacy/pii-masking-openpii-1.5m`](https://huggingface.co/datasets/ai4privacy/pii-masking-openpii-1.5m)
and scores it. The predictions come straight from `src/`, scored by
`eval/bench/score.ts`, so the benchmark measures the artifact it describes.

## Layout

| File | Role |
| --- | --- |
| `labels.ts` | OpenPII gold label → Rampart policy projection (default-deny, keep-set wins). |
| `score.ts` | Term-presence recall/retention (Wilson + bootstrap CI), span F1, ECE, latency. |
| `fetch.ts` | Pull the frozen held-out rows; writes the **committed manifest** (`heldout.manifest.json`) and the gitignored data. |
| `run.ts` | Run the shipped detectors + policy over the rows and emit `runs/<name>/summary.json` + `by_language.json`. |

## Reproduce

```bash
# 1. Materialise the held-out rows named in heldout.manifest.json.
#    OpenPII is public (CC BY 4.0); HF_TOKEN is optional (higher rate limits).
bun run bench:fetch --n 30000 --seed 0

# 2. Run the bench (loads nationaldesignstudio/rampart q4 from Hugging Face).
bun run bench --out eval/bench/runs/native
```

`fetch.ts` selects rows by a seeded shuffle over the validation split and pins
the exact row `uid`s in `heldout.manifest.json`, so the held-out set is frozen
and any upstream dataset drift is caught on the next fetch. The row data itself
is regenerable and gitignored; only the manifest and the `summary.json` are
committed, so every published number traces to committed evidence.

## Committed sample

`runs/sample-900/` is a committed proof run over a 900-row held-out slice (all
seven languages, `manifest.json` pins the `uid`s). It shows the shipped runtime
at **99.70%** private-term recall on that small slice — a smoke test that the
benchmark measures the same artifact it describes. The published headline
(**98.42%**) comes from the full 30k run committed in `runs/m06-v3-30k/`; scale
the manifest to the full 30k with `bun run bench:fetch --n 30000` to regenerate it.

## Metrics

Identical definitions to the figures in `MODEL_CARD.md` / `WHITEPAPER.md`:
private-term recall and public-term retention (term-presence, Wilson 95% CI),
span-F1 at IoU ∈ {1.0, 0.5, 0.0}, ECE, and Node-ONNX latency percentiles —
now measured end-to-end through the form factor that ships.

## WebGPU latency (`webgpu.ts`)

`run.ts` measures ONNX-CPU latency under Node. `webgpu.ts` measures the form
factor that actually ships: the same shipped detection path (heuristics →
premask → NER → policy), bundled for the browser and run inside a real Chromium
tab with the NER model on the **WebGPU** backend.

```bash
bun run bench:webgpu              # WebGPU, q4 (writes runs/webgpu-q4/latency.json)
bun run bench:webgpu:wasm         # WASM backend baseline for contrast
bun eval/bench/webgpu.ts --headed --iters 400
```

By default it times one inference per row over the frozen held-out slice
(`eval/bench/data/heldout.jsonl`, materialised by `bench:fetch`), so browser
latency is measured over the same OpenPII rows as the Node bench. When that file
is absent it falls back to the committed `eval/public-cases.ts` chat strings;
override with `--data <path>`.

It serves the repo over `http://localhost` (a WebGPU secure context — `about:blank`
will not expose `navigator.gpu`) and drives **Playwright's bundled Chromium** — no
system Chrome required. The launch strips Playwright's GPU-disabling default args
(notably `--use-gl=swiftshader`) and forces ANGLE/Metal, so the headless browser
reaches the real GPU (`apple/metal-3`) instead of the SwiftShader software adapter
(which is ~400× slower and meaningless for latency). Pass `--chrome /path/to/chrome`
to use a system Chrome instead.

Latency is hardware-dependent and machine-specific, so latency runs are **not
committed** (`runs/*/latency.json` is gitignored — regenerate locally). For
reference, an 800-row held-out slice, q4, on Apple Metal:

| Backend | p50 | p95 | p99 | mean |
| --- | --: | --: | --: | --: |
| WebGPU | 3.9 ms | 9.3 ms | 13.4 ms | 4.8 ms |
| WASM | 12.6 ms | 35.5 ms | 53.7 ms | 15.8 ms |

The Node ONNX (CPU) bench is 6.6 ms p50 over the full 30k slice — so WebGPU beats
Node CPU and WASM is the no-GPU floor. Reproduce with `bun run bench:webgpu` on
your own hardware.


