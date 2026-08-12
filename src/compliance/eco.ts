import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { EventEnvelope } from '../events/store.js';
import { AppError } from '../middleware/error.js';
import { getItemById } from '../read/projections/item_master.js';
import { isReleasedItemMaster } from './bom.js';
import {
  getBomLines,
  insertBomLine,
  insertBomRevision,
  updateBomCurrentRevision,
  updateBomStatus,
} from '../read/projections/bom.js';
import {
  insertEco,
  insertEcoChangeLine,
  updateEcoApproved,
  updateEcoCancelled,
  updateEcoImplemented,
  updateEcoReviewStarted,
  upsertEcoDisposition,
  type EcoChangeLineRow,
} from '../read/projections/eco.js';
import { toIstCalendarDate } from '../lib/business-days.js';
import { emitNotificationInTransaction } from '../notify/emit.js';
import type {
  EcoRaisedPayload,
  EcoReviewStartedPayload,
  EcoApprovedPayload,
  EcoImplementedPayload,
  EcoCancelledPayload,
  EcoStockDispositionRecordedPayload,
  EcoChangeInput,
} from '../events/schema.js';

const ENGINEERING_STREAM_TYPES = new Set(['engineering']);
const ECO_EVENT_TYPES = new Set([
  'eco.raised',
  'eco.review_started',
  'eco.approved',
  'eco.implemented',
  'eco.cancelled',
  'eco.stock_disposition_recorded',
]);

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_REGEX = /^(\d{4})-(\d{2})-(\d{2})$/;
// eslint-disable-next-line no-loss-of-precision
const MAX_NUMERIC_18_6 = 999_999_999_999.999_999;
// eslint-disable-next-line no-loss-of-precision
const MAX_NUMERIC_18_8 = 9_999_999_999.9999_9999;

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_REGEX.test(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isDateString(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = DATE_REGEX.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

function reject(
  code: string,
  message: string,
  details?: Record<string, unknown>,
  status: number = 400,
): never {
  throw new AppError(status, code, message, details);
}

function assertDecimalString(
  value: unknown,
  code: string,
  message: string,
  max: number,
  maxScale: number,
): void {
  if (typeof value !== 'string') reject(code, message);
  if (!/^\d+(\.\d+)?$/.test(value)) reject(code, message);
  const num = Number(value);
  if (isNaN(num)) reject(code, message);
  if (num <= 0) reject(code, message);
  if (num > max) reject(code, message);
  const parts = value.split('.');
  const scale = parts[1]?.length ?? 0;
  if (scale > maxScale) reject(code, message);
}

function assertScrapPercent(value: unknown): void {
  if (value === undefined || value === null) return;
  if (typeof value !== 'string')
    reject('BOM_INVALID_SCRAP_PERCENT', 'scrap_percent must be a string');
  const num = Number(value);
  if (isNaN(num)) reject('BOM_INVALID_SCRAP_PERCENT', 'scrap_percent must be numeric');
  if (num < 0 || num > 100)
    reject('BOM_INVALID_SCRAP_PERCENT', 'scrap_percent must be between 0 and 100');
  const parts = value.split('.');
  const scale = parts[1]?.length ?? 0;
  if (scale > 4) reject('BOM_INVALID_SCRAP_PERCENT', 'scrap_percent scale exceeds 4 decimals');
}

function assertYieldPercent(value: unknown): void {
  if (value === undefined || value === null) return;
  if (typeof value !== 'string')
    reject('BOM_INVALID_YIELD_PERCENT', 'expected_yield_percent must be a string');
  const num = Number(value);
  if (isNaN(num)) reject('BOM_INVALID_YIELD_PERCENT', 'expected_yield_percent must be numeric');
  if (num <= 0 || num > 100)
    reject('BOM_INVALID_YIELD_PERCENT', 'expected_yield_percent must be between 0 and 100');
  const parts = value.split('.');
  const scale = parts[1]?.length ?? 0;
  if (scale > 4)
    reject('BOM_INVALID_YIELD_PERCENT', 'expected_yield_percent scale exceeds 4 decimals');
}

function assertValidOccurredAt(occurredAt: unknown): asserts occurredAt is string {
  if (
    !occurredAt ||
    typeof occurredAt !== 'string' ||
    Number.isNaN(new Date(occurredAt).getTime())
  ) {
    reject('INVALID_PARAMS', 'occurred_at is required and must be a valid ISO 8601 date string');
  }
}

/** The calendar date one day before a YYYY-MM-DD date, computed in UTC (no DST in play). */
function previousCalendarDate(date: string): string {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const prev = new Date(new Date(`${date}T00:00:00Z`).getTime() - DAY_MS);
  return prev.toISOString().slice(0, 10);
}

export function ecoEventType(envelope: EventEnvelope): string | null {
  if (!ENGINEERING_STREAM_TYPES.has(envelope.stream_type)) return null;
  if (!ECO_EVENT_TYPES.has(envelope.event_type)) return null;
  return envelope.event_type;
}

export function assertEcoShape(envelope: EventEnvelope): void {
  const type = ecoEventType(envelope);
  if (!type) return;
  const p = envelope.payload as Record<string, unknown>;

  switch (type) {
    case 'eco.raised':
      assertEcoRaisedShape(p);
      break;
    case 'eco.review_started':
      assertEcoIdOnlyShape(p);
      break;
    case 'eco.approved':
      assertEcoApprovedShape(p);
      break;
    case 'eco.implemented':
      assertEcoImplementedShape(p);
      break;
    case 'eco.cancelled':
      assertEcoCancelledShape(p);
      break;
    case 'eco.stock_disposition_recorded':
      assertEcoStockDispositionRecordedShape(p);
      break;
  }
}

function assertEcoIdOnlyShape(p: Record<string, unknown>): void {
  if (!isUuid(p['eco_id'])) reject('INVALID_PARAMS', 'eco_id is required and must be a UUID');
}

function assertEcoChangeInputArray(changes: Record<string, unknown>[]): void {
  for (const change of changes) {
    const changeType = change['change_type'] as string;
    if (!['add', 'amend', 'retire'].includes(changeType)) {
      reject('INVALID_PARAMS', 'change_type must be one of add, amend, retire');
    }

    if (changeType === 'add') {
      if (change['target_bom_line_id'] !== undefined && change['target_bom_line_id'] !== null) {
        reject('INVALID_PARAMS', 'target_bom_line_id must not be set when change_type is add');
      }
      if (!isUuid(change['component_item_id'])) {
        reject('INVALID_PARAMS', 'component_item_id is required and must be a UUID for add');
      }
      const outputClass = (change['output_class'] as string) ?? 'component';
      if (!['component', 'co_product', 'by_product'].includes(outputClass)) {
        reject('INVALID_PARAMS', 'output_class must be one of component, co_product, by_product');
      }
      assertDecimalString(
        change['quantity_per'],
        'INVALID_PARAMS',
        'quantity_per must be a positive decimal string for add',
        MAX_NUMERIC_18_6,
        6,
      );
      if (!isNonEmptyString(change['line_uom']))
        reject('INVALID_PARAMS', 'line_uom is required and must be a non-empty string for add');
      assertDecimalString(
        change['uom_conversion_factor'],
        'BOM_INVALID_CONVERSION_FACTOR',
        'uom_conversion_factor must be a positive decimal string for add',
        MAX_NUMERIC_18_8,
        8,
      );
      assertScrapPercent(change['scrap_percent']);
      assertYieldPercent(change['expected_yield_percent']);
      if (change['is_phantom'] !== undefined && typeof change['is_phantom'] !== 'boolean') {
        reject('INVALID_PARAMS', 'is_phantom must be a boolean');
      }
      if (
        change['phantom_source_bom_id'] !== undefined &&
        change['phantom_source_bom_id'] !== null &&
        !isUuid(change['phantom_source_bom_id'])
      ) {
        reject('INVALID_PARAMS', 'phantom_source_bom_id must be a UUID or null');
      }
      if (!isDateString(change['effective_from']))
        reject(
          'INVALID_PARAMS',
          'effective_from is required and must be a YYYY-MM-DD date for add',
        );
      if (
        change['effective_to'] !== undefined &&
        change['effective_to'] !== null &&
        !isDateString(change['effective_to'])
      ) {
        reject('INVALID_PARAMS', 'effective_to must be a YYYY-MM-DD date or null');
      }
    } else {
      if (!isUuid(change['target_bom_line_id'])) {
        reject(
          'INVALID_PARAMS',
          'target_bom_line_id is required and must be a UUID for amend/retire',
        );
      }
      if (changeType === 'amend') {
        if (change['quantity_per'] !== undefined) {
          assertDecimalString(
            change['quantity_per'],
            'INVALID_PARAMS',
            'quantity_per must be a positive decimal string',
            MAX_NUMERIC_18_6,
            6,
          );
        }
        if (change['uom_conversion_factor'] !== undefined) {
          assertDecimalString(
            change['uom_conversion_factor'],
            'BOM_INVALID_CONVERSION_FACTOR',
            'uom_conversion_factor must be a positive decimal string',
            MAX_NUMERIC_18_8,
            8,
          );
        }
        if (change['scrap_percent'] !== undefined) assertScrapPercent(change['scrap_percent']);
        if (change['expected_yield_percent'] !== undefined)
          assertYieldPercent(change['expected_yield_percent']);
        if (
          change['effective_from'] !== undefined &&
          change['effective_from'] !== null &&
          !isDateString(change['effective_from'])
        ) {
          reject('INVALID_PARAMS', 'effective_from must be a YYYY-MM-DD date or null');
        }
        if (
          change['effective_to'] !== undefined &&
          change['effective_to'] !== null &&
          !isDateString(change['effective_to'])
        ) {
          reject('INVALID_PARAMS', 'effective_to must be a YYYY-MM-DD date or null');
        }
        const amendableFields = [
          'quantity_per',
          'uom_conversion_factor',
          'scrap_percent',
          'expected_yield_percent',
          'effective_from',
          'effective_to',
        ];
        if (
          !amendableFields.some((field) => change[field] !== undefined && change[field] !== null)
        ) {
          reject('INVALID_PARAMS', 'amend must change at least one field');
        }
      }
    }
  }
}

function assertEcoRaisedShape(p: Record<string, unknown>): void {
  if (!isUuid(p['eco_id'])) reject('INVALID_PARAMS', 'eco_id is required and must be a UUID');
  if (!isNonEmptyString(p['eco_number']))
    reject('INVALID_PARAMS', 'eco_number is required and must be a non-empty string');
  if (!isUuid(p['bom_id'])) reject('INVALID_PARAMS', 'bom_id is required and must be a UUID');
  if (!isUuid(p['target_revision_id']))
    reject('INVALID_PARAMS', 'target_revision_id is required and must be a UUID');
  if (!isNonEmptyString(p['business_stream']))
    reject('INVALID_PARAMS', 'business_stream is required and must be a non-empty string');
  if (!isNonEmptyString(p['reason']))
    reject('INVALID_PARAMS', 'reason is required and must be a non-empty string');
  if (p['approver_actor_id'] !== null && !isUuid(p['approver_actor_id']))
    reject('INVALID_PARAMS', 'approver_actor_id must be a UUID or null');
  if (p['doa_entry_id'] !== null && !isUuid(p['doa_entry_id']))
    reject('INVALID_PARAMS', 'doa_entry_id must be a UUID or null');

  const changes = p['changes'];
  if (!Array.isArray(changes) || changes.length === 0)
    reject('INVALID_PARAMS', 'At least one change is required');
  if (changes.length > 200) reject('INVALID_PARAMS', 'Maximum 200 changes per ECO');
  assertEcoChangeInputArray(changes as Record<string, unknown>[]);
}

function assertEcoApprovedShape(p: Record<string, unknown>): void {
  if (!isUuid(p['eco_id'])) reject('INVALID_PARAMS', 'eco_id is required and must be a UUID');
  if (p['decision_note'] !== undefined && !isNonEmptyString(p['decision_note']))
    reject('INVALID_PARAMS', 'decision_note must be a non-empty string when provided');
}

function assertEcoImplementedShape(p: Record<string, unknown>): void {
  if (!isUuid(p['eco_id'])) reject('INVALID_PARAMS', 'eco_id is required and must be a UUID');
  if (!isUuid(p['new_revision_id']))
    reject('INVALID_PARAMS', 'new_revision_id is required and must be a UUID');
  if (!isNonEmptyString(p['new_revision_code']))
    reject('INVALID_PARAMS', 'new_revision_code is required and must be a non-empty string');
}

function assertEcoCancelledShape(p: Record<string, unknown>): void {
  if (!isUuid(p['eco_id'])) reject('INVALID_PARAMS', 'eco_id is required and must be a UUID');
  if (!isNonEmptyString(p['cancel_reason']))
    reject('INVALID_PARAMS', 'cancel_reason is required and must be a non-empty string');
}

function assertEcoStockDispositionRecordedShape(p: Record<string, unknown>): void {
  if (!isUuid(p['eco_id'])) reject('INVALID_PARAMS', 'eco_id is required and must be a UUID');
  const dispositions = p['dispositions'];
  if (!Array.isArray(dispositions) || dispositions.length === 0)
    reject('INVALID_PARAMS', 'At least one disposition is required');
  for (const d of dispositions as Record<string, unknown>[]) {
    if (!isNonEmptyString(d['lot_id']))
      reject('INVALID_PARAMS', 'lot_id is required and must be a non-empty string');
    if (!isNonEmptyString(d['sku']))
      reject('INVALID_PARAMS', 'sku is required and must be a non-empty string');
    if (!isUuid(d['location_id']))
      reject('INVALID_PARAMS', 'location_id is required and must be a UUID');
    if (typeof d['on_hand_qty'] !== 'string' || isNaN(Number(d['on_hand_qty'])))
      reject('INVALID_PARAMS', 'on_hand_qty must be a decimal string');
    const qtyScale = (d['on_hand_qty'] as string).split('.')[1]?.length ?? 0;
    if (qtyScale > 6) reject('INVALID_PARAMS', 'on_hand_qty scale exceeds 6 decimals');
    const disposition = d['disposition'] as string;
    if (!['use_up', 'scrap', 'rework'].includes(disposition)) {
      reject('INVALID_PARAMS', 'disposition must be one of use_up, scrap, rework');
    }
    const reworkRef = d['rework_reference'];
    if (disposition === 'rework' && !isNonEmptyString(reworkRef)) {
      reject('INVALID_PARAMS', 'rework_reference is required when disposition is rework');
    }
    if (disposition !== 'rework' && reworkRef !== undefined && reworkRef !== null) {
      reject('INVALID_PARAMS', 'rework_reference must not be set unless disposition is rework');
    }
  }
}

// ---------------------------------------------------------------------------
// Inside-transaction projection (DB access)
// ---------------------------------------------------------------------------

async function alreadyPersisted(envelope: EventEnvelope, client: PoolClient): Promise<boolean> {
  if (!envelope.idempotency_key && !envelope.event_id) return false;
  const existing = await client.query(
    `SELECT 1 FROM domain_events WHERE ($1::text IS NOT NULL AND idempotency_key = $1) OR event_id = $2 LIMIT 1`,
    [envelope.idempotency_key ?? null, envelope.event_id ?? null],
  );
  return existing.rows.length > 0;
}

export async function applyEcoProjection(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
): Promise<void> {
  const type = ecoEventType(envelope);
  if (!type) return;

  switch (type) {
    case 'eco.raised':
      await applyEcoRaised(envelope, client, eventId);
      break;
    case 'eco.review_started':
      await applyEcoReviewStarted(envelope, client);
      break;
    case 'eco.approved':
      await applyEcoApproved(envelope, client);
      break;
    case 'eco.implemented':
      await applyEcoImplemented(envelope, client, eventId);
      break;
    case 'eco.cancelled':
      await applyEcoCancelled(envelope, client);
      break;
    case 'eco.stock_disposition_recorded':
      await applyEcoStockDispositionRecorded(envelope, client, eventId);
      break;
  }
}

async function applyEcoRaised(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
): Promise<void> {
  if (await alreadyPersisted(envelope, client)) return;

  const p = envelope.payload as unknown as EcoRaisedPayload;

  const bomRow = await client.query('SELECT * FROM bom WHERE bom_id = $1', [p.bom_id]);
  if (bomRow.rows.length === 0) reject('BOM_NOT_FOUND', 'BOM not found', { bom_id: p.bom_id }, 404);
  const bom = bomRow.rows[0]!;
  if (bom.status !== 'released') {
    reject(
      'BOM_NOT_RELEASED',
      'An ECO only changes a Released BOM',
      { bom_id: p.bom_id, status: bom.status },
      409,
    );
  }

  const revisionRow = await client.query(
    'SELECT * FROM bom_revision WHERE revision_id = $1 AND bom_id = $2',
    [p.target_revision_id, p.bom_id],
  );
  if (revisionRow.rows.length === 0 || revisionRow.rows[0]!.revision_status !== 'released') {
    reject(
      'INVALID_PARAMS',
      'target_revision_id must belong to bom_id and be released',
      { bom_id: p.bom_id, target_revision_id: p.target_revision_id },
      400,
    );
  }

  assertValidOccurredAt(envelope.metadata.occurred_at);
  const occurredAt = new Date(envelope.metadata.occurred_at).toISOString();
  const ecoId = (envelope.payload as Record<string, unknown>)['eco_id'] as string;
  const ecoNumber = p.eco_number;
  const actorId = envelope.metadata.actor.user_id;

  await insertEco(
    {
      eco_id: ecoId,
      eco_number: ecoNumber,
      bom_id: p.bom_id,
      target_revision_id: p.target_revision_id,
      business_stream: p.business_stream,
      status: 'draft',
      reason: p.reason,
      raised_by: actorId,
      approver_actor_id: p.approver_actor_id,
      doa_entry_id: p.doa_entry_id,
      review_started_at: null,
      approved_at: null,
      approved_by: null,
      implemented_at: null,
      implemented_by: null,
      new_revision_id: null,
      cancelled_at: null,
      cancelled_by: null,
      cancel_reason: null,
      status_changed_at: occurredAt,
      status_changed_by: actorId,
      correlation_id: p.correlation_id ?? null,
      source_event_id: eventId,
    },
    client,
  );

  let changeNo = 1;
  for (const change of p.changes) {
    await insertEcoChangeLineFromInput(ecoId, changeNo, change, eventId, client);
    changeNo++;
  }
}

async function insertEcoChangeLineFromInput(
  ecoId: string,
  changeNo: number,
  change: EcoChangeInput,
  eventId: string,
  client: PoolClient,
): Promise<void> {
  let componentSku: string | null = null;
  if (change.change_type === 'add' && change.component_item_id) {
    const componentItem = await getItemById(change.component_item_id, client);
    if (!componentItem) {
      reject(
        'BOM_ITEM_NOT_FOUND',
        'Component item not found',
        { component_item_id: change.component_item_id },
        404,
      );
    }
    componentSku = componentItem.sku;
  }

  await insertEcoChangeLine(
    {
      eco_change_id: randomUUID(),
      eco_id: ecoId,
      change_no: changeNo,
      change_type: change.change_type,
      target_bom_line_id: change.target_bom_line_id ?? null,
      component_item_id: change.component_item_id ?? null,
      component_sku: componentSku,
      output_class: change.output_class ?? 'component',
      quantity_per: change.quantity_per ?? null,
      line_uom: change.line_uom ?? null,
      uom_conversion_factor: change.uom_conversion_factor ?? null,
      base_quantity_per: null,
      scrap_percent: change.scrap_percent ?? null,
      expected_yield_percent: change.expected_yield_percent ?? null,
      is_phantom: change.is_phantom ?? false,
      phantom_source_bom_id: change.phantom_source_bom_id ?? null,
      effective_from: change.effective_from ?? null,
      effective_to: change.effective_to ?? null,
      source_event_id: eventId,
    },
    client,
  );
}

async function lockEcoOrReject(
  ecoId: string,
  client: PoolClient,
): Promise<Record<string, unknown>> {
  const ecoRow = await client.query('SELECT * FROM eco WHERE eco_id = $1 FOR UPDATE', [ecoId]);
  if (ecoRow.rows.length === 0) reject('ECO_NOT_FOUND', 'ECO not found', { eco_id: ecoId }, 404);
  return ecoRow.rows[0]!;
}

function assertTransition(
  eco: Record<string, unknown>,
  allowedFrom: string[],
  ecoId: string,
): void {
  const status = eco['status'] as string;
  if (!allowedFrom.includes(status)) {
    reject(
      'ECO_STATE_INVALID',
      `Cannot transition an ECO in ${status} state`,
      { eco_id: ecoId, status, allowed_from: allowedFrom },
      409,
    );
  }
}

async function applyEcoReviewStarted(envelope: EventEnvelope, client: PoolClient): Promise<void> {
  if (await alreadyPersisted(envelope, client)) return;

  const p = envelope.payload as unknown as EcoReviewStartedPayload;
  const eco = await lockEcoOrReject(p.eco_id, client);
  assertTransition(eco, ['draft'], p.eco_id);

  assertValidOccurredAt(envelope.metadata.occurred_at);
  await updateEcoReviewStarted(
    p.eco_id,
    new Date(envelope.metadata.occurred_at).toISOString(),
    envelope.metadata.actor.user_id,
    client,
  );
}

async function applyEcoApproved(envelope: EventEnvelope, client: PoolClient): Promise<void> {
  if (await alreadyPersisted(envelope, client)) return;

  const p = envelope.payload as unknown as EcoApprovedPayload;
  const eco = await lockEcoOrReject(p.eco_id, client);
  assertTransition(eco, ['under_review'], p.eco_id);

  assertValidOccurredAt(envelope.metadata.occurred_at);
  const occurredAt = new Date(envelope.metadata.occurred_at).toISOString();
  const actorId = envelope.metadata.actor.user_id;

  await updateEcoApproved(p.eco_id, occurredAt, actorId, client);

  // AD-17: approval decisions are transactional, part of the business fact - never emitNotification.
  const raiserRoleResult = await client.query(
    'SELECT role FROM user_role_assignments WHERE user_id = $1 ORDER BY created_at ASC LIMIT 1',
    [eco['raised_by'] as string],
  );
  const raiserRole = (raiserRoleResult.rows[0]?.role as string | undefined) ?? '';
  await emitNotificationInTransaction(
    {
      target: {
        role: raiserRole,
        user_id: eco['raised_by'] as string,
      },
      event_type: 'eco_decision',
      status_verb: 'approved',
      object_type: 'eco',
      object_id: p.eco_id,
      actor_label: `ECO ${eco['eco_number'] as string}`,
      next_step: 'Stock disposition decisions are required before this ECO can be implemented',
      actor: envelope.metadata.actor,
      correlation_id: envelope.metadata.correlation_id,
      occurred_at: occurredAt,
    },
    client,
  );
}

async function applyEcoCancelled(envelope: EventEnvelope, client: PoolClient): Promise<void> {
  if (await alreadyPersisted(envelope, client)) return;

  const p = envelope.payload as unknown as EcoCancelledPayload;
  const eco = await lockEcoOrReject(p.eco_id, client);
  assertTransition(eco, ['draft', 'under_review', 'approved'], p.eco_id);

  assertValidOccurredAt(envelope.metadata.occurred_at);
  await updateEcoCancelled(
    p.eco_id,
    new Date(envelope.metadata.occurred_at).toISOString(),
    envelope.metadata.actor.user_id,
    p.cancel_reason,
    client,
  );
}

async function applyEcoStockDispositionRecorded(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
): Promise<void> {
  if (await alreadyPersisted(envelope, client)) return;

  const p = envelope.payload as unknown as EcoStockDispositionRecordedPayload;
  const eco = await lockEcoOrReject(p.eco_id, client);
  assertTransition(eco, ['approved'], p.eco_id);

  assertValidOccurredAt(envelope.metadata.occurred_at);
  const decidedAt = new Date(envelope.metadata.occurred_at).toISOString();
  const decidedBy = envelope.metadata.actor.user_id;

  for (const d of p.dispositions) {
    await upsertEcoDisposition(
      {
        disposition_id: randomUUID(),
        eco_id: p.eco_id,
        lot_id: d.lot_id,
        sku: d.sku,
        location_id: d.location_id,
        on_hand_qty: d.on_hand_qty,
        disposition: d.disposition,
        rework_reference: d.rework_reference ?? null,
        notes: d.notes ?? null,
        decided_at: decidedAt,
        decided_by: decidedBy,
        source_event_id: eventId,
      },
      client,
    );
  }
}

interface AffectedLot {
  lot_id: string;
  sku: string;
  location_id: string;
  on_hand: string;
}

/**
 * Affected-lot set (Dev Notes, binding): every stock_balance row for the target BOM's
 * parent_sku with on_hand > 0 and a non-null lot_id, re-derived INSIDE this transaction (stock
 * moves between approval and implementation - never trust the earlier disposition call).
 */
async function getAffectedLots(parentSku: string, client: PoolClient): Promise<AffectedLot[]> {
  const result = await client.query(
    `SELECT lot_id, sku, location_id::text AS location_id, on_hand::text AS on_hand
       FROM stock_balance
      WHERE sku = $1 AND on_hand > 0 AND lot_id IS NOT NULL AND stock_class = 'owned'`,
    [parentSku],
  );
  return result.rows as AffectedLot[];
}

async function applyEcoImplemented(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
): Promise<void> {
  if (await alreadyPersisted(envelope, client)) return;

  const p = envelope.payload as unknown as EcoImplementedPayload;
  const eco = await lockEcoOrReject(p.eco_id, client);
  assertTransition(eco, ['approved'], p.eco_id);

  const bomId = eco['bom_id'] as string;
  const bomRow = await client.query('SELECT * FROM bom WHERE bom_id = $1 FOR UPDATE', [bomId]);
  if (bomRow.rows.length === 0) reject('BOM_NOT_FOUND', 'BOM not found', { bom_id: bomId }, 404);
  const bom = bomRow.rows[0]!;

  // A stale ECO (approved against a revision that a newer ECO already replaced) must not
  // clobber the newer revision's changes: the target must still be the BOM's current revision.
  const targetRevisionId = eco['target_revision_id'] as string;
  if (bom.current_revision_id !== targetRevisionId) {
    reject(
      'ECO_STALE',
      'The target revision is no longer the current revision of this BOM',
      {
        eco_id: p.eco_id,
        target_revision_id: targetRevisionId,
        current_revision_id: bom.current_revision_id,
      },
      409,
    );
  }

  // Guard the revision code under the bom lock: concurrent implements could mint the same code
  // from the same count; the unique index would otherwise surface as a raw 500.
  const codeConflict = await client.query(
    'SELECT 1 FROM bom_revision WHERE bom_id = $1 AND revision_code = $2 LIMIT 1',
    [bomId, p.new_revision_code],
  );
  if (codeConflict.rows.length > 0) {
    reject(
      'REVISION_CODE_CONFLICT',
      'The revision code is already in use for this BOM',
      { bom_id: bomId, revision_code: p.new_revision_code },
      409,
    );
  }

  const affectedLots = await getAffectedLots(bom.parent_sku as string, client);
  const dispositionRows = await client.query(
    'SELECT lot_id, location_id::text AS location_id FROM eco_stock_disposition WHERE eco_id = $1',
    [p.eco_id],
  );
  const decided = new Set(
    dispositionRows.rows.map((r) => `${r.lot_id as string}::${r.location_id as string}`),
  );
  const pendingLots = affectedLots.filter(
    (lot) => !decided.has(`${lot.lot_id}::${lot.location_id}`),
  );
  if (pendingLots.length > 0) {
    reject(
      'DISPOSITION_REQUIRED',
      'Every affected on-hand lot requires a stock-disposition decision before implementation',
      { eco_id: p.eco_id, pending_lots: pendingLots },
      409,
    );
  }

  assertValidOccurredAt(envelope.metadata.occurred_at);
  const occurredAt = new Date(envelope.metadata.occurred_at).toISOString();
  const actorId = envelope.metadata.actor.user_id;
  const supersededRevisionId = eco['target_revision_id'] as string;
  const newRevisionId = p.new_revision_id;

  await insertBomRevision(
    {
      revision_id: newRevisionId,
      bom_id: bomId,
      revision_code: p.new_revision_code,
      revision_status: 'released',
      drafted_by: actorId,
      drafted_at: occurredAt,
      released_at: occurredAt,
      released_by: actorId,
      source_eco_id: p.eco_id,
      source_event_id: eventId,
    },
    client,
  );

  // Copy every bom_line of the superseded revision onto the new revision with fresh
  // bom_line_ids. The superseded revision's own rows are NEVER touched (AC 4 immutability).
  const oldLines = await getBomLines(supersededRevisionId, client);
  const oldToNewLineId = new Map<string, string>();
  let maxLineNo = 0;
  for (const line of oldLines) {
    const newLineId = randomUUID();
    oldToNewLineId.set(line.bom_line_id, newLineId);
    maxLineNo = Math.max(maxLineNo, line.line_no);
    await insertBomLine(
      {
        bom_line_id: newLineId,
        revision_id: newRevisionId,
        bom_id: bomId,
        line_no: line.line_no,
        // Story 5.4: component identity is nullable (placeholder lines). ECOs attach only to
        // released production BOMs, which can never carry placeholders, but the copy is
        // field-faithful either way.
        component_item_id: line.component_item_id,
        component_sku: line.component_sku,
        is_placeholder: line.is_placeholder,
        free_text: line.free_text,
        output_class: line.output_class,
        quantity_per: line.quantity_per,
        line_uom: line.line_uom,
        uom_conversion_factor: line.uom_conversion_factor,
        base_quantity_per: line.base_quantity_per,
        scrap_percent: line.scrap_percent,
        expected_yield_percent: line.expected_yield_percent,
        is_phantom: line.is_phantom,
        phantom_source_bom_id: line.phantom_source_bom_id,
        effective_from: line.effective_from,
        effective_to: line.effective_to,
        blocking_release: false,
        blocking_reason: null,
        amended_at: null,
        source_event_id: eventId,
      },
      client,
    );
  }

  const changeLines = await client.query(
    `SELECT * FROM eco_change_line WHERE eco_id = $1 ORDER BY change_no ASC`,
    [p.eco_id],
  );
  const occurredAtBusinessDate = toIstCalendarDate(new Date(occurredAt));
  const retireEffectiveTo = previousCalendarDate(occurredAtBusinessDate);

  for (const row of changeLines.rows as EcoChangeLineRow[]) {
    if (row.change_type === 'add') {
      maxLineNo += 1;
      const componentItem = await getItemById(row.component_item_id as string, client);
      await client.query(
        `INSERT INTO bom_line (bom_line_id, revision_id, bom_id, line_no, component_item_id, component_sku, output_class, quantity_per, line_uom, uom_conversion_factor, base_quantity_per, scrap_percent, expected_yield_percent, is_phantom, phantom_source_bom_id, effective_from, effective_to, blocking_release, blocking_reason, source_event_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::numeric, $9, $10::numeric, $8::numeric * $10::numeric, $11, $12, $13, $14, $15, $16, false, NULL, $17)`,
        [
          randomUUID(),
          newRevisionId,
          bomId,
          maxLineNo,
          row.component_item_id,
          componentItem?.sku ?? row.component_sku,
          row.output_class,
          row.quantity_per,
          row.line_uom,
          row.uom_conversion_factor,
          row.scrap_percent,
          row.expected_yield_percent,
          row.is_phantom,
          row.phantom_source_bom_id,
          row.effective_from,
          row.effective_to,
          eventId,
        ],
      );
    } else if (row.change_type === 'amend') {
      const targetOldId = row.target_bom_line_id as string;
      const copiedLineId = oldToNewLineId.get(targetOldId);
      if (!copiedLineId) {
        reject(
          'INVALID_PARAMS',
          'target_bom_line_id does not belong to the superseded revision',
          { eco_id: p.eco_id, target_bom_line_id: targetOldId },
          400,
        );
      }
      const sets: string[] = ['amended_at = now()', 'updated_at = now()'];
      const values: unknown[] = [];
      let idx = 1;
      if (row.quantity_per !== null) {
        sets.push(`quantity_per = $${idx++}`);
        values.push(row.quantity_per);
      }
      if (row.uom_conversion_factor !== null) {
        sets.push(`uom_conversion_factor = $${idx++}`);
        values.push(row.uom_conversion_factor);
      }
      if (row.quantity_per !== null || row.uom_conversion_factor !== null) {
        sets.push(
          `base_quantity_per = COALESCE($${idx}::numeric, quantity_per) * COALESCE($${idx + 1}::numeric, uom_conversion_factor)`,
        );
        values.push(row.quantity_per, row.uom_conversion_factor);
        idx += 2;
      }
      if (row.scrap_percent !== null) {
        sets.push(`scrap_percent = $${idx++}`);
        values.push(row.scrap_percent);
      }
      if (row.expected_yield_percent !== null) {
        sets.push(`expected_yield_percent = $${idx++}`);
        values.push(row.expected_yield_percent);
      }
      if (row.effective_from !== null) {
        sets.push(`effective_from = $${idx++}`);
        values.push(row.effective_from);
      }
      if (row.effective_to !== null) {
        sets.push(`effective_to = $${idx++}`);
        values.push(row.effective_to);
      }
      values.push(copiedLineId);
      await client.query(
        `UPDATE bom_line SET ${sets.join(', ')} WHERE bom_line_id = $${idx}`,
        values,
      );
    } else if (row.change_type === 'retire') {
      const targetOldId = row.target_bom_line_id as string;
      const copiedLineId = oldToNewLineId.get(targetOldId);
      if (!copiedLineId) {
        reject(
          'INVALID_PARAMS',
          'target_bom_line_id does not belong to the superseded revision',
          { eco_id: p.eco_id, target_bom_line_id: targetOldId },
          400,
        );
      }
      // Retire NEVER deletes: it closes effectivity. A caller-supplied effective_to is honored;
      // otherwise it closes the day before the implementation's IST business date.
      const retireDate = row.effective_to ?? retireEffectiveTo;
      await client.query(
        'UPDATE bom_line SET effective_to = $1, amended_at = now(), updated_at = now() WHERE bom_line_id = $2',
        [retireDate, copiedLineId],
      );
    }
  }

  // The ECO path creates a released revision without routing through applyBomReleased, so the
  // release gate's enforced conditions must be re-checked here inside the transaction: every
  // component item master must be active (A-11) and every line must carry scrap_percent. Copied
  // lines can reference item masters that deactivated since the superseded revision was released.
  const gateLineRows = await client.query(
    `SELECT bom_line_id, line_no, component_item_id, scrap_percent
       FROM bom_line WHERE revision_id = $1 ORDER BY line_no`,
    [newRevisionId],
  );
  const blockingLines: { bom_line_id: string; line_no: number }[] = [];
  const scrapMissingLines: { bom_line_id: string; line_no: number }[] = [];
  for (const line of gateLineRows.rows as Array<{
    bom_line_id: string;
    line_no: number;
    component_item_id: string;
    scrap_percent: string | null;
  }>) {
    const componentItem = await getItemById(line.component_item_id, client);
    let blockingRelease = false;
    let blockingReason: string | null = null;
    if (!componentItem) {
      blockingRelease = true;
      blockingReason = `Component item ${line.component_item_id} not found`;
    } else if (!isReleasedItemMaster(componentItem)) {
      blockingRelease = true;
      blockingReason = `Component item ${componentItem.sku} is ${componentItem.status} - BOM cannot be released until item is active`;
    }
    if (blockingRelease) {
      blockingLines.push({ bom_line_id: line.bom_line_id, line_no: line.line_no });
    }
    if (line.scrap_percent === null) {
      scrapMissingLines.push({ bom_line_id: line.bom_line_id, line_no: line.line_no });
    }
    await client.query(
      'UPDATE bom_line SET blocking_release = $1, blocking_reason = $2, updated_at = now() WHERE bom_line_id = $3',
      [blockingRelease, blockingReason, line.bom_line_id],
    );
  }
  await client.query(
    'UPDATE bom SET blocking_line_count = $1, updated_at = now() WHERE bom_id = $2',
    [blockingLines.length, bomId],
  );

  const unmetGateConditions: string[] = [];
  if (blockingLines.length > 0) unmetGateConditions.push('component_item_masters_released');
  if (scrapMissingLines.length > 0) unmetGateConditions.push('scrap_percent_missing');
  if (unmetGateConditions.length > 0) {
    reject(
      'RELEASE_GATE_UNMET',
      'ECO implementation would release a revision that fails the release gate',
      {
        bom_id: bomId,
        unmet_conditions: unmetGateConditions,
        component_item_masters_released: { blocking_lines: blockingLines },
        scrap_percent_missing: { lines: scrapMissingLines },
      },
      409,
    );
  }

  await updateBomCurrentRevision(bomId, newRevisionId, client);
  await updateBomStatus(bomId, 'released', occurredAt, actorId, client);
  await updateEcoImplemented(p.eco_id, occurredAt, actorId, newRevisionId, client);
}
