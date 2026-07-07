/**
 * WebGPU latency harness.
 *
 * Bundles the shipped detection path for the browser, serves the repo over
 * http://localhost (a WebGPU secure context), drives Playwright's bundled
 * Chromium, runs warmup + timed inferences with the NER model on the WebGPU
 * backend, and writes percentile latency to `runs/<out>/latency.json`.
 *
 *   bun eval/bench/webgpu.ts                       # WebGPU, q4
 *   bun eval/bench/webgpu.ts --device wasm         # WASM baseline for contrast
 *   bun eval/bench/webgpu.ts --iters 400 --headed  # more samples, visible window
 *
 * Inputs default to the frozen held-out slice (`eval/bench/data/heldout.jsonl`,
 * materialised by `bun run bench:fetch`) so browser latency is measured over the
 * same rows as the Node bench; if that file is absent it falls back to the
 * committed `eval/public-cases.ts` chat strings. Override with `--data <path>`.
 *
 * Uses Playwright's bundled Chromium — no system Chrome required. The launch
 * strips Playwright's GPU-disabling default args and forces ANGLE/Metal so the
 * headless browser reaches the real GPU instead of the SwiftShader software
 * adapter. Point at a system Chrome with --chrome /path/to/chrome if you prefer.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join } from "node:path";
import { chromium } from "playwright";
import { PUBLIC_E2E_CASES } from "../public-cases";
import { percentile } from "./score";

const ROOT = join(import.meta.dir, "..", "..");

function arg(name: string, fallback: string): string {
  const eq = Bun.argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(`--${name}=`.length);
  const idx = Bun.argv.indexOf(`--${name}`);
  return idx >= 0 && Bun.argv[idx + 1] && !Bun.argv[idx + 1].startsWith("--") ? Bun.argv[idx + 1] : fallback;
}

/**
 * Load the benchmark input texts. Prefers the frozen held-out slice
 * (`eval/bench/data/heldout.jsonl`, gitignored, materialised by `bench:fetch`)
 * so browser latency is measured over the same rows as the Node bench; falls
 * back to the committed `public-cases.ts` chat strings when it is absent.
 */
async function loadTexts(dataPath: string): Promise<{ texts: string[]; source: string }> {
  try {
    const raw = await readFile(dataPath, "utf8");
    const texts = raw
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line).source_text as string)
      .filter((t) => typeof t === "string" && t.length > 0);
    if (texts.length) return { texts, source: dataPath };
  } catch {
    // fall through to public cases
  }
  return { texts: PUBLIC_E2E_CASES.map((c) => c.input), source: "public-cases" };
}

function resolveChrome(): string | undefined {
  // Default: Playwright's bundled Chromium (it exposes WebGPU over http://localhost).
  // Override only if you want to point at a system Chrome install.
  const override = arg("chrome", "");
  return override || undefined;
}

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".json": "application/json",
  ".onnx": "application/octet-stream",
  ".txt": "text/plain",
  ".wasm": "application/wasm",
};

async function bundleEntry(): Promise<void> {
  const result = await Bun.build({
    entrypoints: [join(import.meta.dir, "webgpu", "entry.ts")],
    target: "browser",
    format: "esm",
    outdir: join(import.meta.dir, "webgpu"),
    naming: "bundle.js",
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error("bundle failed");
  }
}

function serveRoot(): Promise<{ port: number; close: () => void }> {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname === "/" ? "/eval/bench/webgpu/index.html" : url.pathname;
    const file = Bun.file(join(ROOT, decodeURIComponent(path)));
    if (!(await file.exists())) {
      res.statusCode = 404;
      res.end("not found");
      return;
    }
    res.setHeader("Content-Type", MIME[extname(path)] ?? "application/octet-stream");
    // WebGPU + threaded WASM want cross-origin isolation; harmless for single-thread.
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
    res.end(Buffer.from(await file.arrayBuffer()));
  });
  return new Promise((resolve) => {
    server.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ port, close: () => server.close() });
    });
  });
}

