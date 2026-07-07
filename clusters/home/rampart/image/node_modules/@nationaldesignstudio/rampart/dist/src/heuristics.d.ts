/**
 * Heuristic detectors: the cheap, synchronous, zero-model first pass.
 *
 * Digit-bearing PII (SSN, card, phone, routing) is found over the *digit
 * projection* (see normalize.ts) so every separator variant collapses to one
 * rule: `888-88-8888`, `888 88 8888`, `888.88.8888`, and `888888888` all match.
 * Text-shaped PII (email, URL, IP) is matched on the raw string where the
 * structure lives in the punctuation.
 */
import type { Span } from "./types";
/** Run all heuristic detectors over the raw input. Spans may overlap; the
 * pipeline's merge step resolves conflicts before redaction. */
export declare function detectHeuristics(raw: string): Span[];
//# sourceMappingURL=heuristics.d.ts.map