/**
 * Story 3.14: the stores inbox is a pure grouping of four server reads, so the rules are unit
 * tested without a DOM. The component owns fetching and rendering only.
 */

export interface ArrivalRow {
  gate_event_id: string;
  challan_number_ext: string | null;
  vehicle_reg_ext: string;
  driver_name: string | null;
  challan_photo_ref: string;
  entered_at: string;
  binding_status: 'matched' | 'unmatched';
  po_ref_ext: string | null;
  supplier_ref_ext: string | null;
  supplier_name_unlisted: string | null;
  supplier_unlisted: boolean;
  binding_token: string;
  has_accepted_weighment: boolean;
  grn_id: string | null;
  po_summary: { po_ref_ext: string; line_count: number; open_qty: string } | null;
}

export interface PutawayRow {
  putaway_task_id: string;
  sku: string;
  lot_id: string | null;
  quantity: string;
  from_location_id: string;
  from_location_code?: string | null;
  site_id: string;
  status: 'ready' | 'held' | 'completed';
  directed_location_code: string | null;
}

export interface IssueRow {
  indent_id: string;
  indent_number?: string | null;
  requester_name?: string | null;
  line_count?: number | null;
}

export interface DoneRow {
  id: string;
  title: string;
  statusKey: 'stores.done.captured' | 'stores.done.synced';
  href?: string;
}

export interface InboxCard {
  id: string;
  title: string;
  detail: string;
  pillKey: string;
  pillValue?: string;
  actionKey: string;
  actionHref: string | null;
  disabledReasonKey: string | null;
}

export interface InboxGroup {
  key: 'arrived' | 'putaway' | 'issues' | 'returns';
  titleKey: string;
  cards: InboxCard[];
}

export interface InboxInput {
  arrivals: ArrivalRow[];
  putaway: PutawayRow[];
  issues: IssueRow[];
  showIssues: boolean;
  showPutaway: boolean;
}

export function openArrivals(rows: ArrivalRow[]): ArrivalRow[] {
  return rows.filter((row) => row.grn_id === null);
}

export function acceptedToday(rows: ArrivalRow[]): DoneRow[] {
  return rows
    .filter((row) => row.grn_id !== null)
    .map((row) => ({
      id: row.grn_id as string,
      title: row.challan_number_ext ?? row.gate_event_id,
      statusKey: 'stores.done.captured' as const,
    }));
}

function arrivalCard(row: ArrivalRow): InboxCard {
  const title = row.challan_number_ext || row.po_ref_ext || row.vehicle_reg_ext;
  const detail =
    `${row.supplier_unlisted ? (row.supplier_name_unlisted ?? '') : (row.supplier_ref_ext ?? '')} ${row.vehicle_reg_ext}`.trim();
  if (row.binding_status !== 'matched') {
    return {
      id: row.gate_event_id,
      title,
      detail,
      pillKey: 'stores.pill.matchSupplier',
      actionKey: 'stores.action.start',
      actionHref: null,
      disabledReasonKey: 'stores.reason.matchSupplier',
    };
  }
  if (!row.has_accepted_weighment) {
    return {
      id: row.gate_event_id,
      title,
      detail,
      pillKey: 'stores.pill.waitingForWeighbridge',
      actionKey: 'stores.action.start',
      actionHref: null,
      disabledReasonKey: 'stores.reason.waitingForWeighbridge',
    };
  }
  return {
    id: row.gate_event_id,
    title,
    detail,
    pillKey: 'stores.pill.arrived',
    actionKey: 'stores.action.start',
    actionHref: `/stores/accept?gate=${encodeURIComponent(row.gate_event_id)}`,
    disabledReasonKey: null,
  };
}

export function buildInbox(input: InboxInput): InboxGroup[] {
  const groups: InboxGroup[] = [
    {
      key: 'arrived',
      titleKey: 'stores.group.arrived',
      cards: openArrivals(input.arrivals).map(arrivalCard),
    },
    {
      key: 'putaway',
      titleKey: 'putaway.group',
      cards: input.showPutaway
        ? input.putaway.map((task) => ({
            id: task.putaway_task_id,
            title: task.sku,
            detail: [task.quantity, task.lot_id, task.from_location_code]
              .filter(Boolean)
              .join(' · '),
            pillKey: task.directed_location_code
              ? 'putaway.card.suggested'
              : 'putaway.pill.ready',
            ...(task.directed_location_code ? { pillValue: task.directed_location_code } : {}),
            actionKey: 'putaway.action.open',
            actionHref: `/stores/putaway?task=${encodeURIComponent(task.putaway_task_id)}`,
            disabledReasonKey: null,
          }))
        : [],
    },
    {
      key: 'issues',
      titleKey: 'stores.group.issues',
      cards: input.showIssues
        ? input.issues.map((indent) => ({
            id: indent.indent_id,
            title: indent.indent_number ?? indent.indent_id,
            detail: indent.requester_name ?? '',
            pillKey: 'stores.pill.issueReady',
            actionKey: 'stores.action.issue',
            actionHref: '/stores/issue',
            disabledReasonKey: null,
          }))
        : [],
    },
    { key: 'returns', titleKey: 'stores.group.returns', cards: [] },
  ];
  return groups;
}

export type ScanResult =
  | { kind: 'accept'; arrival: ArrivalRow }
  | { kind: 'done'; arrival: ArrivalRow }
  | { kind: 'unknown' };

/** Challan match only; a lot is resolved by the component against the lot location read. */
export function resolveScan(code: string, arrivals: ArrivalRow[]): ScanResult {
  const key = code.trim().toLowerCase();
  if (!key) return { kind: 'unknown' };
  const hit = arrivals.find(
    (row) =>
      row.challan_number_ext?.trim().toLowerCase() === key ||
      row.gate_event_id.toLowerCase() === key,
  );
  if (!hit) return { kind: 'unknown' };
  return hit.grn_id ? { kind: 'done', arrival: hit } : { kind: 'accept', arrival: hit };
}

/** What is still missing before Complete acceptance may fire, in display order. */
export function acceptanceMissing(args: {
  countedLines: number;
  openLines: number;
  materialPhoto: boolean;
  shortDetailsComplete: boolean;
  otherEvidenceComplete: boolean;
}): string[] {
  const missing: string[] = [];
  if (args.countedLines < args.openLines) missing.push('stores.missing.lines');
  if (!args.materialPhoto) missing.push('stores.missing.materialPhoto');
  if (!args.shortDetailsComplete) missing.push('stores.missing.shortReason');
  if (!args.otherEvidenceComplete) missing.push('stores.missing.otherEvidence');
  return missing;
}
