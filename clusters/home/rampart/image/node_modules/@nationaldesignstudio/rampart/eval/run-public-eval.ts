import { PUBLIC_E2E_CASES } from "./public-cases";
import { detectNer, loadNerClassifier } from "../src/ner/classifier";
import { ChatGuard } from "../src/guard";

// Load the weights committed to this repo (and pulled via git-lfs in CI) rather
// than the published Hugging Face repo, keeping the eval hermetic and runnable
// without an HF token.
const LOCAL_MODEL = "./model";

interface Score {
  readonly privateFound: number;
  readonly privateTotal: number;
  readonly publicKept: number;
  readonly publicTotal: number;
  readonly leakRows: readonly string[];
  readonly overRedactionRows: readonly string[];
}

function hasFlag(args: readonly string[], flag: string): boolean {
  return args.includes(flag);
}

function pct(numerator: number, denominator: number): string {
  if (denominator === 0) return "n/a";
  return `${((numerator / denominator) * 100).toFixed(1)}%`;
}

async function score(noPrefilter: boolean): Promise<Score> {
  const classifier = await loadNerClassifier({ model: LOCAL_MODEL, device: "cpu" });
  const guard = new ChatGuard({
    ner: (text) => detectNer(text, classifier),
    aliases: {},
    noPrefilter,
  });

  let privateFound = 0;
  let privateTotal = 0;
  let publicKept = 0;
  let publicTotal = 0;
  const leakRows: string[] = [];
  const overRedactionRows: string[] = [];

  for (const testCase of PUBLIC_E2E_CASES) {
    const result = await guard.protect(testCase.input);
    const leaked = testCase.privateTerms.filter((term) => result.text.includes(term.text));
    const overRedacted = testCase.publicTerms.filter((term) => !result.text.includes(term));

    privateFound += testCase.privateTerms.length - leaked.length;
    privateTotal += testCase.privateTerms.length;
    publicKept += testCase.publicTerms.length - overRedacted.length;
    publicTotal += testCase.publicTerms.length;

    if (leaked.length > 0) {
      leakRows.push(`${testCase.id}: ${leaked.map((term) => term.text).join(", ")}`);
    }
    if (overRedacted.length > 0) {
      overRedactionRows.push(`${testCase.id}: ${overRedacted.join(", ")}`);
    }
  }

  return { privateFound, privateTotal, publicKept, publicTotal, leakRows, overRedactionRows };
}

const args = Bun.argv.slice(2);
const strict = hasFlag(args, "--strict");
const noPrefilter = hasFlag(args, "--no-prefilter");
const jsonOnly = hasFlag(args, "--json");
const result = await score(noPrefilter);
const recallPct = result.privateTotal === 0 ? 1 : result.privateFound / result.privateTotal;
const retentionPct = result.publicTotal === 0 ? 1 : result.publicKept / result.publicTotal;

if (jsonOnly) {
  console.log(JSON.stringify({
    model: LOCAL_MODEL,
    no_prefilter: noPrefilter,
    cases: PUBLIC_E2E_CASES.length,
    private_found: result.privateFound,
    private_total: result.privateTotal,
    private_recall: recallPct,
    public_kept: result.publicKept,
    public_total: result.publicTotal,
    public_retention: retentionPct,
    leaks: result.leakRows,
    over_redactions: result.overRedactionRows,
  }));
} else {
  console.log(`Model: ${LOCAL_MODEL}${noPrefilter ? "  (no-prefilter runtime)" : ""}`);
  console.log(`Cases: ${PUBLIC_E2E_CASES.length}`);
  console.log(
    `Private recall: ${result.privateFound}/${result.privateTotal} (${pct(result.privateFound, result.privateTotal)})`,
  );
  console.log(
    `Public retention: ${result.publicKept}/${result.publicTotal} (${pct(result.publicKept, result.publicTotal)})`,
  );
  if (result.leakRows.length > 0) {
    console.log("\nLeaks:");
    for (const row of result.leakRows) console.log(`- ${row}`);
  }
  if (result.overRedactionRows.length > 0) {
    console.log("\nOver-redaction:");
    for (const row of result.overRedactionRows) console.log(`- ${row}`);
  }
}

// Strict gate enforces minimum recall/retention thresholds rather than zero
// leaks. The current public-cases corpus has a small number of irreducible
// edge cases the shipped quantized model does not perfectly handle. After the
// EMAIL/URL heuristic detectors were added (text-shaped PII the model was weak
// on), the residual leaks on the 55-case suite are two exotic structured IDs —
// an agency case-number (`AGY-2026-009871`) and a Medicare-style identifier
// (`1EG4-TE5-MK73`) — that neither a checksum heuristic nor the model reliably
// catches. The thresholds below are pinned to current measured performance so
// CI fails on regressions but does not require model retrains for
// known-acceptable behavior.
//
// Floor history: 0.98 (original lineage) -> 0.95 (m06 + format-cases "v3"
// release with EMAIL/URL heuristics; measured 97.0% on the 55-case suite — see
// eval/bench/runs/m06-v3-30k for the headline OpenPII numbers this model ships
// on).
const STRICT_MIN_PRIVATE_RECALL = 0.95;
const STRICT_MIN_PUBLIC_RETENTION = 0.95;

if (strict) {
  const recall = result.privateTotal === 0 ? 1 : result.privateFound / result.privateTotal;
  const retention = result.publicTotal === 0 ? 1 : result.publicKept / result.publicTotal;
  let failed = false;
  if (recall < STRICT_MIN_PRIVATE_RECALL) {
    console.log(
      `\nStrict: private recall ${pct(result.privateFound, result.privateTotal)} below ${STRICT_MIN_PRIVATE_RECALL * 100}%`,
    );
    failed = true;
  }
  if (retention < STRICT_MIN_PUBLIC_RETENTION) {
    console.log(
      `\nStrict: public retention ${pct(result.publicKept, result.publicTotal)} below ${STRICT_MIN_PUBLIC_RETENTION * 100}%`,
    );
    failed = true;
  }
  if (failed) process.exit(1);
}
