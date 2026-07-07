/**
 * Heuristic detectors: the cheap, synchronous, zero-model first pass.
 *
 * Digit-bearing PII (SSN, card, phone, routing) is found over the *digit
 * projection* (see normalize.ts) so every separator variant collapses to one
 * rule: `888-88-8888`, `888 88 8888`, `888.88.8888`, and `888888888` all match.
 * Text-shaped PII (email, URL, IP) is matched on the raw string where the
 * structure lives in the punctuation.
 */

import type { PiiLabel, Span } from "./types";
import { isLuhnValid, isValidSsn } from "./validators";

/** A fixed-length digit candidate paired with its label and validator. */
interface DigitRule {
  readonly label: PiiLabel;
  /** Exact digit lengths to try, longest first so cards beat SSN/phone. */
  readonly lengths: readonly number[];
  /** Returns true if the digit slice is a real instance of this entity. */
  readonly validate: (digits: string) => boolean;
}

// Order matters: longer/stricter entities are tried first so a 16-digit card is
// never carved into a 9-digit "SSN". Overlap is also resolved later in merge.
const DIGIT_RULES: readonly DigitRule[] = [
  { label: "CREDIT_CARD", lengths: [16, 15, 14], validate: isLuhnValid },
  { label: "SSN", lengths: [9], validate: isValidSsn },
];

/**
 * A contiguous digit run with its inline separators, e.g. `888 12 3456`. Runs
 * never span a letter or other word boundary, so digits from different fields
 * ("...3456 and income is 50000") can't merge into one phantom candidate.
 */
interface DigitRun {
  /** Separator-free digits of the run. */
  readonly digits: string;
  /** `rawIndex[i]` is the raw offset of `digits[i]`. */
  readonly rawIndex: number[];
}

// A run is digits joined only by single inline separators (space, dash, dot).
const DIGIT_RUN = /\d(?:[ .-]?\d)*/g;

function extractRuns(raw: string): DigitRun[] {
  const runs: DigitRun[] = [];
  DIGIT_RUN.lastIndex = 0;
  for (let m = DIGIT_RUN.exec(raw); m !== null; m = DIGIT_RUN.exec(raw)) {
    const digits: string[] = [];
    const rawIndex: number[] = [];
    for (let i = 0; i < m[0].length; i++) {
      const code = m[0].charCodeAt(i);
      if (code >= 0x30 && code <= 0x39) {
        digits.push(m[0][i]);
        rawIndex.push(m.index + i);
      }
    }
    runs.push({ digits: digits.join(""), rawIndex });
  }
  return runs;
}

/**
 * Scan each digit run for fixed-length, validator-backed entities. A candidate
 * is anchored to the *whole* run (start..len and end-len..end) so we only match
 * when the run length equals the entity length — preventing a 9-digit SSN from
 * firing inside a longer account number. The raw span includes interior
 * separators so redaction covers `888-12-3456` whole.
 */
function detectDigitEntities(raw: string): Span[] {
  const spans: Span[] = [];
  for (const run of extractRuns(raw)) {
    for (const rule of DIGIT_RULES) {
      if (!rule.lengths.includes(run.digits.length)) continue;
      if (!rule.validate(run.digits)) continue;
      const start = run.rawIndex[0];
      const end = run.rawIndex[run.rawIndex.length - 1] + 1;
      spans.push({ start, end, label: rule.label, score: 1, source: "heuristic", text: raw.slice(start, end) });
      break; // first matching rule (rules are ordered strict→loose) wins the run
    }
  }
  return spans;
}

// Text-shaped entities: structure lives in the punctuation, so match raw.
// EMAIL and URL are structured text-shaped PII: a regex catches them at near-
// 100% recall, far better than the model (URL recall is ~5% model-alone), so
// the deterministic layer owns them and premasks them to sentinels before the
// model — exactly as it does for SSN/CC/IP. The model's vestigial EMAIL/URL
// head no longer needs to fire.
const TEXT_RULES: readonly { label: PiiLabel; pattern: RegExp; group?: number }[] = [
  // Email: local part (with +tags and dots) @ dotted domain. Matches
  // plus-addressing and sub-domains, e.g. `alex+housing@sub.example.gov`.
  { label: "EMAIL", pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  // URL with explicit scheme: everything up to whitespace / closing bracket /
  // quote. Trailing sentence punctuation is left in the span (harmless — the
  // sensitive host+path is what matters and the whole run is redacted).
  { label: "URL", pattern: /\bhttps?:\/\/[^\s<>"'\])}]+/g },
  // Schemeless web URL: `www.` host followed by the rest of the URL.
  { label: "URL", pattern: /\bwww\.[A-Za-z0-9.-]+\.[A-Za-z]{2,}(?:\/[^\s<>"'\])}]*)?/g },
  { label: "IP_ADDRESS", pattern: /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g },
  // IPv6: full and `::`-compressed forms. Every alternative requires either 8
  // colon-separated groups or a `::`, so it never fires on times ("12:34") or
  // MAC addresses (handled below); the lookarounds keep it off larger tokens.
  {
    label: "IP_ADDRESS",
    pattern:
      /(?<![:.\w])(?:(?:[0-9A-Fa-f]{1,4}:){7}[0-9A-Fa-f]{1,4}|(?:[0-9A-Fa-f]{1,4}:){1,7}:|(?:[0-9A-Fa-f]{1,4}:){1,6}:[0-9A-Fa-f]{1,4}|(?:[0-9A-Fa-f]{1,4}:){1,5}(?::[0-9A-Fa-f]{1,4}){1,2}|(?:[0-9A-Fa-f]{1,4}:){1,4}(?::[0-9A-Fa-f]{1,4}){1,3}|(?:[0-9A-Fa-f]{1,4}:){1,3}(?::[0-9A-Fa-f]{1,4}){1,4}|(?:[0-9A-Fa-f]{1,4}:){1,2}(?::[0-9A-Fa-f]{1,4}){1,5}|[0-9A-Fa-f]{1,4}:(?::[0-9A-Fa-f]{1,4}){1,6}|::(?:[0-9A-Fa-f]{1,4}:){0,6}[0-9A-Fa-f]{1,4})(?![:.\w])/g,
  },
  // MAC address: six hex pairs joined by ":" or "-".
  { label: "IP_ADDRESS", pattern: /\b(?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}\b/g },
];

function detectTextEntities(raw: string): Span[] {
  const spans: Span[] = [];
  for (const { label, pattern, group } of TEXT_RULES) {
    pattern.lastIndex = 0;
    for (let m = pattern.exec(raw); m !== null; m = pattern.exec(raw)) {
      const text = group === undefined ? m[0] : m[group];
      const offset = group === undefined ? 0 : m[0].indexOf(text);
      spans.push({
        start: m.index + offset,
        end: m.index + offset + text.length,
        label,
        score: 1,
        source: "heuristic",
        text,
      });
    }
  }
  return spans;
}

/** Run all heuristic detectors over the raw input. Spans may overlap; the
 * pipeline's merge step resolves conflicts before redaction. */
export function detectHeuristics(raw: string): Span[] {
  return [
    ...detectDigitEntities(raw),
    ...detectTextEntities(raw),
  ];
}
