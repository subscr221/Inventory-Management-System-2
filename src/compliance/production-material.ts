import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { EventEnvelope } from '../events/store.js';
import { AppError } from '../middleware/error.js';
import { config } from '../config/index.js';
import { getPool } from '../config/db.js';
import {
  getProductionOrderByIdForUpdate,
  type ProductionOrderRow,
} from '../read/projections/production_order.js';
import {
  applyStockAllocation,
  applyStockDeallocation,
  applyStockIssue,
  applyStockIssueUnderSite,
  applyStockReceipt,
  type StockDrainRow,
} from '../read/projections/stock_balance.js';
import { getInventoryValuation } from '../read/projections/inventory_valuation.js';
import { assertQcGateAllows, gateBusinessDateOf } from './quality.js';
import {
  insertProductionOrderStage,
  getStageByIdForUpdate,
  applyStageIssuedQuantity,
} from '../read/projections/production_order_stage.js';
import {
  insertWipPosting,
  getPostingByIdForUpdate,
  getReturnExceeds,
  getOpenPostingCount,
  getBackflushShortfall,
} from '../read/projections/production_wip_ledger.js';
import { resolveMaterialRequirements } from '../production/material-staging.js';
import { toIstCalendarDate } from '../lib/business-days.js';

/**
 * Story 6.2 compliance seam for production material flow (FR-MO-04/05/06). Structurally mirrors
 * src/compliance/production-order.ts verbatim: a stream gate, a PURE pre-transaction shape assert,
 * an in-transaction projection switch, an alreadyPersisted guard (plain SELECT on domain_events,
 * never FOR UPDATE - the Story 4.3 lesson) and the same reject() AppError helper, copied rather
 * than re-derived.
 *
 * This seam is the enforcement point, NOT the handler. Every rule in the Applier Contracts is
 * enforced inside the appliers, so a direct POST /api/v1/events cannot bypass any of them
 * (AD-12). The handler may pre-run the same resolutions to return a cleaner error earlier, but
 * removing a handler check must never change what is possible through the direct-event path.
 *
 * Locking contract (Table 6): every applier takes the production order row FOR UPDATE FIRST
 * (404 PRODUCTION_ORDER_NOT_FOUND when absent), then the stage row (issue) or the source posting
 * (return), then the stock_balance rows - which are locked ONLY inside the Epic 2 helpers and
 * always LAST (the 7.4 rule). inventory_valuation is read WITHOUT a lock (Binding Decision 8:
 * an unlocked advisory cost basis; locking it would make every issue serialize on a hot row).
 *
 * Re-derivation contract: every declared-and-checked field (revision_id, per-line
 * component_item_id/component_sku/required_quantity, bounded quantities, reason_code) is re-derived
 * under lock and rejected 409 PRODUCTION_MATERIAL_DERIVATION_MISMATCH on divergence; every
 * server-derived field (stage_id, posting_id, postings[], backflush_lines[], business_date, actor
 * stamps) is written back onto envelope.payload so the direct-event and handler paths persist
 * byte-identical payloads. Declaring a server-minted field is a fabrication attempt and rejects.
 *
 * Status gate (Binding Decision 11): all four events require order status `released` or
 * `in_process`; any other status rejects 400 INVALID_STATE_TRANSITION.
 */

const PRODUCTION_STREAM_TYPES = new Set(['production']);
const PRODUCTION_MATERIAL_EVENT_TYPES = new Set([
  'production_order.material_staged',
  'production_order.material_issued',
  'production_order.confirmation_recorded',
  'production_order.material_returned',
]);

// The wildcard marker the route handlers stamp when the caller's assignment is '*'.
const NO_LOCATION_UUID = '00000000-0000-0000-0000-000000000000';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Matches the NUMERIC(18,6) ceiling used across the BOM and production modules.
const DECIMAL_REGEX = /^\d{1,12}(\.\d{1,6})?$/;
const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
// An explicit UTC offset is REQUIRED (the Story 7.2 offset lesson).
const ISO8601_TIMESTAMP_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const MAX_TEXT_LENGTH = 512;
const MAX_REASON_CODE_LENGTH = 200;

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_REGEX.test(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !DATE_REGEX.test(value)) return false;
  const [y, m, d] = value.split('-').map((part) => Number(part));
  const dt = new Date(Date.UTC(y!, m! - 1, d!));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m! - 1 && dt.getUTCDate() === d;
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO8601_TIMESTAMP_REGEX.test(value)) return false;
  const datePart = value.slice(0, 10);
  const [y, m, d] = datePart.split('-').map((part) => Number(part));
  const dt = new Date(Date.UTC(y!, m! - 1, d!));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m! - 1 || dt.getUTCDate() !== d)
    return false;
  const timeMatch = value.match(/T(\d{2}):(\d{2}):(\d{2})/);
  if (!timeMatch) return false;
  const hh = Number(timeMatch[1]);
  const mm = Number(timeMatch[2]);
  const ss = Number(timeMatch[3]);
  if (hh > 23 || mm > 59 || ss > 59) return false;
  // PostgreSQL rejects a time zone displacement outside +/-15:59 with SQLSTATE 22009, which is not
  // mapped; bound the offset here so an out-of-range displacement is a clean 400, not a 500.
  const offsetMatch = value.match(/([+-])(\d{2}):(\d{2})$/);
  if (offsetMatch) {
    const oh = Number(offsetMatch[2]);
    const om = Number(offsetMatch[3]);
    if (oh > 15 || om > 59) return false;
  }
  return true;
}

function isPositiveDecimal(value: unknown): value is string {
  return typeof value === 'string' && DECIMAL_REGEX.test(value) && Number(value) > 0;
}

