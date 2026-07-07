/**
 * Validators that turn "a run of digits" into "a *valid* SSN / card / phone".
 *
 * These exist to suppress false positives so the filter doesn't mangle numbers
 * the assistant is allowed to keep (income figures, ages, years). A detector
 * proposes a span; a validator decides whether it is really that entity.
 */
/** Luhn checksum — gates CREDIT_CARD so arbitrary 16-digit runs don't match. */
export declare function isLuhnValid(digits: string): boolean;
/**
 * US SSN structural rules. Area (first 3) cannot be 000, 666, or 900-999;
 * group (middle 2) cannot be 00; serial (last 4) cannot be 0000. Rejects
 * obvious non-SSNs like phone numbers padded to nine digits.
 */
export declare function isValidSsn(digits: string): boolean;
//# sourceMappingURL=validators.d.ts.map