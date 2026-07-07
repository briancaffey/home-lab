/**
 * Validators that turn "a run of digits" into "a *valid* SSN / card / phone".
 *
 * These exist to suppress false positives so the filter doesn't mangle numbers
 * the assistant is allowed to keep (income figures, ages, years). A detector
 * proposes a span; a validator decides whether it is really that entity.
 */

/** Luhn checksum — gates CREDIT_CARD so arbitrary 16-digit runs don't match. */
export function isLuhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 0x30;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/**
 * US SSN structural rules. Area (first 3) cannot be 000, 666, or 900-999;
 * group (middle 2) cannot be 00; serial (last 4) cannot be 0000. Rejects
 * obvious non-SSNs like phone numbers padded to nine digits.
 */
export function isValidSsn(digits: string): boolean {
  if (digits.length !== 9) return false;
  const area = digits.slice(0, 3);
  const group = digits.slice(3, 5);
  const serial = digits.slice(5);
  if (area === "000" || area === "666") return false;
  if (Number(area) >= 900) return false;
  if (group === "00") return false;
  if (serial === "0000") return false;
  return true;
}