/**
 * A DERIVED positive decimal (required_quantity on staging/backflush lines). Unlike a client
 * quantity - bounded to the NUMERIC(18,6) ceiling - a derived value comes from the explosion's
 * NUMERIC arithmetic and can carry the full 32+ digits of scale PostgreSQL computes
 * (`10 * 2.0` textifies as `20.00000000000000000000000000000000`). The applier settles the
 * declared-vs-derived comparison in SQL NUMERIC, so this gate only needs to prove it is a
 * positive plain decimal string, not bound its scale.
 */
function isDerivedPositiveDecimal(value: unknown): value is string {
  return typeof value === 'string' && /^\d{1,40}(\.\d{1,40})?$/.test(value) && Number(value) > 0;
}

function isLotNumber(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && value.trim().length <= MAX_TEXT_LENGTH);
}

export function productionMaterialEventType(envelope: EventEnvelope): string | null {
  if (!PRODUCTION_STREAM_TYPES.has(envelope.stream_type)) return null;
  if (!PRODUCTION_MATERIAL_EVENT_TYPES.has(envelope.event_type)) return null;
  return envelope.event_type;
}

function reject(
  code: string,
  message: string,
  details?: Record<string, unknown>,
  status: number = 400,
): never {
  throw new AppError(status, code, message, details);
}

// ---------------------------------------------------------------------------
// Pre-transaction shape validation (no DB access)
// ---------------------------------------------------------------------------

function isPostingShape(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const p = value as Record<string, unknown>;
  return (
    isUuid(p['posting_id']) &&
    isUuid(p['bom_line_id']) &&
    isUuid(p['component_item_id']) &&
    isNonEmptyString(p['component_sku']) &&
    isLotNumber(p['lot_number']) &&
    isUuid(p['source_location_id']) &&
    isPositiveDecimal(p['quantity']) &&
    isPositiveDecimal(p['unit_cost']) &&
    isPositiveDecimal(p['posting_value'])
  );
}

export function assertProductionMaterialShape(envelope: EventEnvelope): void {
  const type = productionMaterialEventType(envelope);
  if (!type) return;
  const p = envelope.payload as Record<string, unknown>;

  if (!isUuid(p['production_order_id'])) {
    reject('INVALID_PAYLOAD', 'production_order_id must be a UUID');
  }
  if (envelope.stream_id !== p['production_order_id']) {
    reject('INVALID_PAYLOAD', 'stream_id must match the payload production_order_id', {
      stream_id: envelope.stream_id,
      payload_production_order_id: p['production_order_id'],
    });
  }

  switch (type) {
    case 'production_order.material_staged':
      assertMaterialStagedShape(p);
      break;
    case 'production_order.material_issued':
      assertMaterialIssuedShape(p);
      break;
    case 'production_order.confirmation_recorded':
      assertConfirmationRecordedShape(p);
      break;
    case 'production_order.material_returned':
      assertMaterialReturnedShape(p);
      break;
  }
}

function assertMaterialStagedShape(p: Record<string, unknown>): void {
  if (!isUuid(p['revision_id'])) {
    reject('INVALID_PAYLOAD', 'revision_id must be a UUID');
  }
  if (!isIsoDate(p['business_date'])) {
    reject('INVALID_PAYLOAD', 'business_date must be a YYYY-MM-DD calendar date');
  }
  const lines = p['lines'];
  if (!Array.isArray(lines) || lines.length === 0) {
    reject('INVALID_PAYLOAD', 'material_staged requires a non-empty lines array');
  }
  for (const raw of lines) {
    const line = raw as Record<string, unknown>;
    // stage_id is server-minted write-back: a declared value is rejected in the applier, so the
    // assert only type-checks it when present (a malformed direct event is a 400, never a 500).
    if (line['stage_id'] !== undefined && line['stage_id'] !== null && !isUuid(line['stage_id'])) {
      reject('INVALID_PAYLOAD', 'stage_id must be a UUID when present');
    }
    if (!isUuid(line['bom_line_id'])) {
      reject('INVALID_PAYLOAD', 'each staging line requires a bom_line_id UUID');
    }
    if (!isUuid(line['component_item_id'])) {
      reject('INVALID_PAYLOAD', 'each staging line requires a component_item_id UUID');
    }
    if (!isNonEmptyString(line['component_sku'])) {
      reject('INVALID_PAYLOAD', 'each staging line requires a non-blank component_sku');
    }
    if (!isDerivedPositiveDecimal(line['required_quantity'])) {
      reject(
        'INVALID_PAYLOAD',
        'each staging line requires required_quantity as a positive decimal string',
      );
    }
    if (!isUuid(line['source_location_id'])) {
      reject('INVALID_PAYLOAD', 'each staging line requires a source_location_id UUID');
    }
    if (!isLotNumber(line['lot_number'])) {
      reject('INVALID_PAYLOAD', 'lot_number must be null or a string of at most 512 characters');
    }
    if (
      line['staged_by'] !== undefined &&
      line['staged_by'] !== null &&
      !isUuid(line['staged_by'])
    ) {
      reject('INVALID_PAYLOAD', 'staged_by must be a UUID when present');
    }
    if (!isIsoTimestamp(line['staged_at'])) {
      reject(
        'INVALID_PAYLOAD',
        'each staging line requires staged_at as an ISO 8601 timestamp with an explicit offset',
      );
    }
  }
}

