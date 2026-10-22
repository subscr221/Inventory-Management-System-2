/**
 * Story 3.16 (AC 2): the floor task inbox is a pure merge of two status reads plus ownership
 * ordering, so the rules are unit tested without a DOM. The component owns fetching and rendering.
 */

export interface PickTaskRow {
  pick_task_id: string;
  dispatch_order_id: string;
  so_number_ext: string | null;
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
  assigned_to: string | null;
  confirmed_line_count: number | null;
  line_count: number | null;
}

/** Merge the pending and in_progress reads into one deduplicated list, in_progress winning ties. */
export function mergeTasks(...groups: PickTaskRow[][]): PickTaskRow[] {
  const byId = new Map<string, PickTaskRow>();
  const rank = (status: PickTaskRow['status']): number => (status === 'in_progress' ? 1 : 0);
  for (const group of groups) {
    for (const row of group) {
      const existing = byId.get(row.pick_task_id);
      if (!existing || rank(row.status) > rank(existing.status)) byId.set(row.pick_task_id, row);
    }
  }
  return [...byId.values()];
}

/**
 * The actionable set: a task is actionable when it is assigned to the caller, or unassigned at
 * the site. Tasks assigned to someone else are hidden. Mine first, then the unassigned.
 */
export function buildInbox(
  tasks: PickTaskRow[],
  userId: string,
): PickTaskRow[] {
  return tasks
    .filter((row) => row.assigned_to === userId || row.assigned_to === null)
    .sort((a, b) => {
      const aMine = a.assigned_to === userId ? 0 : 1;
      const bMine = b.assigned_to === userId ? 0 : 1;
      return aMine - bMine;
    });
}

export type PickTaskRowStatus = PickTaskRow['status'];

/** Text pill key: In progress when in_progress, Pending otherwise. */
export function pillKeyFor(status: PickTaskRowStatus): string {
  return status === 'in_progress' ? 'floor.pill.inProgress' : 'floor.pill.pending';
}
