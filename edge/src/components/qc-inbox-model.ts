// Story 8.11 (D2): the pure half of the QC inbox. Grouping is display only; which actions a
// person may take always comes from the server (a 403 or the task state), never from the client.

export type QcTaskStatus = 'open' | 'sampling_determined' | 'inspected';

export interface QcTaskListItem {
  task_id: string;
  lot_id: string;
  lot_number: string;
  sku: string;
  quantity: string;
  uom: string;
  site_id: string;
  source_completion_type: string;
  task_status: QcTaskStatus;
  gate_status: string;
  disposition?: 'accept' | 'reject' | 'split' | 'conditional_release' | null;
  disposition_at?: string | null;
  released_at?: string | null;
  inspect_on_opening?: boolean;
}

export interface QcInboxDamageItem {
  report_id: string;
  lot_number?: string | null;
  whole_lot_requested: boolean;
}

export type QcInboxGroupKey =
  | 'bay'
  | 'damage'
  | 'awaitingDisposition'
  | 'sentOn'
  | 'doneToday';

export interface QcInboxGroup {
  group: QcInboxGroupKey;
  tasks: QcTaskListItem[];
  damage: QcInboxDamageItem[];
  sentOnCount: number;
}

const GROUP_ORDER: readonly QcInboxGroupKey[] = [
  'bay',
  'damage',
  'awaitingDisposition',
  'sentOn',
  'doneToday',
];

function isLocalToday(iso: string | null | undefined, today: string): boolean {
  if (!iso) return false;
  try {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return false;
    return localDateString(date) === today;
  } catch {
    return false;
  }
}

/** The device's local date as YYYY-MM-DD (the "Done today" boundary is local, not IST). */
export function localDateString(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Deduplicate tasks fetched across AC 2's scoped queries, preserving first-seen order. */
export function mergeQcTasks(lists: ReadonlyArray<readonly QcTaskListItem[]>): QcTaskListItem[] {
  const seen = new Set<string>();
  const out: QcTaskListItem[] = [];
  for (const list of lists) {
    for (const item of list) {
      if (seen.has(item.task_id)) continue;
      seen.add(item.task_id);
      out.push(item);
    }
  }
  return out;
}

/**
 * Every group in AC 2 order. "To inspect" is every qc_hold task whose inspection has not yet
 * completed (open or sampling_determined); "Awaiting disposition" is inspected without a
 * disposition; "Sent on" carries a scalar count from the damage workbench; "Done today" is a
 * disposition or release on the device's local date.
 */
export function groupQcInbox(
  tasks: readonly QcTaskListItem[],
  damage: {
    toInspect: QcInboxDamageItem[];
    wholeLot: QcInboxDamageItem[];
    sentOnCount: number;
  },
  today: string,
): QcInboxGroup[] {
  const buckets: Record<
    QcInboxGroupKey,
    { tasks: QcTaskListItem[]; damage: QcInboxDamageItem[]; sentOnCount: number }
  > = {
    bay: { tasks: [], damage: [], sentOnCount: 0 },
    damage: { tasks: [], damage: [], sentOnCount: 0 },
    awaitingDisposition: { tasks: [], damage: [], sentOnCount: 0 },
    sentOn: { tasks: [], damage: [], sentOnCount: Math.max(0, damage.sentOnCount) },
    doneToday: { tasks: [], damage: [], sentOnCount: 0 },
  };
  for (const task of tasks) {
    if (task.gate_status === 'qc_hold' && task.task_status !== 'inspected') {
      buckets.bay.tasks.push(task);
    }
    if (task.task_status === 'inspected' && !task.disposition) {
      buckets.awaitingDisposition.tasks.push(task);
    }
    if (
      (isLocalToday(task.disposition_at, today) || isLocalToday(task.released_at, today)) &&
      Boolean(task.disposition || task.released_at)
    ) {
      buckets.doneToday.tasks.push(task);
    }
  }
  const seenDamage = new Set<string>();
  for (const item of [...damage.toInspect, ...damage.wholeLot]) {
    if (seenDamage.has(item.report_id)) continue;
    seenDamage.add(item.report_id);
    buckets.damage.damage.push(item);
  }
  return GROUP_ORDER.map((group) => ({ group, ...buckets[group] }));
}

/** Resolve a scanned lot number or barcode to a task on the already-fetched list, or null. */
export function resolveScannedLot(
  tasks: readonly QcTaskListItem[],
  code: string,
): QcTaskListItem | null {
  const trimmed = code.trim();
  if (!trimmed) return null;
  return tasks.find((task) => task.lot_number === trimmed) ?? null;
}
