import type { PoolClient } from 'pg';
import type { EventEnvelope } from '../events/store.js';
import { AppError } from '../middleware/error.js';
import { assertNotRdDraft } from './bom.js';
import { insertCostRollup, insertCostRollupLine } from '../read/projections/bom_cost_rollup.js';
import { raiseException } from '../read/projections/integration_exception.js';
import type {
  BomCostRollupSnapshottedPayload,
  BomJobWorkKitTaggedPayload,
  BomSyncConflictRaisedPayload,
} from '../events/schema.js';

/**
 * Story 5.6 compliance seam for the cost-rollup, kit-tagging and inbound-sync-conflict events
 * (FR-B-15, FR-B-16, FR-B-17). Structurally mirrors bom-execution.ts: a synchronous shape assert
 * that runs BEFORE the persist transaction (so a malformed event never consumes an idempotency
 * key) and an async applier that runs INSIDE it.
 *
 * Every state and vocabulary gate lives here rather than in the HTTP handlers, so a direct
 * POST /api/v1/events cannot bypass them.
 */

const ENGINEERING_STREAM_TYPES = new Set(['engineering']);
const BOM_COSTING_EVENT_TYPES = new Set([
  'bom.cost_rollup_snapshotted',
  'bom.job_work_kit_tagged',
  'bom.sync_conflict_raised',
]);

export const SUPPLY_SOURCES = new Set(['company', 'customer', 'job_worker']);

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_REGEX = /^(\d{4})-(\d{2})-(\d{2})$/;
// Shape-gate decimal strings only: hex and scientific notation pass Number() and then die inside
// PostgreSQL as a raw 500. Each regex is bounded to its receiving column's precision so
// PostgreSQL never silently rounds or overflows. Costs and quantities are unbounded NUMERIC
// columns, so the bound here is a sanity ceiling rather than a column ceiling.
const COST_REGEX = /^\d{1,100}(\.\d{1,100})?$/;
const QTY_REGEX = /^\d{1,100}(\.\d{1,100})?$/;
const UNIT_COST_REGEX = /^\d{1,12}(\.\d{1,6})?$/;
const SCRAP_REGEX = /^\d{1,3}(\.\d{1,6})?$/;

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

export function bomCostingEventType(envelope: EventEnvelope): string | null {
  if (!ENGINEERING_STREAM_TYPES.has(envelope.stream_type)) return null;
  if (!BOM_COSTING_EVENT_TYPES.has(envelope.event_type)) return null;
  return envelope.event_type;
}

export function assertBomCostingShape(envelope: EventEnvelope): void {
  const type = bomCostingEventType(envelope);
  if (!type) return;
  const p = envelope.payload as Record<string, unknown>;

  switch (type) {
    case 'bom.cost_rollup_snapshotted':
      assertCostRollupShape(p);
      break;
    case 'bom.job_work_kit_tagged':
      assertJobWorkKitTaggedShape(p);
      break;
    case 'bom.sync_conflict_raised':
      assertSyncConflictShape(p);
      break;
  }
}

function assertCostRollupShape(p: Record<string, unknown>): void {
  if (!isUuid(p['rollup_id'])) reject('INVALID_PARAMS', 'rollup_id is required and must be a UUID');
  if (!isUuid(p['bom_id'])) reject('INVALID_PARAMS', 'bom_id is required and must be a UUID');
  if (!isUuid(p['revision_id']))
    reject('INVALID_PARAMS', 'revision_id is required and must be a UUID');
  if (!isDateString(p['rollup_date']))
    reject('INVALID_PARAMS', 'rollup_date is required and must be a YYYY-MM-DD date');
  if (p['rate_basis'] !== 'item_master_standard_cost')
    reject('INVALID_PARAMS', "rate_basis must be 'item_master_standard_cost'");

  const total = p['total_cost'];
  if (typeof total !== 'string' || !COST_REGEX.test(total))
    reject('INVALID_PARAMS', 'total_cost must be a non-negative decimal string');

  const lineCount = p['line_count'];
  if (typeof lineCount !== 'number' || !Number.isInteger(lineCount) || lineCount < 0)
    reject('INVALID_PARAMS', 'line_count must be a non-negative integer');
  const missing = p['missing_rate_count'];
  if (typeof missing !== 'number' || !Number.isInteger(missing) || missing < 0)
    reject('INVALID_PARAMS', 'missing_rate_count must be a non-negative integer');
  if (missing > lineCount) reject('INVALID_PARAMS', 'missing_rate_count may not exceed line_count');
  if (typeof p['depth_truncated'] !== 'boolean')
    reject('INVALID_PARAMS', 'depth_truncated must be a boolean');
  if (
    p['correlation_id'] !== null &&
    p['correlation_id'] !== undefined &&
    !isUuid(p['correlation_id'])
  )
    reject('INVALID_PARAMS', 'correlation_id must be a UUID or null');

  const lines = p['lines'];
  if (!Array.isArray(lines))
    reject('INVALID_PARAMS', 'lines must be an array of costed rollup rows');
  if (lines.length !== lineCount)
    reject('INVALID_PARAMS', 'line_count must equal the length of the lines array');
  for (const raw of lines as unknown[]) {
    if (typeof raw !== 'object' || raw === null)
      reject('INVALID_PARAMS', 'each rollup line must be an object');
    assertCostRollupLineShape(raw as Record<string, unknown>);
  }
}

