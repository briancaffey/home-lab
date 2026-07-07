/**
 * Shared vocabulary for the PII filter.
 *
 * The whole system is *default-deny*: every detected entity is redacted unless
 * its label is in {@link KEEP_LABELS} (currently {CITY, STATE, ZIP_CODE}). An
 * unrecognized span is dropped, never leaked.
 *
 * Two layers emit labels:
 *  - Heuristics (synchronous, validator-backed) detect and premask the
 *    structured numeric identifiers below before the model ever runs.
 *  - The NER model learns the contextual "fine set": split names, contact and
 *    document identifiers, and address components.
 */

/** Every entity class the heuristics and the NER model can emit. */
export type PiiLabel =
  // --- Structured (heuristic-detectable, premasked before the model) ---
  | "SSN"
  | "CREDIT_CARD"
  | "IP_ADDRESS"
  // --- Contextual (NER model fine set) ---
  | "GIVEN_NAME"
  | "SURNAME"
  | "EMAIL"
  | "PHONE"
  | "URL"
  | "TAX_ID"
  | "BANK_ACCOUNT"
  | "ROUTING_NUMBER"
  | "GOVERNMENT_ID"
  | "PASSPORT"
  | "DRIVERS_LICENSE"
  // --- Address components (NER) ---
  | "BUILDING_NUMBER"
  | "STREET_NAME"
  | "SECONDARY_ADDRESS"
  | "CITY"
  | "STATE"
  | "ZIP_CODE";

/**
 * Labels that are intentionally preserved (classified but never redacted).
 * The model still learns these; the JS policy layer simply keeps them in the
 * text. Public-benefits assistants need broad geography (city / state / ZIP)
 * for area-median-income (AMI) eligibility, so those are kept while the precise
 * street line (BUILDING_NUMBER + STREET_NAME) is still redacted.
 */
export const KEEP_LABELS: ReadonlySet<PiiLabel> = new Set<PiiLabel>(["CITY", "STATE", "ZIP_CODE"]);

/** A detected entity span over the *original* (raw) text. */
export interface Span {
  /** Inclusive start offset into the raw input. */
  readonly start: number;
  /** Exclusive end offset into the raw input. */
  readonly end: number;
  /** The classified entity type. */
  readonly label: PiiLabel;
  /** Detector confidence in [0, 1]. Heuristics with validators report 1. */
  readonly score: number;
  /** Which layer produced the span; used for merge tie-breaks and audit. */
  readonly source: "heuristic" | "ner";
  /** The raw substring covered, retained for placeholder rehydration. */
  readonly text: string;
}

/** Resolve a caller keep-set; omitted → {@link KEEP_LABELS}. */
export function resolveKeepLabels(keepLabels?: readonly PiiLabel[]): ReadonlySet<PiiLabel> {
  return keepLabels === undefined ? KEEP_LABELS : new Set(keepLabels);
}

/** True when a label must be redacted under the default-deny policy. */
export function shouldRedact(label: PiiLabel, keepLabels: ReadonlySet<PiiLabel> = KEEP_LABELS): boolean {
  return !keepLabels.has(label);
}
