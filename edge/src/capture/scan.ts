/**
 * Story 3.13 (Task 2): pure scan parsing rules shared by the ScanField component and its unit
 * tests. A hardware trigger and a keyboard wedge both emit the value followed by Enter; the value
 * never keeps the trailing terminator whitespace.
 */

export function isScanSubmitKey(key: string, shiftKey = false): boolean {
  return key === 'Enter' && !shiftKey;
}

export function normalizeScanValue(raw: string): string {
  return raw.trim();
}
