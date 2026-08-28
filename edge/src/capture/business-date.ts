/**
 * Story 7.8 (Binding Decision 13): the IST (+05:30) calendar date of an instant, computed on the
 * device with no library. The server's toIstCalendarDate is the twin; the spares issue applier
 * derives return_due_date from issued_at and only business_date is device-computed.
 */
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

export function istCalendarDate(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new Error(`istCalendarDate: not a timestamp: ${iso}`);
  return new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);
}
