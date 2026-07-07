/**
 * The native bench: run the shipped pipeline over the frozen held-out set and
 * emit `summary.json` / `by_language.json`. The predictions come from the exact
 * TypeScript code that ships, scored by the TypeScript code under test.
 *
 *   bun eval/bench/run.ts --out eval/bench/runs/native
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { detectHeuristics } from "../../src/heuristics";
import { detectNer, loadNerClassifier, RAMPART_MODEL_ID } from "../../src/ner/classifier";
import { applyPolicy } from "../../src/policy";
import { premask, projectMaskedSpan } from "../../src/premask";
import type { Span } from "../../src/types";
import { mapOpenPiiLabel } from "./labels";
import { type GoldSpan, type PredSpan, percentile, redactText, Stratum, termPresence, expectedCalibrationError } from "./score";

const IOU_THRESHOLDS = [1, 0.5, 0];

interface Row {
  uid: number;
  language: string;
  source_text: string;
  privacy_mask: { label: string; start: number; end: number; value: string }[];
}

function arg(name: string, fallback: string): string {
  const eq = Bun.argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(`--${name}=`.length);
  const idx = Bun.argv.indexOf(`--${name}`);
  return idx >= 0 && Bun.argv[idx + 1] && !Bun.argv[idx + 1].startsWith("--") ? Bun.argv[idx + 1] : fallback;
}

/** Build gold terms + redact-target spans for one row from the OpenPII privacy mask. */
function buildGold(row: Row): { priv: string[]; pub: string[]; spans: GoldSpan[] } {
  const priv: string[] = [];
  const pub: string[] = [];
  const spans: GoldSpan[] = [];
  for (const entry of row.privacy_mask) {
    const value = (entry.value ?? "").trim();
    if (!value || !row.source_text.includes(value)) continue;
    const ours = mapOpenPiiLabel(entry.label);
    if (ours === "O") {
      pub.push(value);
    } else {
      priv.push(value);
      const start = row.source_text.indexOf(value);
      spans.push({ label: ours, start, end: start + value.length });
    }
  }
  return { priv, pub, spans };
}

async function main(): Promise<void> {
  const dataPath = arg("data", "eval/bench/data/heldout.jsonl");
  const outDir = arg("out", "eval/bench/runs/native");
  const noPrefilter = process.argv.includes("--no-prefilter");
  const modelOnly = process.argv.includes("--model-only");

  const model = arg("model", RAMPART_MODEL_ID);
  const rows: Row[] = (await readFile(dataPath, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
  const classifier = await loadNerClassifier({ model, device: "cpu" });

  const overall = new Stratum();
  const byLang = new Map<string, Stratum>();
  const latencies: number[] = [];
  const calibration: [number, boolean][] = [];

  for (const row of rows) {
    const { priv, pub, spans: gold } = buildGold(row);

    const t0 = performance.now();
    // Match the shipped runtime: premask SSN/CC/IP_ADDRESS to sentinels before
    // the model unless --no-prefilter is set (npf models trained on raw digits).
    // --model-only skips heuristics entirely (model is the only detector).
    const heuristic = modelOnly ? [] : detectHeuristics(row.source_text);
    let modelSpans: Span[];
    if (noPrefilter || modelOnly) {
      modelSpans = await detectNer(row.source_text, classifier);
    } else {
      const map = premask(row.source_text, heuristic);
      const masked = await detectNer(map.masked, classifier);
      modelSpans = [];
      for (const s of masked) {
        const projected = projectMaskedSpan(s, row.source_text, map);
        if (projected !== null) modelSpans.push(projected);
      }
    }
    const detected: Span[] = [...heuristic, ...modelSpans];
    const redactSpans = applyPolicy(detected); // non-overlapping, keep-set filtered — exactly what ships
    latencies.push(performance.now() - t0);

    const pred: PredSpan[] = redactSpans.map((s) => ({ label: s.label, start: s.start, end: s.end, score: s.score }));
    const redacted = redactText(row.source_text, redactSpans);

    const term = termPresence(redacted, priv, pub);
    overall.addTerm(term);
    overall.addSpans(gold, pred, IOU_THRESHOLDS);
    const stratum = byLang.get(row.language) ?? new Stratum();
    stratum.addTerm(term);
    stratum.addSpans(gold, pred, IOU_THRESHOLDS);
    byLang.set(row.language, stratum);

    // Calibration: per predicted span, score vs. whether it hit a gold span (IoU>=0.5).
    for (const p of pred) {
      const correct = gold.some((g) => g.label === p.label && spanIou(p, g) >= 0.5);
      calibration.push([Math.min(1, Math.max(0, p.score)), correct]);
    }
  }

  latencies.sort((a, b) => a - b);
  const summary = {
    ...overall.report(),
    calibration: { ece: expectedCalibrationError(calibration), n_pairs: calibration.length },
    latency_ms: {
      cold: latencies[latencies.length - 1] ?? 0,
      p50: percentile(latencies, 0.5),
      p95: percentile(latencies, 0.95),
      p99: percentile(latencies, 0.99),
      mean: latencies.reduce((a, b) => a + b, 0) / (latencies.length || 1),
    },
    model,
    rows_scored: rows.length,
  };
  const byLanguage = Object.fromEntries([...byLang.entries()].sort().map(([lang, s]) => [lang, s.report()]));

  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
  await writeFile(join(outDir, "by_language.json"), JSON.stringify(byLanguage, null, 2) + "\n");

  const r = summary as Record<string, any>;
  console.log(`\nRows ${r.rows}  private ${r.private_total}  public ${r.public_total}`);
  console.log(`Private recall   ${(r.private_recall * 100).toFixed(2)}%  Wilson95 [${(r.private_recall_wilson95[0] * 100).toFixed(2)}, ${(r.private_recall_wilson95[1] * 100).toFixed(2)}]  (leaked ${r.leaked})`);
  console.log(`Public retention ${(r.public_retained * 100).toFixed(2)}%`);
  console.log(`Span-F1 strict   ${r.span_f1["iou_1.00"].f1.toFixed(3)}   latency p50 ${r.latency_ms.p50.toFixed(1)} ms`);
  console.log(`By language: ${[...byLang.entries()].sort().map(([l, s]) => { const x = s.report() as any; return `${l} ${(x.private_recall * 100).toFixed(1)}%`; }).join("  ")}`);
  console.log(`\nwrote ${join(outDir, "summary.json")} + by_language.json`);
}

function spanIou(a: GoldSpan, b: GoldSpan): number {
  const inter = Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
  return inter === 0 ? 0 : inter / (Math.max(a.end, b.end) - Math.min(a.start, b.start));
}

await main();
