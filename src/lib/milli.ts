/**
 * Exact thousandths arithmetic for NUMERIC(18,3) quantities carried as text. Story 4.11 compares
 * issue quantities this way; Story 4.8 adds the monthly cap sums. Never passes through a float.
 */

/** NUMERIC text (at most three decimals are kept) to thousandths as a BigInt. */
export function toMilli(value: string): bigint {
  const [whole = '0', frac = ''] = value.split('.');
  return BigInt(whole) * 1000n + BigInt((frac + '000').slice(0, 3));
}

/** Thousandths back to NUMERIC text with exactly three decimals. */
export function milliToText(milli: bigint): string {
  const negative = milli < 0n;
  const abs = (negative ? -milli : milli).toString().padStart(4, '0');
  return `${negative ? '-' : ''}${abs.slice(0, -3)}.${abs.slice(-3)}`;
}

/** A JS number from a payload to NUMERIC text with three decimals (payload quantities are numbers). */
export function numberToQtyText(value: number): string {
  return value.toFixed(3);
}

export function qtyExceeds(quantity: string, open: string): boolean {
  return toMilli(quantity) > toMilli(open);
}

/** NUMERIC text to ten-thousandths (four decimals, the scale of rupee amounts) as a BigInt. */
function toScaled4(value: string): bigint {
  const negative = value.startsWith('-');
  const [whole = '0', frac = ''] = (negative ? value.slice(1) : value).split('.');
  const scaled = BigInt(whole) * 10000n + BigInt((frac + '0000').slice(0, 4));
  return negative ? -scaled : scaled;
}

/** a <= b for NUMERIC rupee text, exact (no floats). */
export function amountLte(a: string, b: string): boolean {
  return toScaled4(a) <= toScaled4(b);
}