function assertMaterialIssuedShape(p: Record<string, unknown>): void {
  if (!isUuid(p['stage_id'])) {
    reject('INVALID_PAYLOAD', 'stage_id must be a UUID');
  }
  if (!isPositiveDecimal(p['quantity'])) {
    reject('INVALID_PAYLOAD', 'quantity is required and must be a positive decimal string');
  }
  if (p['issued_by'] !== undefined && p['issued_by'] !== null && !isUuid(p['issued_by'])) {
    reject('INVALID_PAYLOAD', 'issued_by must be a UUID when present');
  }
  if (!isIsoTimestamp(p['issued_at'])) {
    reject('INVALID_PAYLOAD', 'issued_at must be an ISO 8601 timestamp with an explicit offset');
  }
  // postings are server-minted write-back; type-check when declared so a malformed direct event is
  // a 400, and the applier rejects any declared (fabricated) posting set with 409.
  if (p['postings'] !== undefined && p['postings'] !== null) {
    if (!Array.isArray(p['postings']) || !p['postings'].every(isPostingShape)) {
      reject('INVALID_PAYLOAD', 'postings must be an array of well-formed posting objects');
    }
  }
}

function assertConfirmationRecordedShape(p: Record<string, unknown>): void {
  if (!isPositiveDecimal(p['confirmed_quantity'])) {
    reject(
      'INVALID_PAYLOAD',
      'confirmed_quantity is required and must be a positive decimal string',
    );
  }
  if (!isUuid(p['revision_id'])) {
    reject('INVALID_PAYLOAD', 'revision_id must be a UUID');
  }
  if (!isIsoDate(p['business_date'])) {
    reject('INVALID_PAYLOAD', 'business_date must be a YYYY-MM-DD calendar date');
  }
  if (p['confirmed_by'] !== undefined && p['confirmed_by'] !== null && !isUuid(p['confirmed_by'])) {
    reject('INVALID_PAYLOAD', 'confirmed_by must be a UUID when present');
  }
  if (!isIsoTimestamp(p['confirmed_at'])) {
    reject('INVALID_PAYLOAD', 'confirmed_at must be an ISO 8601 timestamp with an explicit offset');
  }
  if (p['backflush_lines'] !== undefined && p['backflush_lines'] !== null) {
    if (!Array.isArray(p['backflush_lines'])) {
      reject('INVALID_PAYLOAD', 'backflush_lines must be an array when present');
    }
    for (const raw of p['backflush_lines']) {
      const line = raw as Record<string, unknown>;
      if (
        !isUuid(line['bom_line_id']) ||
        !isNonEmptyString(line['component_sku']) ||
        !isDerivedPositiveDecimal(line['required_quantity']) ||
        !Array.isArray(line['postings']) ||
        !line['postings'].every(isPostingShape)
      ) {
        reject(
          'INVALID_PAYLOAD',
          'each backflush line requires bom_line_id, component_sku, required_quantity and postings',
        );
      }
    }
  }
}

function assertMaterialReturnedShape(p: Record<string, unknown>): void {
  if (!isUuid(p['source_posting_id'])) {
    reject('INVALID_PAYLOAD', 'source_posting_id must be a UUID');
  }
  if (!isPositiveDecimal(p['quantity'])) {
    reject('INVALID_PAYLOAD', 'quantity is required and must be a positive decimal string');
  }
  const reasonCode = p['reason_code'];
  if (typeof reasonCode !== 'string' || reasonCode.trim() === '') {
    reject('INVALID_PAYLOAD', 'reason_code is required and must not be blank');
  }
  if (typeof reasonCode === 'string' && reasonCode.trim().length > MAX_REASON_CODE_LENGTH) {
    reject('INVALID_PAYLOAD', `reason_code must be at most ${MAX_REASON_CODE_LENGTH} characters`);
  }
  if (p['returned_by'] !== undefined && p['returned_by'] !== null && !isUuid(p['returned_by'])) {
    reject('INVALID_PAYLOAD', 'returned_by must be a UUID when present');
  }
  if (!isIsoTimestamp(p['returned_at'])) {
    reject('INVALID_PAYLOAD', 'returned_at must be an ISO 8601 timestamp with an explicit offset');
  }
  if (p['posting_id'] !== undefined && p['posting_id'] !== null && !isUuid(p['posting_id'])) {
    reject('INVALID_PAYLOAD', 'posting_id must be a UUID when present');
  }
}

// ---------------------------------------------------------------------------
// In-transaction appliers
// ---------------------------------------------------------------------------

async function alreadyPersisted(envelope: EventEnvelope, client: PoolClient): Promise<boolean> {
  if (!envelope.idempotency_key?.trim() && !envelope.event_id) return false;
  const existing = await client.query(
    `SELECT 1 FROM domain_events WHERE ($1::text IS NOT NULL AND idempotency_key = $1) OR event_id = $2 LIMIT 1`,
    [envelope.idempotency_key ?? null, envelope.event_id ?? null],
  );
  return existing.rows.length > 0;
}

/** Binding Decision 11: material flow runs only on released or in_process orders. */
async function lockOrderForMaterial(
  envelope: EventEnvelope,
  client: PoolClient,
): Promise<ProductionOrderRow> {
  const p = envelope.payload as Record<string, unknown>;
  const productionOrderId = p['production_order_id'] as string;
  const order = await getProductionOrderByIdForUpdate(productionOrderId, client);
  if (!order) {
    reject(
      'PRODUCTION_ORDER_NOT_FOUND',
      'The production order does not resolve',
      { production_order_id: productionOrderId },
      404,
    );
  }
  if (order.status !== 'released' && order.status !== 'in_process') {
    reject(
      'INVALID_STATE_TRANSITION',
      'Material flow requires the order to be released or in_process',
      { production_order_id: productionOrderId, status: order.status },
      400,
    );
  }
  return order;
}

