/**
 * ChatGuard: per-conversation PII filter for wiring into a chat app.
 *
 *   const guard = await createGuard();
 *   const safe = await guard.protect(userInput);
 *   const reply = await llm(safe.text);
 *   guard.reveal(reply);                    // non-streaming
 *   stream.pipeThrough(guard.revealTransform()); // streaming
 *
 * The entity table lives only on the client; the real values never leave the
 * device. Each guard keeps placeholder identity stable across every turn of a
 * conversation.
 *
 *   user message
 *     → heuristics (sync, structured PII)
 *     → NER (optional, async, contextual PII)
 *     → merge + default-deny policy (keep {city, state, zip})
 *     → session table: replace with stable placeholders
 *   assistant reply
 *     → rehydrate placeholders → render to user
 */

import { detectHeuristics } from "./heuristics";
import { loadNerClassifier, detectNer, RAMPART_MODEL_ID, type NerOptions } from "./ner/classifier";
import { createWorkerClassifier, type WorkerMessagePort } from "./ner/worker";
import { premask, projectMaskedSpan } from "./premask";
import { createRevealTransform } from "./streaming";
import { SessionEntityTable, type PlaceholderAliases, type ScrubResult } from "./session";
import { resolveKeepLabels, type PiiLabel, type Span } from "./types";

/** An async contextual detector. Matches both the in-process and worker forms. */
export type NerDetector = (text: string) => Promise<Span[]>;

/**
 * Default placeholder aliases. Empty: names are split into GIVEN_NAME/SURNAME
 * and a household may share a surname, so each keeps its own typed token
 * (`[GIVEN_NAME_1]`, `[SURNAME_1]`) rather than collapsing to a single `NAME`.
 */
export const DEFAULT_ALIASES: PlaceholderAliases = {};

export interface GuardOptions {
  /** Placeholder aliases. Defaults to `{}` — typed tokens like `[GIVEN_NAME_1]`. */
  readonly aliases?: PlaceholderAliases;
  /** Labels to preserve; defaults to `{CITY, STATE, ZIP_CODE}`. */
  readonly keepLabels?: readonly PiiLabel[];
  /**
   * When `true`, skip the structured-PII premask before the model. Required for
   * a model trained without prefilter (no-prefilter ablation) whose classes
   * include SSN / CREDIT_CARD / IP_ADDRESS. Heuristic spans for those types
   * still run as a safety net.
   */
  readonly noPrefilter?: boolean;
  /** Pre-built NER detector. When set, `model` is ignored. */
  readonly ner?: NerDetector;
  /** When `true`, skip the classifier and run heuristics only. */
  readonly heuristicsOnly?: boolean;
  /**
   * Hugging Face model id or local directory path (q4 ONNX). Defaults to
   * {@link RAMPART_MODEL_ID}.
   */
  readonly model?: string;
  /** Worker script URL. When set, NER runs off the main thread. */
  readonly worker?: string | URL;
  /** Backend. `"wasm"`/`"webgpu"` in browsers; `"cpu"` for Node. */
  readonly device?: NerOptions["device"];
  /** Spans below this score are discarded. */
  readonly minScore?: number;
}

type ChatGuardConfig = Pick<GuardOptions, "ner" | "aliases" | "keepLabels" | "noPrefilter">;

export class ChatGuard {
  private readonly table: SessionEntityTable;
  private readonly ner?: NerDetector;
  private readonly noPrefilter: boolean;

  constructor(config: ChatGuardConfig = {}) {
    this.table = new SessionEntityTable(config.aliases, resolveKeepLabels(config.keepLabels));
    this.ner = config.ner;
    this.noPrefilter = config.noPrefilter ?? false;
  }

  private async detect(text: string): Promise<Span[]> {
    const heuristic = detectHeuristics(text);
    if (this.ner === undefined) return heuristic;
    if (this.noPrefilter) {
      const modelSpans = await this.ner(text);
      return [...heuristic, ...modelSpans];
    }
    const map = premask(text, heuristic);
    const maskedSpans = await this.ner(map.masked);
    const contextual: Span[] = [];
    for (const span of maskedSpans) {
      const projected = projectMaskedSpan(span, text, map);
      if (projected !== null) contextual.push(projected);
    }
    return [...heuristic, ...contextual];
  }

  /**
   * Run this on the user's text *before* handing it to the AI SDK. Returns the
   * placeholdered text to send plus the placeholders introduced this turn.
   */
  async protect(text: string): Promise<ScrubResult> {
    const spans = await this.detect(text);
    return this.table.scrub(text, spans);
  }

  /** Restore real values in a complete (non-streaming) assistant reply. */
  reveal(reply: string): string {
    return this.table.rehydrate(reply);
  }

  /**
   * A Web Streams transform that reveals placeholders in a streamed reply,
   * correctly handling placeholders split across chunks. Pipe an AI SDK
   * `textStream` through it before rendering.
   */
  revealTransform(): TransformStream<string, string> {
    return createRevealTransform((token) => {
      const restored = this.table.rehydrate(token);
      return restored === token ? null : restored;
    });
  }

  /**
   * Defense in depth: scrub the model's *output* before logging/persisting it,
   * since a model can emit PII the user never typed. Returns placeholdered text.
   */
  async protectReply(reply: string): Promise<ScrubResult> {
    const spans = await this.detect(reply);
    return this.table.scrub(reply, spans);
  }
}

type NerLoadOptions = Pick<GuardOptions, "model" | "worker" | "minScore" | "device">;

async function buildNer(options: NerLoadOptions): Promise<NerDetector> {
  const { model, worker, minScore, device = "wasm" } = options;
  const modelOptions = { model, device, minScore };

  if (worker !== undefined) {
    // The DOM `Worker` types `onmessage` with `MessageEvent`; `WorkerMessagePort`
    // is the deliberately DOM-free structural port the worker module also uses.
    // They are not mutually assignable, so cast at this single boundary.
    const port = new Worker(worker, { type: "module" }) as unknown as WorkerMessagePort;
    const classifier = createWorkerClassifier(port, modelOptions);
    await classifier.ready;
    return async (text) => (await classifier.detect(text)) as Span[];
  }

  const classifier = await loadNerClassifier(modelOptions);
  return (text) => detectNer(text, classifier, minScore);
}

/**
 * Build a conversation guard. Loads the Rampart classifier (q4 ONNX) by default.
 * Pass `model` for a different Hugging Face id or local path, `heuristicsOnly:
 * true` to skip NER, or `ner` to inject a custom detector.
 */
export async function createGuard(options: GuardOptions = {}): Promise<ChatGuard> {
  const { aliases = DEFAULT_ALIASES, keepLabels, noPrefilter, ner, heuristicsOnly, ...nerLoad } = options;

  let detector = ner;
  if (detector === undefined && heuristicsOnly !== true) {
    detector = await buildNer(nerLoad);
  }

  return new ChatGuard({ ner: detector, aliases, keepLabels, noPrefilter });
}
