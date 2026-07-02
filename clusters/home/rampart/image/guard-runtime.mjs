// Shared Rampart runtime: load the ONNX token-classifier ONCE, then hand out
// cheap per-session ChatGuards that all share it. (createGuard() would reload
// the model per guard — too heavy for a multi-session server.)
import { env } from "@huggingface/transformers";
import {
  ChatGuard,
  detectNer,
  loadNerClassifier,
  RAMPART_MODEL_ID,
} from "@nationaldesignstudio/rampart";

// Weights are baked into the image at this path by `npm run warmup` during
// docker build, so the pod never needs to reach huggingface.co.
if (process.env.TRANSFORMERS_CACHE) env.cacheDir = process.env.TRANSFORMERS_CACHE;

let classifier;

export async function initClassifier() {
  classifier = await loadNerClassifier({ device: "cpu" });
  return classifier;
}

export function classifierReady() {
  return Boolean(classifier);
}

export function newGuard() {
  if (!classifier) throw new Error("classifier not loaded yet");
  return new ChatGuard({ ner: (text) => detectNer(text, classifier) });
}

export { RAMPART_MODEL_ID };
