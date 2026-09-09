/**
 * The ONE set of GST IRN validators (Story 11.2 review decision D2; moved to this leaf module by
 * Story 11.5 so both the dispatch seam and the transfer seam can import it without a module
 * cycle). A GST IRN is the IRP's SHA-256 over the invoice, presented as 64 hexadecimal characters.
 * Anything else cannot be an IRN, and accepting "any non-blank string" made the statutory gate a
 * formality. Both doors normalise to lower case before storage (normalizeIrnExt) and the DB CHECKs
 * (dispatch_irn, branch_transfer_gst_document) pin the same lower-case shape. Do not add a second
 * IRN regex anywhere.
 */
export const IRN_EXT_REGEX = /^[0-9a-f]{64}$/i;

export function normalizeIrnExt(value: string): string {
  return value.trim().toLowerCase();
}

// Strict RFC 3339 / ISO 8601 instant: Date.parse alone accepts "1" and "March" in V8, which then
// fail the TIMESTAMPTZ cast inside the transaction as a raw 500. The upper bound mirrors the
// occurred_at rule from the deferred-work triage: an IRP acknowledgement cannot lie in the future.
const ISO_INSTANT_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
const IRP_ACK_FUTURE_SKEW_MS = 5 * 60 * 1000;

export function isValidIrpAcknowledgedAt(value: unknown, now: number = Date.now()): boolean {
  if (typeof value !== 'string' || !ISO_INSTANT_REGEX.test(value)) return false;
  const parsed = Date.parse(value);
  return !Number.isNaN(parsed) && parsed <= now + IRP_ACK_FUTURE_SKEW_MS;
}