/**
 * AD-12 seam re-enforcement of the route-level plant scoping (code-review finding 2026-08-28):
 * the actor location stamped on the envelope must be at or beneath the order's plant. The route
 * handlers stamp the assignment location for scoped users and NO_LOCATION_UUID for wildcard
 * assignments; the direct-event path (POST /api/v1/events) overwrites actor.location_id with the
 * caller's assignment location, so a plant-scoped role cannot stage/issue/confirm/return against
 * another plant's order by echoing its own permitted location - its assignment location is a
 * different tree and this walk rejects it. Wildcard callers (NO_LOCATION_UUID / '*' / absent)
 * are unrestricted exactly as the route-level wildcard is.
 */
export async function assertActorPlantAccess(
  envelope: EventEnvelope,
  order: ProductionOrderRow,
  client: PoolClient,
): Promise<void> {
  const actorLocation = envelope.metadata.actor.location_id;
  // Code review 2026-08-31: a NON-STRING actor location used to return early, which was an
  // unenumerated fourth bypass alongside the three deliberate ones below - a direct event that
  // simply omitted metadata.actor.location_id could act on any plant. It now fails closed.
  if (typeof actorLocation !== 'string') {
    reject(
      'LOCATION_ACCESS_DENIED',
      'The event carries no actor location, so plant access cannot be established',
      {
        production_order_id: order.production_order_id,
        plant_location_id: order.plant_location_id,
      },
      403,
    );
  }
  if (actorLocation === '' || actorLocation === '*' || actorLocation === NO_LOCATION_UUID) return;
  if (!(await isLocationDescendantOf(order.plant_location_id, actorLocation, client))) {
    reject(
      'LOCATION_ACCESS_DENIED',
      'The actor location is not within the order plant',
      {
        production_order_id: order.production_order_id,
        plant_location_id: order.plant_location_id,
        actor_location_id: actorLocation,
      },
      403,
    );
  }
}

/** The Counter Contract: the order lock is already held, so the recompute is race-free. */
async function recomputeUnreversedCounter(orderId: string, client: PoolClient): Promise<void> {
  const count = await getOpenPostingCount(orderId, client);
  await client.query(
    `UPDATE production_order
        SET unreversed_transaction_count = $2, updated_at = now()
      WHERE production_order_id = $1`,
    [orderId, count],
  );
}

async function numericEquals(client: PoolClient, left: unknown, right: unknown): Promise<boolean> {
  const result = await client.query('SELECT $1::numeric = $2::numeric AS eq', [left, right]);
  return result.rows[0]!['eq'] === true;
}

/**
 * Descendant walk: is `candidate` at or beneath `site`? Depth-capped (the getForwardPickBalance CTE
 * shape). Exported so the staging handler pre-runs the same check for a clean early error; the
 * seam re-runs it inside the persistEvent transaction (AD-12 - removing the handler check must
 * never change what is possible through the direct-event path).
 */
export async function isLocationDescendantOf(
  siteLocationId: string,
  candidateLocationId: string,
  client?: PoolClient,
): Promise<boolean> {
  const r = client ?? getPool();
  const result = await r.query(
    `WITH RECURSIVE descendants AS (
       SELECT location_id, 0 AS depth FROM location_register WHERE location_id = $1
       UNION ALL
       SELECT lr.location_id, d.depth + 1
         FROM location_register lr
         JOIN descendants d ON lr.parent_location_id = d.location_id
        WHERE d.depth < 10
     )
     SELECT 1 FROM descendants WHERE location_id = $2 LIMIT 1`,
    [siteLocationId, candidateLocationId],
  );
  return result.rows.length > 0;
}

function drainRowsToPostings(
  drained: StockDrainRow[],
  componentItemId: string,
  componentSku: string,
  bomLineId: string,
  unitCost: string,
): Array<Record<string, string | null>> {
  return drained.map((row) => ({
    posting_id: randomUUID(),
    bom_line_id: bomLineId,
    component_item_id: componentItemId,
    component_sku: componentSku,
    lot_number: row.lot_id,
    source_location_id: row.location_id,
    quantity: row.quantity,
    unit_cost: unitCost,
  }));
}

export async function applyProductionMaterialProjection(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
): Promise<void> {
  const type = productionMaterialEventType(envelope);
  if (!type) return;

  switch (type) {
    case 'production_order.material_staged':
      await applyMaterialStaged(envelope, client, eventId);
      break;
    case 'production_order.material_issued':
      await applyMaterialIssued(envelope, client, eventId);
      break;
    case 'production_order.confirmation_recorded':
      await applyConfirmationRecorded(envelope, client, eventId);
      break;
    case 'production_order.material_returned':
      await applyMaterialReturned(envelope, client, eventId);
      break;
  }
}