async function main(): Promise<void> {
  const device = arg("device", "webgpu") as "webgpu" | "wasm";
  const itersArg = arg("iters", "");
  const warmup = Number(arg("warmup", "20"));
  const dataPath = arg("data", join(ROOT, "eval/bench/data/heldout.jsonl"));
  const headed = Bun.argv.includes("--headed");
  const outDir = join(import.meta.dir, "runs", arg("out", `${device}-q4`));

  const chrome = resolveChrome();

  await bundleEntry();
  const { port, close } = await serveRoot();
  const { texts, source } = await loadTexts(dataPath);
  // Default to one timed inference per input row (a full pass over the slice);
  // for the small public-cases set, run a few cycles so percentiles are stable.
  const iters = itersArg ? Number(itersArg) : Math.max(texts.length, source === "public-cases" ? 300 : texts.length);

  const browser = await chromium.launch({
    headless: !headed,
    executablePath: chrome,
    // Drop Playwright's GPU-disabling defaults so the bundled Chromium can reach
    // the real GPU. Without removing --use-gl=swiftshader, WebGPU silently falls
    // back to the SwiftShader software adapter (~800 ms/inference, useless here).
    ignoreDefaultArgs: ["--disable-gpu", "--use-gl=swiftshader", "--disable-gpu-compositing"],
    // --use-angle=metal is what gets the bundled headless Chromium onto Metal on
    // macOS; on Linux the Vulkan feature flag does the equivalent.
    args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--enable-features=WebGPU,Vulkan,Metal", "--ignore-gpu-blocklist"],
  });
  try {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });
    await page.goto(`http://localhost:${port}/`, { waitUntil: "load" });
    await page.waitForFunction(() => "rampartBench" in globalThis, { timeout: 30_000 });

    const initResult = await page.evaluate(
      async ([base, dev]) =>
        (globalThis as unknown as { rampartBench: { init: (o: unknown) => Promise<{ adapter: string }> } }).rampartBench.init({
          modelBaseUrl: base,
          device: dev,
        }),
      [`http://localhost:${port}`, device] as const,
    );

    const { latencies, cold } = await page.evaluate(
      async ([ts, w, it]) =>
        (globalThis as unknown as { rampartBench: { run: (t: string[], w: number, it: number) => Promise<{ latencies: number[]; cold: number }> } }).rampartBench.run(
          ts as string[],
          w as number,
          it as number,
        ),
      [texts, warmup, iters] as const,
    );

    if (!latencies.length) throw new Error(`no latencies collected. page errors: ${errors.join(" | ") || "none"}`);

    latencies.sort((a, b) => a - b);
    const summary = {
      device,
      dtype: "q4",
      adapter: initResult.adapter,
      browser: browser.version(),
      inputs: source === "public-cases" ? "public-cases" : "heldout",
      input_texts: texts.length,
      rows_scored: latencies.length,
      warmup,
      latency_ms: {
        cold,
        p50: percentile(latencies, 0.5),
        p95: percentile(latencies, 0.95),
        p99: percentile(latencies, 0.99),
        mean: latencies.reduce((a, b) => a + b, 0) / latencies.length,
      },
    };

    await mkdir(outDir, { recursive: true });
    await writeFile(join(outDir, "latency.json"), JSON.stringify(summary, null, 2) + "\n");

    const l = summary.latency_ms;
    console.log(`\n${device}/q4 on ${summary.adapter}  (${summary.browser})`);
    console.log(`inputs: ${summary.inputs} (${summary.input_texts} rows, ${summary.rows_scored} timed)`);
    console.log(`cold ${l.cold.toFixed(1)} ms · p50 ${l.p50.toFixed(2)} ms · p95 ${l.p95.toFixed(2)} ms · p99 ${l.p99.toFixed(2)} ms · mean ${l.mean.toFixed(2)} ms`);
    console.log(`wrote ${join(outDir, "latency.json")}`);
  } finally {
    await browser.close();
    close();
  }
}

await main();
