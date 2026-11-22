/** Story 7.11: pure logic for the maintenance supervisor desk (grouping, counts, action gating). */

export const DESK_LIST_LIMIT = 500;
export const MAX_RESOLUTION_NOTE = 1000;
export const SIGN_OFF_TICKS = 3;

export type Priority = 'p1' | 'p2' | 'p3' | 'p4';

export interface FaultRow {
  fault_report_id: string;
  asset_id: string;
  asset_tag: string;
  description: string;
  safety_flag: boolean;
  status: 'reported' | 'accepted' | 'rejected';
}

export interface WorkOrderRow {
  work_order_id: string;
  asset_id: string;
  asset_tag: string | null;
  status: 'open' | 'overdue' | 'in_progress' | 'on_hold' | 'completed';
  priority: Priority | null;
  warranty_flagged: boolean;
  status_note: string | null;
  fault_report_id: string | null;
  completed_at?: string | null;
}

export interface AssetStatusRow {
  asset_id: string;
  status: 'running' | 'idle' | 'breakdown' | 'maintenance';
}

export interface OverrideRow {
  reason_code: string;
  overridden_by: string;
  overridden_at: string;
}

export type GroupId = 'triage' | 'assigned' | 'progress' | 'waiting' | 'done';
export const GROUP_ORDER: GroupId[] = ['triage', 'assigned', 'progress', 'waiting', 'done'];

export type DeskCard =
  | { kind: 'fault'; key: string; id: string; title: string; fault: FaultRow }
  | { kind: 'work-order'; key: string; id: string; title: string; workOrder: WorkOrderRow };

export type DeskGroups = Record<GroupId, DeskCard[]>;

const WORK_ORDER_GROUP: Partial<Record<WorkOrderRow['status'], GroupId>> = {
  open: 'assigned',
  overdue: 'assigned',
  in_progress: 'progress',
  on_hold: 'waiting',
};

/** null: no override row yet; 'error': the read failed, so the warranty state is unknown. */
export type OverrideState = OverrideRow | null | 'error';

const completedAfter = (a: WorkOrderRow, b: WorkOrderRow) =>
  (a.completed_at ?? '') !== (b.completed_at ?? '')
    ? (a.completed_at ?? '') > (b.completed_at ?? '')
    : a.work_order_id > b.work_order_id;

/**
 * Done holds the latest completed work order of an asset that is still out of service (breakdown or
 * maintenance) and has no open, overdue, in-progress or on-hold work order.
 */
export function classifyBoard(
  faults: FaultRow[],
  workOrders: WorkOrderRow[],
  assetStatuses: AssetStatusRow[],
): DeskGroups {
  const groups: DeskGroups = { triage: [], assigned: [], progress: [], waiting: [], done: [] };
  const outOfService = new Set(
    assetStatuses
      .filter((s) => s.status === 'breakdown' || s.status === 'maintenance')
      .map((s) => s.asset_id),
  );
  const activeAssets = new Set(
    workOrders.filter((w) => w.status !== 'completed').map((w) => w.asset_id),
  );
  const latestDone = new Map<string, WorkOrderRow>();
  for (const w of workOrders) {
    const current = latestDone.get(w.asset_id);
    if (w.status === 'completed' && (!current || completedAfter(w, current))) {
      latestDone.set(w.asset_id, w);
    }
  }
  for (const fault of faults) {
    if (fault.status !== 'reported') continue;
    groups.triage.push({
      kind: 'fault',
      key: `fault:${fault.fault_report_id}`,
      id: fault.fault_report_id,
      title: fault.asset_tag,
      fault,
    });
  }
  for (const workOrder of workOrders) {
    const group =
      workOrder.status === 'completed'
        ? outOfService.has(workOrder.asset_id) &&
          !activeAssets.has(workOrder.asset_id) &&
          latestDone.get(workOrder.asset_id) === workOrder
          ? 'done'
          : undefined
        : WORK_ORDER_GROUP[workOrder.status];
    if (!group) continue;
    groups[group].push({
      kind: 'work-order',
      key: `wo:${workOrder.work_order_id}`,
      id: workOrder.work_order_id,
      title: workOrder.asset_tag ?? workOrder.asset_id,
      workOrder,
    });
  }
  return groups;
}

/** A warranty pill shows for a flagged work order with no override row (undefined: not read yet). */
export function isWarrantyOpen(card: DeskCard, overrides: Map<string, OverrideState>): boolean {
  return (
    card.kind === 'work-order' &&
    card.workOrder.warranty_flagged &&
    card.workOrder.status !== 'completed' &&
    overrides.get(card.id) === null
  );
}

/** The override read failed for a flagged work order: the warranty state is unknown, not open. */
export function isWarrantyUnknown(card: DeskCard, overrides: Map<string, OverrideState>): boolean {
  return (
    card.kind === 'work-order' &&
    card.workOrder.warranty_flagged &&
    card.workOrder.status !== 'completed' &&
    overrides.get(card.id) === 'error'
  );
}

/** A count capped by the list limit reads "500+". */
export function countLabel(n: number): string {
  return n >= DESK_LIST_LIMIT ? `${DESK_LIST_LIMIT}+` : String(n);
}

export interface AttentionCounts {
  awaitingSignature: number;
  syncConflicts: number;
  warrantyFlagged: number;
}

export function attentionCounts(
  groups: DeskGroups,
  openConflicts: number,
  overrides: Map<string, OverrideState>,
): AttentionCounts {
  const all = GROUP_ORDER.flatMap((g) => groups[g]);
  return {
    // Counts assets, not work orders: one asset needs one signature.
    awaitingSignature: new Set(
      groups.done.map((c) => (c.kind === 'work-order' ? c.workOrder.asset_id : c.id)),
    ).size,
    syncConflicts: openConflicts,
    warrantyFlagged: all.filter((c) => isWarrantyOpen(c, overrides)).length,
  };
}

export function firstWarrantyCard(
  groups: DeskGroups,
  overrides: Map<string, OverrideState>,
): DeskCard | null {
  return GROUP_ORDER.flatMap((g) => groups[g]).find((c) => isWarrantyOpen(c, overrides)) ?? null;
}

/** True when any list came back full, so more rows may exist than the board shows. */
export function hitListLimit(lengths: number[]): boolean {
  return lengths.some((n) => n >= DESK_LIST_LIMIT);
}

export type DisabledReason = 'offline' | 'busy' | null;

/** Every desk action is online only; the reason is stated beside the disabled control. */
export function disabledReason(online: boolean, busy: boolean): DisabledReason {
  if (!online) return 'offline';
  return busy ? 'busy' : null;
}

export function canReject(reason: string): boolean {
  return reason.trim() !== '';
}

export function canSign(ticks: boolean[]): boolean {
  return ticks.length === SIGN_OFF_TICKS && ticks.every(Boolean);
}

export function canResolveConflict(code: string | null, note: string): boolean {
  return code !== null && note.length <= MAX_RESOLUTION_NOTE;
}

export function priorityLabel(priority: Priority | null): string | null {
  return priority ? priority.toUpperCase() : null;
}