async function applyMaterialStaged(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
): Promise<void> {
  if (await alreadyPersisted(envelope, client)) return;

  const p = envelope.payload as Record<string, unknown>;
  const productionOrderId = p['production_order_id'] as string;
  const order = await lockOrderForMaterial(envelope, client);
  await assertActorPlantAccess(envelope, order, client);

  // Binding Decision 1: the requirement set is resolved at the ORDER quantity and filtered to
  // directed_issue lines. Resolved on server time, never the envelope's client-controlled
  // occurred_at (the 6.1 release-gate lesson): a backdated direct event must not select an older
  // effective BOM line set.
  const requirementSet = await resolveMaterialRequirements(
    {
      order,
      quantity: order.order_quantity,
      supplyMethodFilter: 'directed_issue',
      occurred_at: new Date().toISOString(),
    },
    client,
  );
  if (p['revision_id'] !== requirementSet.revision_id) {
    reject(
      'PRODUCTION_MATERIAL_DERIVATION_MISMATCH',
      'Declared revision_id does not match the staged requirement set revision',
      {
        production_order_id: productionOrderId,
        declared_revision_id: p['revision_id'],
        derived_revision_id: requirementSet.revision_id,
      },
      409,
    );
  }

  const requirementsByLine = new Map(requirementSet.lines.map((line) => [line.bom_line_id, line]));
  const seen = new Set<string>();
  const lines = p['lines'] as Array<Record<string, unknown>>;

  for (const line of lines) {
    const bomLineId = line['bom_line_id'] as string;
    if (seen.has(bomLineId)) {
      reject(
        'INVALID_PARAMS',
        'A staging event must not name the same bom_line_id more than once',
        { production_order_id: productionOrderId, bom_line_id: bomLineId },
        400,
      );
    }
    seen.add(bomLineId);

    const requirement = requirementsByLine.get(bomLineId);
    if (!requirement) {
      reject(
        'STAGING_LINE_NOT_DIRECTED_ISSUE',
        'The staged BOM line is not a directed-issue line of this order',
        {
          production_order_id: productionOrderId,
          bom_line_id: bomLineId,
        },
        409,
      );
    }
    // Re-derivation contract: the derived triple is declared and checked, never trusted.
    if (
      line['component_item_id'] !== requirement.component_item_id ||
      line['component_sku'] !== requirement.component_sku ||
      !(await numericEquals(client, line['required_quantity'], requirement.required_quantity))
    ) {
      reject(
        'PRODUCTION_MATERIAL_DERIVATION_MISMATCH',
        'A declared staging line disagrees with the requirement set',
        {
          production_order_id: productionOrderId,
          bom_line_id: bomLineId,
          declared_component_item_id: line['component_item_id'],
          derived_component_item_id: requirement.component_item_id,
          declared_component_sku: line['component_sku'],
          derived_component_sku: requirement.component_sku,
          declared_required_quantity: line['required_quantity'],
          derived_required_quantity: requirement.required_quantity,
        },
        409,
      );
    }

    const sourceLocationId = line['source_location_id'] as string;
    if (!(await isLocationDescendantOf(order.plant_location_id, sourceLocationId, client))) {
      reject(
        'STAGING_LOCATION_OUTSIDE_PLANT',
        'The staging source bin is not inside the order plant',
        {
          production_order_id: productionOrderId,
          bom_line_id: bomLineId,
          source_location_id: sourceLocationId,
          plant_location_id: order.plant_location_id,
        },
        409,
      );
    }

    // stage_id is server-minted write-back: a declared value is a fabrication attempt.
    if (
      line['stage_id'] !== undefined &&
      line['stage_id'] !== null &&
      (line['stage_id'] as string).trim() !== ''
    ) {
      reject(
        'PRODUCTION_MATERIAL_DERIVATION_MISMATCH',
        'stage_id is server-minted and cannot be declared',
        { production_order_id: productionOrderId, bom_line_id: bomLineId },
        409,
      );
    }

    const stageId = randomUUID();
    // Empty-string lot numbers are normalized to null (the code-review fix): a stored '' would
    // otherwise key the allocation lot filter as a real value ($3::text IS NULL OR lot_id = $3)
    // and match no balance row, surfacing a confusing INSUFFICIENT_STOCK. The normalized value is
    // written back so the persisted payload matches the stored grain.
    const declaredLot = line['lot_number'] as string | null;
    const lotNumber =
      typeof declaredLot === 'string' && declaredLot.trim() !== '' ? declaredLot : null;
    await insertProductionOrderStage(
      {
        stage_id: stageId,
        production_order_id: productionOrderId,
        bom_line_id: bomLineId,
        component_item_id: requirement.component_item_id,
        component_sku: requirement.component_sku,
        supply_method: 'directed_issue',
        required_quantity: requirement.required_quantity,
        issued_quantity: '0',
        status: 'allocated',
        source_location_id: sourceLocationId,
        lot_number: lotNumber,
        source_event_id: eventId,
        created_at: line['staged_at'] as string,
      },
      client,
    );

    // Binding Decision 4: staging allocates at the named source bin. A 409 INSUFFICIENT_STOCK from
    // the helper propagates UNCHANGED - never caught and re-wrapped; the Epic 2 detail payload is
    // the useful one (the 7.4 rule).
    // Story 8.1 (Task 6): a sub-assembly or finished-goods component lot is checked against the
    // QC gate before it is staged; a conditionally released lot may be issued to THIS production
    // order only when its deviation names the order. Lot lock, gate lock, then the ledger.
    if (lotNumber !== null) {
      await assertQcGateAllows({
        lot_number: lotNumber,
        sku: requirement.component_sku,
        operation: 'production_issue',
        scope_ref: productionOrderId,
        business_date: gateBusinessDateOf(envelope),
        client,
      });
    }
    await applyStockAllocation(
      {
        sku: requirement.component_sku,
        location_id: sourceLocationId,
        lot_id: lotNumber,
        quantity: requirement.required_quantity,
        qc_gate_cleared: lotNumber !== null,
      },
      client,
    );

    // Write-back (Compliance Seam Contract): the persisted payload carries the server-minted ids,
    // the actor stamp and the normalized lot so the direct-event and handler paths store
    // byte-identical rows.
    line['stage_id'] = stageId;
    line['staged_by'] = envelope.metadata.actor.user_id;
    line['lot_number'] = lotNumber;
  }

  // business_date is the IST calendar date of the event's primary instant (the first staged_at).
  const firstStagedAt = new Date(lines[0]!['staged_at'] as string);
  p['business_date'] = toIstCalendarDate(firstStagedAt);

  // The Counter Contract: recomputed under the held order lock (staging adds no WIP postings, so
  // this is a no-op today - it keeps every material applier on the same counter path).
  await recomputeUnreversedCounter(productionOrderId, client);
}

