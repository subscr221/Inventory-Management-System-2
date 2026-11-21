import { istCalendarDate } from '../capture/business-date';

/** Story 3.20: pure logic for the unloading exceptions inbox (merge, today filter, scan match). */

export interface GateEventRow {
  gate_event_id: string;
  vehicle_reg_ext: string;
  driver_name: string | null;
  challan_number_ext: string | null;
  challan_photo_ref: string | null;
  po_ref_ext: string | null;
  supplier_ref_ext: string | null;
  supplier_name_unlisted: string | null;
  entered_at: string;
}

export interface ExceptionRow {
  exception_id: string;
  kind: 'over_tolerance' | 'unmatched_vehicle';
  source_id: string;
  status: 'open' | 'sent_to_procurement' | 'resolved';
  resolution: 'matched_to_po' | 'accepted_within_band' | 'sent_to_procurement' | null;
  resolved_at: string | null;
  po_ref_ext: string | null;
  line_no: number | null;
  sku: string | null;
  uom: string | null;
  vehicle_reg_ext: string | null;
  ordered_qty: string | null;
  already_received_qty: string | null;
  tolerance_pct: string | null;
  cap_qty: string | null;
  counted_qty: string | null;
  excess_qty: string | null;
  created_at: string;
}

export type OpenCase =
  | { kind: 'unmatched'; key: string; sortKey: string; gate: GateEventRow }
  | { kind: 'over_tolerance'; key: string; sortKey: string; exception: ExceptionRow };

export function mergeOpenCases(gateEvents: GateEventRow[], exceptions: ExceptionRow[]): OpenCase[] {
  const cases: OpenCase[] = [
    ...gateEvents.map((gate): OpenCase => ({
      kind: 'unmatched',
      key: `gate:${gate.gate_event_id}`,
      sortKey: gate.entered_at,
      gate,
    })),
    ...exceptions
      .filter((e) => e.kind === 'over_tolerance' && e.status === 'open')
      .map((exception): OpenCase => ({
        kind: 'over_tolerance',
        key: `line:${exception.source_id}`,
        sortKey: exception.created_at,
        exception,
      })),
  ];
  return cases.sort((a, b) => Date.parse(a.sortKey) - Date.parse(b.sortKey));
}

export function resolvedToday(exceptions: ExceptionRow[], now: string): ExceptionRow[] {
  const today = istCalendarDate(now);
  return exceptions.filter(
    (e) =>
      (e.status === 'resolved' || e.status === 'sent_to_procurement') &&
      e.resolved_at !== null &&
      istCalendarDate(e.resolved_at) === today,
  );
}

function normalise(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, '').toUpperCase();
}

export function findCaseByScan(cases: OpenCase[], code: string): OpenCase | null {
  const wanted = normalise(code);
  if (!wanted) return null;
  return (
    cases.find((c) => {
      const fields =
        c.kind === 'unmatched'
          ? [c.gate.vehicle_reg_ext, c.gate.challan_number_ext, c.gate.po_ref_ext]
          : [c.exception.vehicle_reg_ext, c.exception.po_ref_ext];
      return fields.some((f) => normalise(f) === wanted);
    }) ?? null
  );
}
