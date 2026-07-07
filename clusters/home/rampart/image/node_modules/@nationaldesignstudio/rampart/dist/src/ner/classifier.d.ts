/**
 * Contextual PII detection via a small token-classification model running in
 * the browser (transformers.js → ONNX Runtime Web, wasm or WebGPU backend).
 *
 * This is the residual layer: it catches what the heuristics can't — people's
 * names, organizations, and free-text identifiers — which is exactly the PII we
 * never want in our logs. The model is intentionally tiny and int8-quantized so
 * it loads once (cached in IndexedDB by the runtime) and runs on-device with no
 * server round-trip and no shared queue to saturate.
 *
 * Label mapping: the fine-tuned model emits token-classification entity groups,
 * which we map onto our {@link PiiLabel} set. CITY/STATE/ZIP_CODE are emitted
 * too so the merge step can carry them through to the keep-set.
 */
import type { Span } from "../types";
/** Minimal shape of a transformers.js token-classification result row. */
interface RawEntity {
    readonly entity_group?: string;
    readonly entity?: string;
    readonly score: number;
    readonly start: number;
    readonly end: number;
    readonly word: string;
    /** Index into `[CLS] + content + [SEP]`; used for tokenizer-backed offset recovery. */
    readonly index?: number;
}
/** Counts the model tokens in a string, excluding the [CLS]/[SEP] specials. */
export type TokenCounter = (text: string) => number;
/**
 * The callable returned by a token-classification pipeline. `countTokens` is
 * attached when the classifier is backed by a real tokenizer (see
 * {@link loadNerClassifier}); {@link detectNer} uses it to size windows by the
 * model's token budget. Bare mocks may omit it, in which case detection runs the
 * whole input as a single window.
 */
export interface TokenClassifier {
    (text: string, options?: {
        aggregation_strategy?: "simple" | "first" | "max";
    }): Promise<RawEntity[]>;
    countTokens?: TokenCounter;
    /** WordPiece tokens for `text` (no specials); drives index→char offset recovery. */
    tokenize?: (text: string) => readonly string[];
}
/** The shipped Rampart token-classifier on Hugging Face (q4 ONNX only). */
export declare const RAMPART_MODEL_ID = "nationaldesignstudio/rampart";
export interface NerOptions {
    /**
     * Hugging Face model id or local directory path. Must be a token-classification
     * ONNX export compatible with Rampart's label schema. Defaults to
     * {@link RAMPART_MODEL_ID}.
     */
    readonly model?: string;
    /** Backend. `"wasm"`/`"webgpu"` in browsers; `"cpu"` for Node (ORT). */
    readonly device?: "wasm" | "webgpu" | "cpu";
    /** Spans below this score are discarded. Low default → recall-biased. */
    readonly minScore?: number;
}
/** Per-window content-token budget: the model max less specials and a safety margin. */
export declare const NER_TOKEN_BUDGET: number;
/**
 * Tokens shared by consecutive NER windows. Long input slides a window of
 * {@link NER_TOKEN_BUDGET} tokens; this overlap guarantees an entity landing on a
 * window seam is still *wholly* inside a neighbouring window.
 *
 * The invariant: as long as the overlap is at least the longest entity we detect
 * (names, orgs, street lines — all a handful of tokens), no entity is ever split
 * across a boundary, so a window-edge name is never silently dropped. The generous
 * margin over the longest entity also means a seam entity reappears deep inside its
 * neighbour with ample context, which the classifier needs to label it confidently.
 */
export declare const NER_TOKEN_OVERLAP = 64;
/**
 * Lazily construct the token-classification pipeline. transformers.js is a peer
 * dependency and a heavy import, so it is loaded on first use, not at module
 * load — keeping the heuristic path dependency-free.
 */
export declare function loadNerClassifier(options?: NerOptions): Promise<TokenClassifier>;
/**
 * Detect contextual PII across the whole input, regardless of length.
 *
 * The model has a fixed token budget, so input longer than one window is scanned
 * as a sliding window sized to {@link NER_TOKEN_BUDGET} *tokens* (measured by the
 * classifier's own tokenizer) that overlaps its neighbour by {@link NER_TOKEN_OVERLAP}
 * tokens. Each window's spans are shifted back into whole-text coordinates; because
 * windows overlap, an entity on a seam is re-detected in both, so {@link mergeSpans}
 * collapses the duplicates into the canonical disjoint set. Input that fits one
 * window — or any classifier without a tokenizer, e.g. a bare test mock — takes a
 * single-window fast path identical to scanning the text directly.
 *
 * Sizing by tokens rather than a char cap means a window holds exactly as much
 * text as the model can attend to, and nothing past a fixed char count is silently
 * dropped: the overlap keeps any entity from being split across a seam.
 */
export declare function detectNer(raw: string, classifier: TokenClassifier, minScore?: number): Promise<Span[]>;
export {};
//# sourceMappingURL=classifier.d.ts.map