async function applyMaterialIssued(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
): Promise<void> {
  if (await alreadyPersisted(envelope, client)) return;

  const p = envelope.payload as Record<string, unknown>;
  const productionOrderId = p['production_order_id'] as string;
  const order = await lockOrderForMaterial(envelope, client);
  await assertActorPlantAccess(envelope, order, client);

  // postings are server-minted write-back: a declared set is a fabrication attempt.
  if (Array.isArray(p['postings']) && p['postings'].length > 0) {
    reject(
      'PRODUCTION_MATERIAL_DERIVATION_MISMATCH',
      'postings are server-derived from the drain and cannot be declared',
      { production_order_id: productionOrderId },
      409,
    );
  }

  const stage = await getStageByIdForUpdate(p['stage_id'] as string, client);
  if (!stage) {
    reject(
      'STAGE_NOT_FOUND',
      'The stage row does not resolve',
      {
        production_order_id: productionOrderId,
        stage_id: p['stage_id'],
      },
      404,
    );
  }
  if (stage.production_order_id !== productionOrderId) {
    reject(
      'INVALID_PARAMS',
      'The stage row does not belong to this production order',
      {
        production_order_id: productionOrderId,
        stage_id: stage.stage_id,
        stage_order_id: stage.production_order_id,
      },
      400,
    );
  }
  // Full issues only transition; a fully-issued stage rejects further issues.
  if (stage.status !== 'allocated') {
    reject(
      'STAGE_ALREADY_ISSUED',
      'The stage row is already fully issued',
      { production_order_id: productionOrderId, stage_id: stage.stage_id, status: stage.status },
      409,
    );
  }

  // Remaining = required_quantity - issued_quantity settled in SQL NUMERIC; the requested quantity
  // above that rejects ISSUE_EXCEEDS_STAGED (rejected, never clamped).
  const quantity = p['quantity'] as string;
  const remainingResult = await client.query(
    `SELECT (required_quantity - issued_quantity)::text AS remaining,
            ($2::numeric > (required_quantity - issued_quantity)) AS exceeds
       FROM production_order_stage WHERE stage_id = $1`,
    [stage.stage_id, quantity],
  );
  if (remainingResult.rows[0]!['exceeds'] === true) {
    reject(
      'ISSUE_EXCEEDS_STAGED',
      'The requested issue quantity exceeds the remaining staged quantity',
      {
        production_order_id: productionOrderId,
        stage_id: stage.stage_id,
        requested_quantity: quantity,
        remaining_quantity: String(remainingResult.rows[0]!['remaining']),
      },
      409,
    );
  }

  // Binding Decision 8: unit_cost is server-derived from the Story 2.4 running average (an
  // unlocked advisory read inside the transaction - the valuation row is never locked). Fail
  // closed: no valuation row or NULL running_average_cost rejects WIP_COST_UNRESOLVED.
  const valuation = await getInventoryValuation(stage.component_sku, client);
  const unitCost = valuation?.running_average_cost ?? null;
  if (unitCost === null) {
    reject(
      'WIP_COST_UNRESOLVED',
      'No priced valuation basis exists for the issued component',
      {
        production_order_id: productionOrderId,
        stage_id: stage.stage_id,
        component_sku: stage.component_sku,
      },
      409,
    );
  }

  // Binding Decision 5: DEALLOCATE FIRST, THEN ISSUE - applyStockIssue gates on SUM(available),
  // which is net of the staging allocation, so issuing before deallocating would fail with a
  // spurious INSUFFICIENT_STOCK whenever the staged quantity is the only free stock.
  // Story 8.1 (Task 6): the QC gate is re-run at issue time against this production order.
  if (stage.lot_number !== null) {
    await assertQcGateAllows({
      lot_number: stage.lot_number,
      sku: stage.component_sku,
      operation: 'production_issue',
      scope_ref: productionOrderId,
      business_date: gateBusinessDateOf(envelope),
      client,
    });
  }
  const ledgerInput = {
    sku: stage.component_sku,
    location_id: stage.source_location_id,
    lot_id: stage.lot_number,
    quantity,
  };
  await applyStockDeallocation(ledgerInput, client);
  const drained = await applyStockIssue(
    {
      ...ledgerInput,
      occurred_at: p['issued_at'] as string,
      qc_gate_cleared: stage.lot_number !== null,
    },
    client,
  );

  // One WIP posting per drained balance row (Binding Decision 7); posting_value is computed in SQL
  // NUMERIC by insertWipPosting.
  const postings = drainRowsToPostings(
    drained,
    stage.component_item_id,
    stage.component_sku,
    stage.bom_line_id,
    unitCost,
  );
  for (const posting of postings) {
    const postingValue = await insertWipPosting(
      {
        posting_id: posting['posting_id'] as string,
        production_order_id: productionOrderId,
        posting_type: 'directed_issue',
        bom_line_id: posting['bom_line_id'] as string,
        component_item_id: posting['component_item_id'] as string,
        component_sku: posting['component_sku'] as string,
        lot_number: posting['lot_number'] as string | null,
        source_location_id: posting['source_location_id'] as string,
        quantity: posting['quantity'] as string,
        open_quantity: posting['quantity'] as string,
        unit_cost: posting['unit_cost'] as string,
        reason_code: null,
        source_posting_id: null,
        source_event_id: eventId,
        occurred_at: p['issued_at'] as string,
      },
      client,
    );
    posting['posting_value'] = postingValue;
  }

  await applyStageIssuedQuantity(stage.stage_id, quantity, client);
  await recomputeUnreversedCounter(productionOrderId, client);

  // Write-back: the persisted payload carries the server-computed postings and the actor stamp.
  p['postings'] = postings;
  p['issued_by'] = envelope.metadata.actor.user_id;
}

