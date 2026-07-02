// Build-time warmup: pull the model into TRANSFORMERS_CACHE and prove the full
// pipeline works, so the shipped image is self-contained and fails at build
// (not at pod start) if the weights are unreachable.
import { initClassifier, newGuard } from "./guard-runtime.mjs";

await initClassifier();
const guard = newGuard();
const r = await guard.protect("My name is Alex Rivera and my SSN is 472-81-0094.");
if (!r.text.includes("[SSN_1]")) {
  throw new Error(`warmup pipeline check failed: ${r.text}`);
}
console.log("warmup ok:", r.text);
