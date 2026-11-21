import type { PoolClient } from 'pg';
import type { EventEnvelope } from '../events/store.js';
import { AppError } from '../middleware/error.js';
import { upsertResolvedException } from '../read/projections/receiving_exception.js';

// Story 3.19: goods.over_tolerance_accepted resolves a GOOD GRN line that was rejected over the PO
// receipt tolerance. The accepted quantity posts as its own goods.received (the unchanged receiving
// seam); this event only records the resolution on the rejected line and the exception row.

const EVENT_TYPE = 'goods.over_tolerance_accepted';
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const QTY_REGEX = /^\d+(\.\d+)?$/;
const NOTE_MAX = 500;
const QTY_FIELDS = [
  'accepted_qty',
  'excess_qty',
  'counted_qty',
  'ordered_qty',
  'already_received_qty',
  'tolerance_pct',
  'cap_qty',
] as const;

export const EXCESS_RETURNED_REASON = 'EXCESS_RETURNED_WITH_VEHICLE';

export function assertGoodsOverToleranceAcceptedShape(envelope: EventEnvelope): void {
  if (envelope.event_type !== EVENT_TYPE) return;
  const p = envelope.payload;
  for (const key of ['grn_line_id', 'accepted_grn_line_id', 'resolved_by']) {
    const v = p[key];
    if (typeof v !== 'string' || !UUID_REGEX.test(v))
      throw new AppError(400, 'INVALID_PARAMS', `${key} is required and must be a UUID`);
  }
  for (const key of QTY_FIELDS) {
    const v = p[key];
    if (typeof v !== 'string' || !QTY_REGEX.test(v))
      throw new AppError(400, 'INVALID_PARAMS', `${key} must be a non-negative numeric string`);
  }
  if (Number(p['accepted_qty']) <= 0)
    throw new AppError(400, 'INVALID_PARAMS', 'accepted_qty must be greater than zero');
  const note = p['note'];
  if (note === undefined || note === null) p['note'] = null;
  else if (typeof note !== 'string' || note.trim().length > NOTE_MAX)
    throw new AppError(400, 'INVALID_PARAMS', `note must be a string of at most ${NOTE_MAX} chars`);
  else p['note'] = note.trim().length > 0 ? note.trim() : null;
}

export async function applyGoodsOverToleranceAcceptedProjection(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
): Promise<void> {
  if (envelope.event_type !== EVENT_TYPE) return;
  const p = envelope.payload;
  const grnLineId = p['grn_line_id'] as string;
  const line = await client.query(
    `SELECT l.status, l.line_condition, l.resolved_at, g.site_id
       FROM grn_line l JOIN grn g ON g.grn_id = l.grn_id
      WHERE l.grn_line_id = $1 FOR UPDATE OF l`,
    [grnLineId],
  );
  if (line.rows.length === 0)
    throw new AppError(404, 'GRN_LINE_NOT_FOUND', `No GRN line exists for "${grnLineId}"`, {
      grn_line_id: grnLineId,
    });
  const row = line.rows[0]!;
  if (row['status'] !== 'rejected' || row['line_condition'] !== 'GOOD')
    throw new AppError(
      409,
      'GRN_LINE_NOT_REJECTED',
      'Only a GOOD line rejected over tolerance can be accepted within the band',
      { grn_line_id: grnLineId },
    );
  if (row['resolved_at'])
    throw new AppError(409, 'GRN_LINE_ALREADY_RESOLVED', 'This GRN line is already resolved', {
      grn_line_id: grnLineId,
    });
  const resolvedBy = p['resolved_by'] as string;
  await client.query(
    `UPDATE grn_line
        SET resolved_by = $2, resolved_at = now(), resolution = 'accepted_within_band', updated_at = now()
      WHERE grn_line_id = $1`,
    [grnLineId, resolvedBy],
  );
  await upsertResolvedException(
    {
      kind: 'over_tolerance',
      source_id: grnLineId,
      site_id: row['site_id'] as string,
      status: 'resolved',
      resolution: 'accepted_within_band',
      reason_code: EXCESS_RETURNED_REASON,
      note: (p['note'] as string | null) ?? null,
      resolved_by: resolvedBy,
      accepted_grn_line_id: p['accepted_grn_line_id'] as string,
      ordered_qty: p['ordered_qty'] as string,
      already_received_qty: p['already_received_qty'] as string,
      tolerance_pct: p['tolerance_pct'] as string,
      cap_qty: p['cap_qty'] as string,
      counted_qty: p['counted_qty'] as string,
      excess_qty: p['excess_qty'] as string,
      source_event_id: eventId,
    },
    client,
  );
}
