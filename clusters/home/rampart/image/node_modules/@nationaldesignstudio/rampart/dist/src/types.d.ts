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
export type PiiLabel = "SSN" | "CREDIT_CARD" | "IP_ADDRESS" | "GIVEN_NAME" | "SURNAME" | "EMAIL" | "PHONE" | "URL" | "TAX_ID" | "BANK_ACCOUNT" | "ROUTING_NUMBER" | "GOVERNMENT_ID" | "PASSPORT" | "DRIVERS_LICENSE" | "BUILDING_NUMBER" | "STREET_NAME" | "SECONDARY_ADDRESS" | "CITY" | "STATE" | "ZIP_CODE";
/**
 * Labels that are intentionally preserved (classified but never redacted).
 * The model still learns these; the JS policy layer simply keeps them in the
 * text. Public-benefits assistants need broad geography (city / state / ZIP)
 * for area-median-income (AMI) eligibility, so those are kept while the precise
 * street line (BUILDING_NUMBER + STREET_NAME) is still redacted.
 */
export declare const KEEP_LABELS: ReadonlySet<PiiLabel>;
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
export declare function resolveKeepLabels(keepLabels?: readonly PiiLabel[]): ReadonlySet<PiiLabel>;
/** True when a label must be redacted under the default-deny policy. */
export declare function shouldRedact(label: PiiLabel, keepLabels?: ReadonlySet<PiiLabel>): boolean;
//# sourceMappingURL=types.d.ts.map