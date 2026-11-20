/** Money is stored as integer minor units (ADR-006); never as binary floats. */

export function assertMinorUnits(amountMinor: number): void {
  if (!Number.isSafeInteger(amountMinor)) {
    throw new RangeError(`Money must be a safe integer of minor units, received ${amountMinor}`);
  }
}

/**
 * Formats integer minor units exactly by passing a decimal string to Intl,
 * so no floating-point division is involved.
 */
export function formatMinor(amountMinor: number, currency: string, locale = "en-US"): string {
  assertMinorUnits(amountMinor);
  const formatter = new Intl.NumberFormat(locale, { style: "currency", currency });
  const digits = formatter.resolvedOptions().maximumFractionDigits ?? 2;
  const negative = amountMinor < 0;
  const magnitude = String(Math.abs(amountMinor)).padStart(digits + 1, "0");
  const whole = magnitude.slice(0, magnitude.length - digits);
  const fraction = digits > 0 ? `.${magnitude.slice(-digits)}` : "";
  const decimal = `${negative ? "-" : ""}${whole}${fraction}` as Intl.StringNumericLiteral;
  return formatter.format(decimal);
}
