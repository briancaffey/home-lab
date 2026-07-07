/**
 * Browser entry for the WebGPU latency harness.
 *
 * Runs the exact shipped detection path (heuristics → premask → NER → policy)
 * the same way `eval/bench/run.ts` does, but inside a real Chromium tab with the
 * NER model executing on the WebGPU backend. The Node bench measures ORT-CPU
 * latency; this measures the form factor that actually ships to the browser.
 *
 * `bun eval/bench/webgpu.ts` bundles this for the browser, serves it, drives it
 * with Playwright, and writes the latency summary.
 */

import { env } from "@huggingface/transformers";
import { detectHeuristics } from "../../../src/heuristics";
import { detectNer, loadNerClassifier, type TokenClassifier } from "../../../src/ner/classifier";
import { applyPolicy } from "../../../src/policy";
import { premask, projectMaskedSpan } from "../../../src/premask";
import type { Span } from "../../../src/types";

interface BenchOptions {
  readonly modelBaseUrl: string;
  readonly device: "webgpu" | "wasm";
}

let classifier: TokenClassifier | null = null;

/** Configure transformers.js to fetch the committed local model over HTTP. */
function configureEnv(baseUrl: string): void {
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  // transformers.js resolves a model id against localModelPath; "model" → /model.
  env.localModelPath = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
}

async function init(opts: BenchOptions): Promise<{ ok: true; adapter: string }> {
  configureEnv(opts.modelBaseUrl);
  classifier = await loadNerClassifier({ device: opts.device });
  const gpu = (navigator as unknown as { gpu?: { requestAdapter: () => Promise<{ info?: { vendor?: string; architecture?: string } } | null> } }).gpu;
  const adapter = gpu ? await gpu.requestAdapter() : null;
  const info = adapter?.info;
  return { ok: true, adapter: info ? `${info.vendor ?? "?"}/${info.architecture ?? "?"}` : "n/a" };
}

/** One row through the shipped pipeline; returns wall-clock ms for the row. */
async function scrubOnceTimed(text: string): Promise<number> {
  if (!classifier) throw new Error("classifier not initialised");
  const t0 = performance.now();
  const heuristic = detectHeuristics(text);
  const map = premask(text, heuristic);
  const masked = await detectNer(map.masked, classifier);
  const modelSpans: Span[] = [];
  for (const s of masked) {
    const projected = projectMaskedSpan(s, text, map);
    if (projected !== null) modelSpans.push(projected);
  }
  applyPolicy([...heuristic, ...modelSpans]);
  return performance.now() - t0;
}

async function run(texts: readonly string[], warmup: number, iters: number): Promise<{ latencies: number[]; cold: number }> {
  // Cold start: first inference pays model-graph compilation.
  const cold = await scrubOnceTimed(texts[0]);
  for (let i = 0; i < warmup; i++) await scrubOnceTimed(texts[i % texts.length]);
  const latencies: number[] = [];
  for (let i = 0; i < iters; i++) latencies.push(await scrubOnceTimed(texts[i % texts.length]));
  return { latencies, cold };
}

// Exposed to Playwright via window.
(globalThis as unknown as { rampartBench: unknown }).rampartBench = { init, run };