async function applyConfirmationRecorded(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
): Promise<void> {
  if (await alreadyPersisted(envelope, client)) return;

  const p = envelope.payload as Record<string, unknown>;
  const productionOrderId = p['production_order_id'] as string;
  const order = await lockOrderForMaterial(envelope, client);
  await assertActorPlantAccess(envelope, order, client);

  // backflush_lines are server-derived write-back: a declared set is a fabrication attempt.
  if (Array.isArray(p['backflush_lines']) && p['backflush_lines'].length > 0) {
    reject(
      'PRODUCTION_MATERIAL_DERIVATION_MISMATCH',
      'backflush_lines are server-derived from the drain and cannot be declared',
      { production_order_id: productionOrderId },
      409,
    );
  }

  // Binding Decision 1: backflush explodes at the CONFIRMED quantity (proportionality by
  // construction - AC2), filtered to backflush lines, on server time.
  const requirementSet = await resolveMaterialRequirements(
    {
      order,
      quantity: p['confirmed_quantity'] as string,
      supplyMethodFilter: 'backflush',
      occurred_at: new Date().toISOString(),
    },
    client,
  );
  if (p['revision_id'] !== requirementSet.revision_id) {
    reject(
      'PRODUCTION_MATERIAL_DERIVATION_MISMATCH',
      'Declared revision_id does not match the confirmed requirement set revision',
      {
        production_order_id: productionOrderId,
        declared_revision_id: p['revision_id'],
        derived_revision_id: requirementSet.revision_id,
      },
      409,
    );
  }
  if (requirementSet.lines.length === 0) {
    reject(
      'NO_BACKFLUSH_LINES',
      'The order has no backflush requirements to confirm against',
      { production_order_id: productionOrderId },
      409,
    );
  }

  // AC3 pre-check pass: one availability probe per COMPONENT SKU, with the SKU's requirement lines
  // summed in SQL NUMERIC, and EVERY deficient line reported in details.shortfall_lines (AC3's
  // plural contract), never just the first. The SKU-level aggregation is the code-review fix: two
  // backflush lines sharing one component could each pass a per-line probe against the same
  // plant-wide `available` and then fail the second drain mid-way with a single-line detail - the
  // aggregated probe rejects the whole confirmation with the full shortfall list instead.
  const skuGroups = new Map<string, string[]>();
  for (const line of requirementSet.lines) {
    const list = skuGroups.get(line.component_sku) ?? [];
    list.push(line.required_quantity);
    skuGroups.set(line.component_sku, list);
  }
  const shortfallLines: Array<Record<string, string>> = [];
  for (const [sku, quantities] of skuGroups) {
    const totalResult = await client.query(
      `SELECT SUM(v::numeric)::text AS total FROM unnest($1::text[]) AS v`,
      [quantities],
    );
    const probe = await getBackflushShortfall(
      sku,
      order.plant_location_id,
      String(totalResult.rows[0]!['total']),
      client,
    );
    if (!probe.satisfied) {
      for (const line of requirementSet.lines) {
        if (line.component_sku !== sku) continue;
        shortfallLines.push({
          component_sku: line.component_sku,
          bom_line_id: line.bom_line_id,
          required_quantity: line.required_quantity,
          available_quantity: probe.available_quantity,
          shortfall_quantity: probe.shortfall_quantity,
        });
      }
    }
  }
  if (shortfallLines.length > 0) {
    reject(
      'INSUFFICIENT_STOCK',
      'Backflush components have insufficient stock to cover the confirmed quantity',
      {
        production_order_id: productionOrderId,
        shortfall_lines: shortfallLines,
      },
      409,
    );
  }

  // Drain pass: applyStockIssueUnderSite per line (owned class default); the drain detail becomes
  // WIP postings exactly like the issue applier. All-or-nothing holds by construction: the
  // pre-check passed for every line and this applier runs inside the persistEvent transaction.
  const backflushLines: Array<Record<string, unknown>> = [];
  for (const line of requirementSet.lines) {
    // Binding Decision 8 resolved BEFORE the drain (the code-review fix mirroring the issue
    // applier): an unresolved valuation rejects WIP_COST_UNRESOLVED before any stock moves.
    const unitCostResult = await getInventoryValuation(line.component_sku, client);
    const unitCost = unitCostResult?.running_average_cost ?? null;
    if (unitCost === null) {
      reject(
        'WIP_COST_UNRESOLVED',
        'No priced valuation basis exists for the backflushed component',
        {
          production_order_id: productionOrderId,
          component_sku: line.component_sku,
        },
        409,
      );
    }
    const drained = await applyStockIssueUnderSite(
      {
        sku: line.component_sku,
        site_location_id: order.plant_location_id,
        quantity: line.required_quantity,
        occurred_at: p['confirmed_at'] as string,
      },
      client,
    );
    const postings = drainRowsToPostings(
      drained,
      line.component_item_id,
      line.component_sku,
      line.bom_line_id,
      unitCost,
    );
    for (const posting of postings) {
      const postingValue = await insertWipPosting(
        {
          posting_id: posting['posting_id'] as string,
          production_order_id: productionOrderId,
          posting_type: 'backflush',
          bom_line_id: posting['bom_line_id'] as string,
          component_item_id: posting['component_item_id'] as string,
          component_sku: posting['component_sku'] as string,
          lot_number: posting['lot_number'] as string | null,
          source_location_id: posting['source_location_id'] as string,
          quantity: posting['quantity'] as string,
          open_quantity: posting['quantity'] as string,
          unit_cost: posting['unit_cost'] as string,
          reason_code: null,
          source_posting_id: null,
          source_event_id: eventId,
          occurred_at: p['confirmed_at'] as string,
        },
        client,
      );
      posting['posting_value'] = postingValue;
    }
    backflushLines.push({
      bom_line_id: line.bom_line_id,
      component_sku: line.component_sku,
      required_quantity: line.required_quantity,
      postings,
    });
  }

  await recomputeUnreversedCounter(productionOrderId, client);

  // Write-back: server-computed backflush lines, business_date, actor stamp.
  p['backflush_lines'] = backflushLines;
  p['business_date'] = toIstCalendarDate(new Date(p['confirmed_at'] as string));
  p['confirmed_by'] = envelope.metadata.actor.user_id;
}

