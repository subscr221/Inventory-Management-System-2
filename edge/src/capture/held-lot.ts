/**
 * Story 8.5 (FR-Q-09, AC 2): the PRE-CAPTURE held-lot guard. Reads the synced `held_lot` table
 * (replicated by the global quality_holds bucket in sync/sync-rules.yaml) so a technician is told
 * about a hold BEFORE capture rather than after replay rejection. This is a courtesy check only -
 * the authoritative rejection is the central write path's LOT_ON_HOLD, which the existing
 * PERMANENT_ERROR_CODES / needs_attention / syncFailures machinery classifies for supervisor
 * review on replay (Binding Scope Decision 8). No timer, no poll, no second review queue.
 */

export interface HeldLotRow {
  lot_id: string;
  lot_number: string;
  sku: string;
  quality_hold_status: string;
  quality_hold_reason: string | null;
}

interface HeldLotReader {
  getAll<T>(sql: string, parameters?: unknown[]): Promise<T[]>;
}

export async function getHeldLot(
  db: HeldLotReader,
  lotNumber: string,
): Promise<HeldLotRow | null> {
  const rows = await db.getAll<HeldLotRow>(
    `SELECT lot_id, lot_number, sku, quality_hold_status, quality_hold_reason
       FROM held_lot WHERE lot_number = ? LIMIT 1`,
    [lotNumber],
  );
  return rows[0] ?? null;
}

/** Throws with a technician-facing message when the lot is held; a no-op otherwise. */
export async function assertLotNotHeld(db: HeldLotReader, lotNumber: string): Promise<void> {
  const held = await getHeldLot(db, lotNumber);
  if (held) {
    throw new Error(
      `Lot ${held.lot_number} is on quality hold${held.quality_hold_reason ? ` (${held.quality_hold_reason})` : ''}. Capture against a held lot is blocked; contact QC.`,
    );
  }
}
