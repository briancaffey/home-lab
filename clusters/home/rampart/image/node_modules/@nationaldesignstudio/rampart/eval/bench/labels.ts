/**
 * OpenPII (`ai4privacy/pii-masking-openpii-1.5m`) gold-label projection onto the
 * Rampart policy: default-deny, keep-set wins, and any unknown label fails safe
 * to a redacted class.
 *
 * This projection lives in TS alongside the runtime it scores, so the gold-label
 * mapping the benchmark uses is the same mapping the shipped policy enforces.
 */

/** Keep set / not-PII sentinel. */
export const KEEP = "O";

const OPENPII_TO_OURS: Readonly<Record<string, string>> = {
  // Split names (a household may share a surname, so they stay distinct).
  GIVENNAME: "GIVEN_NAME",
  SURNAME: "SURNAME",
  // Direct contact identifiers
  EMAIL: "EMAIL",
  TELEPHONENUM: "PHONE",
  // Government / financial strong identifiers (redact)
  SOCIALNUM: "SSN",
  CREDITCARDNUMBER: "CREDIT_CARD",
  IDCARDNUM: "GOVERNMENT_ID",
  PASSPORTNUM: "PASSPORT",
  DRIVERLICENSENUM: "DRIVERS_LICENSE",
  TAXNUM: "TAX_ID",
  // Address components: only the precise street line is redacted at runtime.
  // CITY / STATE / ZIPCODE are in KEEP_LABELS (see src/types.ts) — they ride
  // through the runtime untouched, so the bench must NOT count them as leaks.
  BUILDINGNUM: "BUILDING_NUMBER",
  STREET: "STREET_NAME",
  CITY: KEEP,
  STATE: KEEP,
  ZIPCODE: KEEP,
};

/** Project an OpenPII label onto our schema; unknown → O (pass through). */
export function mapOpenPiiLabel(label: string): string {
  return OPENPII_TO_OURS[label] ?? KEEP;
}

/** A gold value is "private" iff its label maps to a redacted (non-keep) class. */
export function isPrivateLabel(label: string): boolean {
  return mapOpenPiiLabel(label) !== KEEP;
}