async function applyMaterialReturned(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
): Promise<void> {
  if (await alreadyPersisted(envelope, client)) return;

  const p = envelope.payload as Record<string, unknown>;
  const productionOrderId = p['production_order_id'] as string;
  const order = await lockOrderForMaterial(envelope, client);
  await assertActorPlantAccess(envelope, order, client);

  // posting_id is server-minted write-back: a declared value is a fabrication attempt.
  if (
    p['posting_id'] !== undefined &&
    p['posting_id'] !== null &&
    (p['posting_id'] as string).trim() !== ''
  ) {
    reject(
      'PRODUCTION_MATERIAL_DERIVATION_MISMATCH',
      'posting_id is server-minted and cannot be declared',
      { production_order_id: productionOrderId },
      409,
    );
  }

  // Binding Decision 12: returns reference postings, not lines. The source posting is locked FOR
  // UPDATE (404 POSTING_NOT_FOUND) and must be an issue/backflush posting of THIS order.
  const posting = await getPostingByIdForUpdate(p['source_posting_id'] as string, client);
  if (!posting) {
    reject(
      'POSTING_NOT_FOUND',
      'The source posting does not resolve',
      {
        production_order_id: productionOrderId,
        source_posting_id: p['source_posting_id'],
      },
      404,
    );
  }
  if (
    posting.production_order_id !== productionOrderId ||
    (posting.posting_type !== 'directed_issue' && posting.posting_type !== 'backflush')
  ) {
    reject(
      'RETURN_SOURCE_MISMATCH',
      'The source posting is not an issue/backflush posting of this order',
      {
        production_order_id: productionOrderId,
        source_posting_id: posting.posting_id,
        source_posting_type: posting.posting_type,
        source_posting_order_id: posting.production_order_id,
      },
      409,
    );
  }

  // AC5: a return without a mandatory reason code is rejected.
  const reasonCode = (p['reason_code'] as string).trim();
  if (reasonCode === '') {
    reject(
      'REASON_CODE_REQUIRED',
      'A material return requires a non-blank reason_code',
      { production_order_id: productionOrderId, source_posting_id: posting.posting_id },
      400,
    );
  }
  // Task 8.2: a non-blank code outside the configured list rejects 422 with the allowed list.
  const allowedReasonCodes = config.production.materialReturnReasonCodes;
  if (!allowedReasonCodes.includes(reasonCode)) {
    reject(
      'RETURN_REASON_CODE_INVALID',
      'The reason code is not a configured material return reason',
      {
        production_order_id: productionOrderId,
        source_posting_id: posting.posting_id,
        reason_code: reasonCode,
        allowed: allowedReasonCodes,
      },
      422,
    );
  }

  // AC6: the over-return probe settles quantity > open_quantity in SQL NUMERIC (open_quantity is
  // already net of prior returns, which decrement it). Rejected, NEVER clamped (the 7.4 rationale:
  // a silently truncated return over-states the ledger).
  const quantity = p['quantity'] as string;
  if (await getReturnExceeds(posting.posting_id, quantity, client)) {
    reject(
      'RETURN_EXCEEDS_ISSUE',
      'The return would exceed the quantity issued to the order',
      {
        production_order_id: productionOrderId,
        source_posting_id: posting.posting_id,
        requested_return: quantity,
        open_quantity: posting.open_quantity,
      },
      409,
    );
  }

  // AC5 mechanically: restore the ORIGINAL location AND lot grain - the source posting's
  // source_location_id and lot_number are exactly what the drain took.
  await applyStockReceipt(
    {
      sku: posting.component_sku,
      location_id: posting.source_location_id,
      lot_id: posting.lot_number,
      quantity,
    },
    client,
  );

  // Insert the return posting (open_quantity NULL, source_posting_id + reason_code set) and
  // decrement the source posting's open_quantity in the same transaction. unit_cost is the source
  // posting's unit_cost - the issued cost (AC5), never today's average. posting_value is computed
  // in SQL NUMERIC by insertWipPosting.
  const postingId = randomUUID();
  await insertWipPosting(
    {
      posting_id: postingId,
      production_order_id: productionOrderId,
      posting_type: 'return',
      bom_line_id: posting.bom_line_id,
      component_item_id: posting.component_item_id,
      component_sku: posting.component_sku,
      lot_number: posting.lot_number,
      source_location_id: posting.source_location_id,
      quantity,
      open_quantity: null,
      unit_cost: posting.unit_cost,
      reason_code: reasonCode,
      source_posting_id: posting.posting_id,
      source_event_id: eventId,
      occurred_at: p['returned_at'] as string,
    },
    client,
  );
  await client.query(
    `UPDATE production_wip_ledger
        SET open_quantity = open_quantity - $2::numeric
      WHERE posting_id = $1`,
    [posting.posting_id, quantity],
  );

  await recomputeUnreversedCounter(productionOrderId, client);

  // Write-back: the server-minted posting id and the actor stamp.
  p['posting_id'] = postingId;
  p['returned_by'] = envelope.metadata.actor.user_id;
}