function assertCostRollupLineShape(l: Record<string, unknown>): void {
  // rollup_line_id is capture-minted and travels in the payload (replay determinism).
  if (!isUuid(l['rollup_line_id']))
    reject('INVALID_PARAMS', 'rollup line rollup_line_id must be a UUID');
  const depth = l['depth'];
  if (typeof depth !== 'number' || !Number.isInteger(depth) || depth < 0)
    reject('INVALID_PARAMS', 'rollup line depth must be an integer greater than or equal to 0');
  if (!isNonEmptyString(l['path'])) reject('INVALID_PARAMS', 'rollup line path is required');
  if (!isUuid(l['source_bom_id']))
    reject('INVALID_PARAMS', 'rollup line source_bom_id must be a UUID');
  if (!isUuid(l['source_revision_id']))
    reject('INVALID_PARAMS', 'rollup line source_revision_id must be a UUID');
  if (!isUuid(l['bom_line_id'])) reject('INVALID_PARAMS', 'rollup line bom_line_id must be a UUID');

  const lineNo = l['line_no'];
  if (typeof lineNo !== 'number' || !Number.isInteger(lineNo) || lineNo <= 0)
    reject('INVALID_PARAMS', 'rollup line line_no must be a positive integer');

  // component_item_id / component_sku are nullable (Story 5.4 placeholder columns); a placeholder
  // is never costed, so it never reaches here, but the shape stays NULL-safe.
  if (
    l['component_item_id'] !== null &&
    l['component_item_id'] !== undefined &&
    !isUuid(l['component_item_id'])
  )
    reject('INVALID_PARAMS', 'rollup line component_item_id must be a UUID or null');

  const qty = l['effective_quantity_per'];
  if (typeof qty !== 'string' || !QTY_REGEX.test(qty) || Number(qty) <= 0)
    reject(
      'INVALID_PARAMS',
      'rollup line effective_quantity_per must be a positive decimal string',
    );

  const scrap = l['scrap_percent'];
  if (
    scrap !== null &&
    scrap !== undefined &&
    (typeof scrap !== 'string' || !SCRAP_REGEX.test(scrap))
  )
    reject('INVALID_PARAMS', 'rollup line scrap_percent must be a decimal string or null');

  const unitCost = l['unit_cost'];
  if (
    unitCost !== null &&
    unitCost !== undefined &&
    (typeof unitCost !== 'string' || !UNIT_COST_REGEX.test(unitCost))
  )
    reject('INVALID_PARAMS', 'rollup line unit_cost must be a decimal string or null');

  const extended = l['extended_cost'];
  if (typeof extended !== 'string' || !COST_REGEX.test(extended))
    reject('INVALID_PARAMS', 'rollup line extended_cost must be a non-negative decimal string');

  for (const flag of ['rate_missing', 'via_phantom', 'has_child_bom']) {
    if (typeof l[flag] !== 'boolean')
      reject('INVALID_PARAMS', `rollup line ${flag} must be a boolean`);
  }
}

function assertJobWorkKitTaggedShape(p: Record<string, unknown>): void {
  if (!isUuid(p['bom_id'])) reject('INVALID_PARAMS', 'bom_id is required and must be a UUID');
  if (!isUuid(p['revision_id']))
    reject('INVALID_PARAMS', 'revision_id is required and must be a UUID');

  const tags = p['tags'];
  if (!Array.isArray(tags) || tags.length === 0)
    reject('INVALID_PARAMS', 'tags is required and must be a non-empty array');

  const seen = new Set<string>();
  for (const raw of tags as unknown[]) {
    if (typeof raw !== 'object' || raw === null)
      reject('INVALID_PARAMS', 'each tag must be an object');
    const tag = raw as Record<string, unknown>;
    if (!isUuid(tag['bom_line_id'])) reject('INVALID_PARAMS', 'tag bom_line_id must be a UUID');
    if (seen.has(tag['bom_line_id'] as string))
      reject('INVALID_PARAMS', 'Duplicate bom_line_id in tags');
    seen.add(tag['bom_line_id'] as string);
    const lineNo = tag['line_no'];
    if (typeof lineNo !== 'number' || !Number.isInteger(lineNo) || lineNo <= 0)
      reject('INVALID_PARAMS', 'tag line_no must be a positive integer');
    if (typeof tag['supply_source'] !== 'string' || !SUPPLY_SOURCES.has(tag['supply_source']))
      reject(
        'INVALID_PARAMS',
        "tag supply_source must be one of 'company', 'customer', 'job_worker'",
      );
  }
}

