/**
 * Pre-mask harness: substitute deterministically-detected structured PII with
 * neutral sentinels *before* the contextual model runs.
 *
 * The heuristic layer (SSN / CREDIT_CARD / IP_ADDRESS / EMAIL / URL) is
 * validator- or pattern-backed and runs synchronously. Rather than show the
 * model raw card/SSN/IP digits or email/URL strings — which it never needs to
 * classify and which only add noise — we replace each heuristic span with a
 * fixed sentinel token (`[SSN]`, `[CREDIT_CARD]`, `[IP_ADDRESS]`, ...). The model
 * is trained on text masked the exact same way, so the train-time and
 * inference-time input distributions match by construction.
 *
 * Offsets: the masked string is paired with a per-character map back to the raw
 * input, so a span the model reports in masked coordinates can be projected to
 * exact raw offsets. Sentinel characters map onto their source span's raw range,
 * so if the model happens to label part of a sentinel the projection lands
 * inside the heuristic span (which then wins the merge on its score-1 weight).
 *
 * The heuristic spans themselves are returned with their original raw offsets,
 * so final redaction and the session table are unaffected: only the text handed
 * to the model is masked, never the text that gets placeholdered.
 */

import { mergeSpans } from "./policy";
import type { PiiLabel, Span } from "./types";

/** A masked copy of the input plus a map from each masked char to raw offsets. */
export interface PremaskResult {
  /** Input with heuristic spans replaced by sentinel tokens. */
  readonly masked: string;
  /** `rawStart[i]` is the raw offset of the source of `masked[i]`. */
  readonly rawStart: number[];
  /** `rawEnd[i]` is the raw offset just past that source. */
  readonly rawEnd: number[];
}

/** The sentinel substituted for a premasked label. Stable across train/serve. */
export function sentinelFor(label: PiiLabel): string {
  return `[${label}]`;
}

/**
 * Replace each (disjoint) heuristic span in `raw` with its label sentinel,
 * recording per masked-character raw offsets. Spans are merged first so they are
 * non-overlapping; verbatim runs between spans map 1:1 to raw, and sentinel
 * characters map onto the whole span they stand in for.
 */
export function premask(raw: string, spans: readonly Span[]): PremaskResult {
  const ordered = mergeSpans(spans).slice().sort((a, b) => a.start - b.start);
  let masked = "";
  const rawStart: number[] = [];
  const rawEnd: number[] = [];

  const copyVerbatim = (from: number, to: number): void => {
    for (let i = from; i < to; i++) {
      masked += raw[i];
      rawStart.push(i);
      rawEnd.push(i + 1);
    }
  };

  let cursor = 0;
  for (const span of ordered) {
    if (span.start < cursor) continue; // defensive: skip any residual overlap
    copyVerbatim(cursor, span.start);
    const sentinel = sentinelFor(span.label);
    for (const ch of sentinel) {
      masked += ch;
      rawStart.push(span.start);
      rawEnd.push(span.end);
    }
    cursor = span.end;
  }
  copyVerbatim(cursor, raw.length);

  return { masked, rawStart, rawEnd };
}

/**
 * Project a span reported in masked coordinates back onto the raw input. Returns
 * `null` for an empty/degenerate span. The raw `text` is sliced from `raw` so
 * callers always carry the real substring for rehydration.
 */
export function projectMaskedSpan(span: Span, raw: string, map: PremaskResult): Span | null {
  if (span.end <= span.start) return null;
  const start = map.rawStart[span.start];
  const end = map.rawEnd[span.end - 1];
  if (start === undefined || end === undefined || end <= start) return null;
  return { ...span, start, end, text: raw.slice(start, end) };
}