function assertSyncConflictShape(p: Record<string, unknown>): void {
  // bom_id is nullable: an inbound record may name a BOM this platform has never heard of.
  if (p['bom_id'] !== null && p['bom_id'] !== undefined && !isUuid(p['bom_id']))
    reject('INVALID_PARAMS', 'bom_id must be a UUID or null');
  if (!isNonEmptyString(p['source_record_ref']))
    reject('INVALID_PARAMS', 'source_record_ref is required and must be a non-empty string');
  if (!isNonEmptyString(p['conflict_reason']))
    reject('INVALID_PARAMS', 'conflict_reason is required and must be a non-empty string');
  // The exception row is raised by the adapter and its id is read back, never minted here.
  if (!isUuid(p['exception_id']))
    reject('INVALID_PARAMS', 'exception_id is required and must be a UUID');
  if (p['source_snapshot'] === undefined) reject('INVALID_PARAMS', 'source_snapshot is required');
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

export async function applyBomCostingProjection(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
): Promise<void> {
  const type = bomCostingEventType(envelope);
  if (!type) return;

  switch (type) {
    case 'bom.cost_rollup_snapshotted':
      await applyBomCostRollupSnapshotted(envelope, client, eventId);
      break;
    case 'bom.job_work_kit_tagged':
      await applyBomJobWorkKitTagged(envelope, client);
      break;
    case 'bom.sync_conflict_raised':
      await applyBomSyncConflictRaised(envelope, client);
      break;
  }
}

/**
 * Persists a rollup run EXACTLY as captured. The rollup math ran at capture time in
 * src/engineering/bom-cost-rollup.ts and travels inside the payload, so replay is
 * byte-deterministic and this applier recomputes NOTHING.
 *
 * Prior snapshots are never updated or deleted (AC 1) - a rollup is append-only history.
 */
async function applyBomCostRollupSnapshotted(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
): Promise<void> {
  if (await alreadyPersisted(envelope, client)) return;

  const p = envelope.payload as unknown as BomCostRollupSnapshottedPayload;

  const bomRow = await client.query('SELECT * FROM bom WHERE bom_id = $1 FOR UPDATE', [p.bom_id]);
  if (bomRow.rows.length === 0) reject('BOM_NOT_FOUND', 'BOM not found', { bom_id: p.bom_id }, 404);
  // Post-lock re-check: a concurrent same-key retry may have committed while we waited.
  if (await alreadyPersisted(envelope, client)) return;

  const bom = bomRow.rows[0]!;
  // A rollup is a release-gate input, and an R&D draft can never be released.
  assertNotRdDraft(bom);
  // Stale guard: the BOM may have been revised between the capture-time walk and this commit.
  if (bom.current_revision_id !== p.revision_id) {
    reject(
      'INVALID_PARAMS',
      'revision_id is no longer the current revision of the BOM',
      {
        bom_id: p.bom_id,
        revision_id: p.revision_id,
        current_revision_id: bom.current_revision_id,
      },
      409,
    );
  }

  const lines = p.lines;
  if (lines.length !== p.line_count) {
    reject(
      'INVALID_PARAMS',
      'line_count does not match the captured line array',
      { rollup_id: p.rollup_id, line_count: p.line_count, lines: lines.length },
      409,
    );
  }

  await insertCostRollup(
    {
      rollup_id: p.rollup_id,
      bom_id: p.bom_id,
      revision_id: p.revision_id,
      rollup_date: p.rollup_date,
      rate_basis: p.rate_basis,
      total_cost: p.total_cost,
      line_count: p.line_count,
      missing_rate_count: p.missing_rate_count,
      depth_truncated: p.depth_truncated,
      rolled_up_by: envelope.metadata.actor.user_id,
      correlation_id: p.correlation_id ?? null,
      source_event_id: eventId,
    },
    client,
  );

  for (const line of lines) {
    await insertCostRollupLine(
      {
        // The line id was minted at CAPTURE time and embedded in the payload, so a projection
        // rebuild replays the same rows (capture-time-minted-IDs replay rule).
        rollup_line_id: line.rollup_line_id,
        rollup_id: p.rollup_id,
        depth: line.depth,
        path: line.path,
        source_bom_id: line.source_bom_id,
        source_revision_id: line.source_revision_id,
        bom_line_id: line.bom_line_id,
        line_no: line.line_no,
        component_item_id: line.component_item_id ?? null,
        component_sku: line.component_sku ?? null,
        effective_quantity_per: line.effective_quantity_per,
        scrap_percent: line.scrap_percent ?? null,
        unit_cost: line.unit_cost ?? null,
        extended_cost: line.extended_cost,
        rate_missing: line.rate_missing,
        via_phantom: line.via_phantom,
        has_child_bom: line.has_child_bom,
        source_event_id: eventId,
      },
      client,
    );
  }

  const persistedCount = await client.query(
    'SELECT COUNT(*)::int AS cnt FROM bom_cost_rollup_line WHERE rollup_id = $1',
    [p.rollup_id],
  );
  if (Number(persistedCount.rows[0]!.cnt) !== p.line_count) {
    reject(
      'INVALID_PARAMS',
      'Persisted rollup line rows do not match the captured line count',
      { rollup_id: p.rollup_id, line_count: p.line_count },
      409,
    );
  }
}

/**
 * Tags kit BOM lines by supply source (FR-B-16, AC 4). Tagging is line authoring, so it obeys the
 * Story 5.2 immutability rule: a Released revision's lines can only change through an ECO.
 */
async function applyBomJobWorkKitTagged(
  envelope: EventEnvelope,
  client: PoolClient,
): Promise<void> {
  if (await alreadyPersisted(envelope, client)) return;

  const p = envelope.payload as unknown as BomJobWorkKitTaggedPayload;

  const bomRow = await client.query('SELECT * FROM bom WHERE bom_id = $1 FOR UPDATE', [p.bom_id]);
  if (bomRow.rows.length === 0) reject('BOM_NOT_FOUND', 'BOM not found', { bom_id: p.bom_id }, 404);
  if (await alreadyPersisted(envelope, client)) return;

  const bom = bomRow.rows[0]!;
  assertNotRdDraft(bom);
  if (bom.bom_type !== 'job_work_kit') {
    reject(
      'BOM_NOT_JOB_WORK_KIT',
      'Supply-source tagging applies only to job-work kit BOMs',
      { bom_id: p.bom_id, bom_type: bom.bom_type },
      409,
    );
  }
  const status = bom.status as string;
  if (status !== 'draft' && status !== 'on_hold') {
    reject(
      'IMMUTABLE_REVISION',
      'Released revisions are immutable - re-tagging requires an ECO',
      { bom_id: p.bom_id, status, allowed_from: ['draft', 'on_hold'] },
      409,
    );
  }
  if (bom.current_revision_id !== p.revision_id) {
    reject(
      'INVALID_PARAMS',
      'revision_id is no longer the current revision of the BOM',
      {
        bom_id: p.bom_id,
        revision_id: p.revision_id,
        current_revision_id: bom.current_revision_id,
      },
      409,
    );
  }

  for (const tag of p.tags) {
    // Story 5.3 cross-revision scoping rule: a line lookup is ALWAYS scoped by revision_id. Supply
    // source is a material-ownership tag (FR-B-16), so it applies to component lines only - a
    // co_product/by_product line has no owned material to source.
    const updated = await client.query(
      "UPDATE bom_line SET supply_source = $1, updated_at = now() WHERE bom_line_id = $2 AND revision_id = $3 AND output_class = 'component'",
      [tag.supply_source, tag.bom_line_id, p.revision_id],
    );
    if ((updated.rowCount ?? 0) !== 1) {
      reject(
        'BOM_LINE_NOT_FOUND',
        'BOM line not found on this revision',
        { bom_line_id: tag.bom_line_id, revision_id: p.revision_id },
        404,
      );
    }
  }
}

/**
 * Records that an inbound ERP BOM record was rejected (AC 5). This applier is a CONVERGENCE step,
 * not the source of truth: the queue row is raised by src/adapters/erp/sync.ts before this event
 * exists and never depends on the event being persisted or replayed. raiseException's
 * ON CONFLICT contract refreshes the single open row rather than stacking duplicates, which makes
 * this call safe on the normal path and correct on replay.
 *
 * It MUST NOT touch bom, bom_revision or bom_line in any way - that is the whole point of AC 5.
 */
async function applyBomSyncConflictRaised(
  envelope: EventEnvelope,
  client: PoolClient,
): Promise<void> {
  if (await alreadyPersisted(envelope, client)) return;

  const p = envelope.payload as unknown as BomSyncConflictRaisedPayload;

  await raiseException(
    {
      record_type: 'bom',
      source_system: 'ERP',
      error_code: 'BOM_INBOUND_SYNC_REJECTED',
      source_record_ref: p.source_record_ref,
      reason: p.conflict_reason,
      details: { source_snapshot: p.source_snapshot, bom_id: p.bom_id ?? null },
    },
    client,
  );
}
