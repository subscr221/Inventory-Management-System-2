import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { EventEnvelope } from '../events/store.js';
import { AppError } from '../middleware/error.js';
import {
  insertBom,
  insertBomRevision,
  insertBomLine,
  getBomLines,
} from '../read/projections/bom.js';
import type { BomLineRow } from '../read/projections/bom.js';
import {
  insertBuildRecord,
  insertAsBuiltLine,
  updateAsBuiltDeviation,
  confirmBuildRecord,
  getAsBuiltLines,
  type RdAsBuiltLineRow,
} from '../read/projections/rd_build.js';
import {
  upsertSignoff,
  evaluateProductizationGate,
  RD_GATE_FUNCTIONS,
} from '../read/projections/rd_productization.js';
import type {
  RdDraftClonedPayload,
  RdBuildRecordedPayload,
  RdBuildConfirmedPayload,
  RdProductizationSignedPayload,
  RdProductizedPayload,
} from '../events/schema.js';

/**
 * Story 5.4: R&D draft BOM regime (FR-B-09 to FR-B-11). Mirrors src/compliance/eco.ts structure
 * exactly (which itself clones src/compliance/bom.ts): shape asserts run PRE-transaction in
 * store.ts so a malformed event never consumes an idempotency key; appliers mutate projections
 * ONLY inside the persistEvent transaction.
 */

const ENGINEERING_STREAM_TYPES = new Set(['engineering']);
const RD_EVENT_TYPES = new Set([
  'rd_draft.cloned',
  'rd_build.recorded',
  'rd_build.confirmed',
  'rd_draft.productization_signed',
  'rd_draft.productized',
]);

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// eslint-disable-next-line no-loss-of-precision
const MAX_NUMERIC_18_6 = 999_999_999_999.999_999;

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_REGEX.test(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
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

function assertValidOccurredAt(occurredAt: unknown): asserts occurredAt is string {
  if (
    !occurredAt ||
    typeof occurredAt !== 'string' ||
    Number.isNaN(new Date(occurredAt).getTime())
  ) {
    reject('INVALID_PARAMS', 'occurred_at is required and must be a valid ISO 8601 date string');
  }
}

export function rdEventType(envelope: EventEnvelope): string | null {
  if (!ENGINEERING_STREAM_TYPES.has(envelope.stream_type)) return null;
  if (!RD_EVENT_TYPES.has(envelope.event_type)) return null;
  return envelope.event_type;
}

// ---------------------------------------------------------------------------
// Pre-transaction shape asserts (no DB access)
// ---------------------------------------------------------------------------

export function assertRdShape(envelope: EventEnvelope): void {
  const type = rdEventType(envelope);
  if (!type) return;
  const p = envelope.payload as Record<string, unknown>;

  switch (type) {
    case 'rd_draft.cloned':
      assertRdDraftClonedShape(p);
      break;
    case 'rd_build.recorded':
      assertRdBuildRecordedShape(p);
      break;
    case 'rd_build.confirmed':
      assertRdBuildConfirmedShape(p);
      break;
    case 'rd_draft.productization_signed':
      assertRdProductizationSignedShape(p);
      break;
    case 'rd_draft.productized':
      assertRdProductizedShape(p);
      break;
  }
}

function assertLineIds(value: unknown): void {
  if (!Array.isArray(value) || value.length === 0)
    reject('INVALID_PARAMS', 'line_ids must be a non-empty array of UUIDs');
  if (value.length > 200) reject('INVALID_PARAMS', 'Maximum 200 lines per BOM');
  for (const id of value) {
    if (!isUuid(id)) reject('INVALID_PARAMS', 'line_ids must contain only UUIDs');
  }
}

function assertNewBomHeaderShape(p: Record<string, unknown>): void {
  if (!isUuid(p['bom_id'])) reject('INVALID_PARAMS', 'bom_id is required and must be a UUID');
  if (!isUuid(p['revision_id']))
    reject('INVALID_PARAMS', 'revision_id is required and must be a UUID');
  if (!isNonEmptyString(p['revision_code']))
    reject('INVALID_PARAMS', 'revision_code is required and must be a non-empty string');
  if (!isUuid(p['parent_item_id']))
    reject('INVALID_PARAMS', 'parent_item_id is required and must be a UUID');
  if (!isNonEmptyString(p['parent_sku']))
    reject('INVALID_PARAMS', 'parent_sku is required and must be a non-empty string');
  if (!isNonEmptyString(p['parent_uom']))
    reject('INVALID_PARAMS', 'parent_uom is required and must be a non-empty string');
  if (!isNonEmptyString(p['business_stream']))
    reject('INVALID_PARAMS', 'business_stream is required and must be a non-empty string');
  assertLineIds(p['line_ids']);
}

function assertRdDraftClonedShape(p: Record<string, unknown>): void {
  if (!isUuid(p['source_bom_id']))
    reject('INVALID_PARAMS', 'source_bom_id is required and must be a UUID');
  if (!isUuid(p['source_revision_id']))
    reject('INVALID_PARAMS', 'source_revision_id is required and must be a UUID');
  assertNewBomHeaderShape(p);
}

function assertRdProductizedShape(p: Record<string, unknown>): void {
  if (!isUuid(p['source_bom_id']))
    reject('INVALID_PARAMS', 'source_bom_id is required and must be a UUID');
  assertNewBomHeaderShape(p);
}

function assertRdBuildRecordedShape(p: Record<string, unknown>): void {
  if (!isUuid(p['build_id'])) reject('INVALID_PARAMS', 'build_id is required and must be a UUID');
  if (!isUuid(p['bom_id'])) reject('INVALID_PARAMS', 'bom_id is required and must be a UUID');
  if (!isUuid(p['revision_id']))
    reject('INVALID_PARAMS', 'revision_id is required and must be a UUID');
  if (!isNonEmptyString(p['build_ref']))
    reject('INVALID_PARAMS', 'build_ref is required and must be a non-empty string');
  if (!isNonEmptyString(p['business_stream']))
    reject('INVALID_PARAMS', 'business_stream is required and must be a non-empty string');
  assertDecimalString(
    p['built_quantity'],
    'INVALID_PARAMS',
    'built_quantity must be a positive decimal string',
    MAX_NUMERIC_18_6,
    6,
  );
  if (!isNonEmptyString(p['built_uom']))
    reject('INVALID_PARAMS', 'built_uom is required and must be a non-empty string');
  if (
    p['outcome'] !== undefined &&
    p['outcome'] !== null &&
    !['success', 'failed', 'abandoned'].includes(p['outcome'] as string)
  ) {
    reject('INVALID_PARAMS', 'outcome must be one of success, failed, abandoned');
  }
  if (p['notes'] !== undefined && p['notes'] !== null && typeof p['notes'] !== 'string')
    reject('INVALID_PARAMS', 'notes must be a string when provided');

  const lines = p['as_built_lines'];
  if (!Array.isArray(lines) || lines.length === 0)
    reject('INVALID_PARAMS', 'as_built_lines must be a non-empty array');
  if (lines.length > 200) reject('INVALID_PARAMS', 'Maximum 200 as-built lines per build');

  const seenLineNos = new Set<number>();
  for (const raw of lines) {
    const line = raw as Record<string, unknown>;
    const lineNo = line['line_no'];
    if (typeof lineNo !== 'number' || !Number.isInteger(lineNo) || lineNo <= 0) {
      reject('INVALID_PARAMS', 'line_no must be a positive integer');
    }
    if (seenLineNos.has(lineNo)) reject('INVALID_PARAMS', 'Duplicate line_no in as_built_lines');
    seenLineNos.add(lineNo);

    if (
      line['draft_bom_line_id'] !== undefined &&
      line['draft_bom_line_id'] !== null &&
      !isUuid(line['draft_bom_line_id'])
    ) {
      reject('INVALID_PARAMS', 'draft_bom_line_id must be a UUID when provided');
    }

    const isPlaceholder = line['is_placeholder'];
    if (isPlaceholder !== undefined && typeof isPlaceholder !== 'boolean') {
      reject('INVALID_PARAMS', 'is_placeholder must be a boolean when provided');
    }
    if (isPlaceholder === true) {
      if (line['component_item_id'] !== undefined && line['component_item_id'] !== null) {
        reject(
          'INVALID_PARAMS',
          'component_item_id must not be set on a placeholder as-built line',
        );
      }
      if (!isNonEmptyString(line['free_text'])) {
        reject(
          'INVALID_PARAMS',
          'free_text is required and must be non-empty on a placeholder as-built line',
        );
      }
    } else {
      if (!isUuid(line['component_item_id'])) {
        reject('INVALID_PARAMS', 'component_item_id is required and must be a UUID');
      }
      if (!isNonEmptyString(line['component_sku'])) {
        reject('INVALID_PARAMS', 'component_sku is required and must be a non-empty string');
      }
    }

    assertDecimalString(
      line['quantity_used'],
      'INVALID_PARAMS',
      'quantity_used must be a positive decimal string',
      MAX_NUMERIC_18_6,
      6,
    );
    if (!isNonEmptyString(line['line_uom']))
      reject('INVALID_PARAMS', 'line_uom is required and must be a non-empty string');
  }
}

function assertRdBuildConfirmedShape(p: Record<string, unknown>): void {
  if (!isUuid(p['build_id'])) reject('INVALID_PARAMS', 'build_id is required and must be a UUID');
}

function assertRdProductizationSignedShape(p: Record<string, unknown>): void {
  if (!isUuid(p['signoff_id']))
    reject('INVALID_PARAMS', 'signoff_id is required and must be a UUID');
  if (!isUuid(p['bom_id'])) reject('INVALID_PARAMS', 'bom_id is required and must be a UUID');
  if (!(RD_GATE_FUNCTIONS as readonly string[]).includes(p['gate_function'] as string)) {
    reject('INVALID_PARAMS', 'gate_function must be one of engineering, procurement, qc');
  }
  if (!isUuid(p['approver_actor_id']))
    reject('INVALID_PARAMS', 'approver_actor_id is required and must be a UUID');
  if (p['doa_entry_id'] !== null && !isUuid(p['doa_entry_id'])) {
    reject('INVALID_PARAMS', 'doa_entry_id must be a UUID or null');
  }
  if (p['notes'] !== undefined && p['notes'] !== null && typeof p['notes'] !== 'string')
    reject('INVALID_PARAMS', 'notes must be a string when provided');
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

export async function applyRdProjection(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
): Promise<void> {
  const type = rdEventType(envelope);
  if (!type) return;

  switch (type) {
    case 'rd_draft.cloned':
      await applyRdDraftCloned(envelope, client, eventId);
      break;
    case 'rd_build.recorded':
      await applyRdBuildRecorded(envelope, client, eventId);
      break;
    case 'rd_build.confirmed':
      await applyRdBuildConfirmed(envelope, client, eventId);
      break;
    case 'rd_draft.productization_signed':
      await applyRdProductizationSigned(envelope, client, eventId);
      break;
    case 'rd_draft.productized':
      await applyRdProductized(envelope, client, eventId);
      break;
  }
}

interface SourceBomRow {
  bom_id: string;
  parent_item_id: string;
  parent_sku: string;
  parent_uom: string;
  business_stream: string;
  bom_type: string;
  status: string;
  current_revision_id: string | null;
}

/**
 * Resolves the revision to copy from: current_revision_id, falling back to the sole bom_revision
 * row when NULL (a never-released draft BOM has NULL current_revision_id only in the legacy
 * Story 5.1 data shape; bom.drafted sets it, but the fallback keeps cloning total).
 */
async function resolveSourceRevisionId(bom: SourceBomRow, client: PoolClient): Promise<string> {
  if (bom.current_revision_id) return bom.current_revision_id;
  const revisions = await client.query(
    `SELECT revision_id FROM bom_revision WHERE bom_id = $1 ORDER BY drafted_at ASC LIMIT 1`,
    [bom.bom_id],
  );
  if (revisions.rows.length === 0) {
    reject(
      'INVALID_PARAMS',
      'Source BOM has no revision to clone from',
      { source_bom_id: bom.bom_id },
      409,
    );
  }
  return revisions.rows[0]!.revision_id as string;
}

/** Copies every line of a source revision onto a new revision using pre-minted line ids. */
async function copyRevisionLines(
  sourceLines: BomLineRow[],
  lineIds: string[],
  newRevisionId: string,
  newBomId: string,
  eventId: string,
  client: PoolClient,
): Promise<void> {
  if (sourceLines.length !== lineIds.length) {
    reject(
      'INVALID_PARAMS',
      'line_ids count does not match the source revision line count',
      { expected: sourceLines.length, received: lineIds.length },
      409,
    );
  }
  for (let i = 0; i < sourceLines.length; i++) {
    const line = sourceLines[i]!;
    await insertBomLine(
      {
        bom_line_id: lineIds[i]!,
        revision_id: newRevisionId,
        bom_id: newBomId,
        line_no: line.line_no,
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
}

async function applyRdDraftCloned(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
): Promise<void> {
  if (await alreadyPersisted(envelope, client)) return;

  const p = envelope.payload as unknown as RdDraftClonedPayload;

  const sourceRow = await client.query('SELECT * FROM bom WHERE bom_id = $1', [p.source_bom_id]);
  if (sourceRow.rows.length === 0)
    reject('BOM_NOT_FOUND', 'Source BOM not found', { bom_id: p.source_bom_id }, 404);
  const source = sourceRow.rows[0] as SourceBomRow;
  // Source may be in any status and any bom_type: cloning an R&D draft to a new R&D draft is
  // legitimate iteration and costs nothing to allow (AC 3).

  const existing = await client.query('SELECT 1 FROM bom WHERE bom_id = $1', [p.bom_id]);
  if (existing.rows.length > 0) {
    reject('DUPLICATE_EVENT', 'A BOM with this bom_id already exists', { bom_id: p.bom_id }, 409);
  }

  // The revision to copy is the one resolved at CAPTURE time in the handler and stored on the
  // payload (source_revision_id): replay must copy exactly the revision the line_ids were sized
  // against, never whatever the source BOM's current_revision_id happens to be at apply time.
  const sourceRevisionId = p.source_revision_id;
  const occurredAt = envelope.metadata.occurred_at;
  assertValidOccurredAt(occurredAt);
  const occurredAtIso = new Date(occurredAt).toISOString();
  const actorId = envelope.metadata.actor.user_id;

  // parent identity and business_stream are COPIED from the source row, never re-read from the
  // item master - the clone must mirror the source, and FR-AC-01 is already satisfied by the
  // source's tag.
  await insertBom(
    {
      bom_id: p.bom_id,
      parent_item_id: source.parent_item_id,
      parent_sku: source.parent_sku,
      parent_uom: source.parent_uom,
      business_stream: source.business_stream,
      bom_type: 'rnd',
      status: 'draft',
      current_revision_id: p.revision_id,
      blocking_line_count: 0,
      status_changed_at: null,
      status_changed_by: null,
      origin: 'native',
      remediation_flag: false,
      kit_ref: null,
      cloned_from_bom_id: p.source_bom_id,
      productized_from_bom_id: null,
      created_by: actorId,
      correlation_id: p.correlation_id ?? null,
      source_event_id: eventId,
    },
    client,
  );

  await insertBomRevision(
    {
      revision_id: p.revision_id,
      bom_id: p.bom_id,
      revision_code: p.revision_code,
      revision_status: 'draft',
      drafted_by: actorId,
      drafted_at: occurredAtIso,
      released_at: null,
      released_by: null,
      source_eco_id: null,
      source_event_id: eventId,
    },
    client,
  );

  const sourceLines = await getBomLines(sourceRevisionId, client);
  await copyRevisionLines(sourceLines, p.line_ids, p.revision_id, p.bom_id, eventId, client);
}

async function lockRdBomOrReject(bomId: string, client: PoolClient): Promise<SourceBomRow> {
  const bomRow = await client.query('SELECT * FROM bom WHERE bom_id = $1 FOR UPDATE', [bomId]);
  if (bomRow.rows.length === 0) reject('BOM_NOT_FOUND', 'BOM not found', { bom_id: bomId }, 404);
  const bom = bomRow.rows[0] as SourceBomRow;
  if (bom.bom_type !== 'rnd') {
    reject(
      'RD_BUILD_NOT_PERMITTED',
      'This operation belongs to the R&D draft regime only',
      { bom_id: bomId, bom_type: bom.bom_type },
      409,
    );
  }
  return bom;
}

async function applyRdBuildRecorded(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
): Promise<void> {
  if (await alreadyPersisted(envelope, client)) return;

  const p = envelope.payload as unknown as RdBuildRecordedPayload;

  const bom = await lockRdBomOrReject(p.bom_id, client);

  // A concurrent same-key retry that passed the pre-lock alreadyPersisted check may have
  // committed while this transaction waited on the row lock - re-check now so the retry returns
  // the first request's result instead of a business 409 (DUPLICATE_EVENT / SNAPSHOT_IMMUTABLE).
  if (await alreadyPersisted(envelope, client)) return;

  // Story 5.3 closed the revision/bom cross-check gap for ECO; do not reintroduce it here.
  const revision = await client.query(
    'SELECT 1 FROM bom_revision WHERE revision_id = $1 AND bom_id = $2',
    [p.revision_id, p.bom_id],
  );
  if (revision.rows.length === 0) {
    reject('INVALID_PARAMS', 'revision_id does not belong to this BOM', {
      bom_id: p.bom_id,
      revision_id: p.revision_id,
    });
  }

  const existingRef = await client.query(
    'SELECT build_id, status FROM rd_build_record WHERE bom_id = $1 AND build_ref = $2',
    [p.bom_id, p.build_ref],
  );
  if (existingRef.rows.length > 0) {
    const conflictStatus = existingRef.rows[0]!.status as string;
    if (conflictStatus === 'confirmed') {
      // A confirmed snapshot is immutable; corrections are NEW snapshots under a new build_ref.
      reject(
        'SNAPSHOT_IMMUTABLE',
        'A confirmed as-built snapshot already exists for this build_ref - corrections are new snapshots',
        { bom_id: p.bom_id, build_ref: p.build_ref },
        409,
      );
    }
    reject(
      'DUPLICATE_EVENT',
      'A build record already exists for this build_ref',
      { bom_id: p.bom_id, build_ref: p.build_ref },
      409,
    );
  }

  const occurredAt = envelope.metadata.occurred_at;
  assertValidOccurredAt(occurredAt);
  const occurredAtIso = new Date(occurredAt).toISOString();
  const actorId = envelope.metadata.actor.user_id;

  await insertBuildRecord(
    {
      build_id: p.build_id,
      bom_id: bom.bom_id,
      revision_id: p.revision_id,
      build_ref: p.build_ref,
      status: 'recorded',
      built_quantity: p.built_quantity,
      built_uom: p.built_uom,
      notes: p.notes ?? null,
      outcome:
        (p.outcome as RdBuildRecordedPayload['outcome'] as
          'success' | 'failed' | 'abandoned' | undefined) ?? null,
      recorded_by: actorId,
      recorded_at: occurredAtIso,
      confirmed_by: null,
      confirmed_at: null,
      correlation_id: p.correlation_id ?? null,
      source_event_id: eventId,
    },
    client,
  );

  // Deviation columns stay empty at record time: the deviation set is recomputed at CONFIRM
  // against the draft's then-current lines (the draft is editable between record and confirm,
  // which is exactly the R&D regime's point). line_no is the caller's own correlation value
  // (validated positive-unique by assertRdBuildRecordedShape) - store it verbatim so the
  // snapshot rows round-trip against the submitted input.
  for (const line of p.as_built_lines) {
    // The payload type is a discriminated union (placeholder vs real line); the shape assert has
    // already guaranteed the fields on each branch, so insert exactly what the branch carries.
    const base = {
      build_id: p.build_id,
      line_no: line.line_no,
      draft_bom_line_id: line.draft_bom_line_id ?? null,
      quantity_used: line.quantity_used,
      line_uom: line.line_uom,
      deviation_flag: false,
      deviation_kind: null,
      deviation_detail: null,
      source_event_id: eventId,
    } as const;
    if (line.is_placeholder === true) {
      await insertAsBuiltLine(
        {
          ...base,
          as_built_line_id: randomUUID(),
          component_item_id: null,
          component_sku: null,
          is_placeholder: true,
          free_text: line.free_text,
        },
        client,
      );
    } else {
      await insertAsBuiltLine(
        {
          ...base,
          as_built_line_id: randomUUID(),
          component_item_id: line.component_item_id,
          component_sku: line.component_sku,
          is_placeholder: false,
          free_text: null,
        },
        client,
      );
    }
  }
}

/** Exact NUMERIC equality in PostgreSQL - '2.5' and '2.500000' are equal; never compare in JS. */
async function numericEqual(a: string, b: string, client: PoolClient): Promise<boolean> {
  const result = await client.query('SELECT $1::numeric = $2::numeric AS eq', [a, b]);
  return result.rows[0]!.eq === true;
}

async function applyRdBuildConfirmed(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
): Promise<void> {
  if (await alreadyPersisted(envelope, client)) return;

  const p = envelope.payload as unknown as RdBuildConfirmedPayload;

  const buildRow = await client.query(
    'SELECT * FROM rd_build_record WHERE build_id = $1 FOR UPDATE',
    [p.build_id],
  );
  if (buildRow.rows.length === 0)
    reject('BUILD_NOT_FOUND', 'Build record not found', { build_id: p.build_id }, 404);
  const build = buildRow.rows[0]!;

  // A concurrent same-key retry that passed the pre-lock alreadyPersisted check may have
  // committed while this transaction waited on the FOR UPDATE lock - re-check now so the retry
  // returns the first request's result instead of a misleading SNAPSHOT_IMMUTABLE.
  if (await alreadyPersisted(envelope, client)) return;

  if (build.status === 'confirmed') {
    reject(
      'SNAPSHOT_IMMUTABLE',
      'This build is already confirmed - the as-built snapshot is immutable and corrections are new snapshots',
      { build_id: p.build_id },
      409,
    );
  }
  if (build.status !== 'recorded') {
    reject(
      'BUILD_STATE_INVALID',
      `Cannot confirm a build in ${build.status as string} state`,
      { build_id: p.build_id, status: build.status },
      409,
    );
  }

  const occurredAt = envelope.metadata.occurred_at;
  assertValidOccurredAt(occurredAt);
  const occurredAtIso = new Date(occurredAt).toISOString();
  const actorId = envelope.metadata.actor.user_id;

  // Recompute the deviation set INSIDE the transaction against the draft revision's CURRENT
  // bom_line rows - never trusting anything computed at record time. Matching: by
  // draft_bom_line_id when supplied, otherwise by component_item_id.
  const draftLines = await getBomLines(build.revision_id as string, client);
  const asBuiltLines = await getAsBuiltLines(p.build_id, client);

  const draftById = new Map(draftLines.map((line) => [line.bom_line_id, line]));
  const matchedDraftIds = new Set<string>();

  const matches: { ab: RdAsBuiltLineRow; draft: BomLineRow | null }[] = [];
  for (const ab of asBuiltLines) {
    let draft: BomLineRow | null = null;
    if (ab.draft_bom_line_id) {
      draft = draftById.get(ab.draft_bom_line_id) ?? null;
    } else if (ab.component_item_id) {
      draft =
        draftLines.find(
          (line) =>
            !matchedDraftIds.has(line.bom_line_id) &&
            line.component_item_id === ab.component_item_id,
        ) ?? null;
    }
    if (draft && matchedDraftIds.has(draft.bom_line_id)) draft = null;
    if (draft) matchedDraftIds.add(draft.bom_line_id);
    matches.push({ ab, draft });
  }

  for (const { ab, draft } of matches) {
    if (!draft) {
      await updateAsBuiltDeviation(
        ab.as_built_line_id,
        true,
        'extra',
        'as-built line matches no draft line',
        client,
      );
      continue;
    }
    if (draft.is_placeholder && !ab.is_placeholder) {
      await updateAsBuiltDeviation(
        ab.as_built_line_id,
        true,
        'placeholder',
        `draft placeholder "${draft.free_text ?? ''}" built with ${ab.component_sku ?? ''}`,
        client,
      );
      continue;
    }
    if (
      !draft.is_placeholder &&
      (ab.is_placeholder || draft.component_item_id !== ab.component_item_id)
    ) {
      await updateAsBuiltDeviation(
        ab.as_built_line_id,
        true,
        'substitution',
        `expected component ${draft.component_sku ?? ''}, used ${ab.is_placeholder ? `placeholder "${ab.free_text ?? ''}"` : (ab.component_sku ?? '')}`,
        client,
      );
      continue;
    }
    if (!(await numericEqual(ab.quantity_used, draft.quantity_per, client))) {
      await updateAsBuiltDeviation(
        ab.as_built_line_id,
        true,
        'quantity',
        `expected ${draft.quantity_per}, used ${ab.quantity_used}`,
        client,
      );
      continue;
    }
    await updateAsBuiltDeviation(ab.as_built_line_id, false, null, null, client);
  }

  // A draft line the engineer never built leaves a synthetic 'missing' row - without it, a
  // forgotten component leaves no trace in the snapshot, which defeats an as-built record.
  let nextLineNo = asBuiltLines.reduce((max, line) => Math.max(max, line.line_no), 0);
  for (const draft of draftLines) {
    if (matchedDraftIds.has(draft.bom_line_id)) continue;
    nextLineNo += 1;
    await insertAsBuiltLine(
      {
        as_built_line_id: randomUUID(),
        build_id: p.build_id,
        line_no: nextLineNo,
        draft_bom_line_id: draft.bom_line_id,
        component_item_id: draft.component_item_id,
        component_sku: draft.component_sku,
        is_placeholder: draft.is_placeholder,
        free_text: draft.free_text,
        quantity_used: draft.quantity_per,
        line_uom: draft.line_uom,
        deviation_flag: true,
        deviation_kind: 'missing',
        deviation_detail: `draft line ${draft.line_no} has no as-built line`,
        source_event_id: eventId,
      },
      client,
    );
  }

  await confirmBuildRecord(p.build_id, occurredAtIso, actorId, client);
}

async function applyRdProductizationSigned(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
): Promise<void> {
  if (await alreadyPersisted(envelope, client)) return;

  const p = envelope.payload as unknown as RdProductizationSignedPayload;

  await lockRdBomOrReject(p.bom_id, client);

  const occurredAt = envelope.metadata.occurred_at;
  assertValidOccurredAt(occurredAt);

  await upsertSignoff(
    {
      signoff_id: p.signoff_id,
      bom_id: p.bom_id,
      gate_function: p.gate_function,
      signed_by: envelope.metadata.actor.user_id,
      signed_at: new Date(occurredAt).toISOString(),
      approver_actor_id: p.approver_actor_id,
      doa_entry_id: p.doa_entry_id,
      notes: p.notes ?? null,
      source_event_id: eventId,
    },
    client,
  );
}

async function applyRdProductized(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
): Promise<void> {
  if (await alreadyPersisted(envelope, client)) return;

  const p = envelope.payload as unknown as RdProductizedPayload;

  const source = await lockRdBomOrReject(p.source_bom_id, client);

  // A concurrent same-key retry that passed the pre-lock alreadyPersisted check may have
  // committed while this transaction waited on the row lock - re-check now so the retry returns
  // the first request's result instead of a business 409 (BOM_ALREADY_EXISTS / DUPLICATE_EVENT).
  if (await alreadyPersisted(envelope, client)) return;

  // Re-derive the sign-off set and placeholder set INSIDE the transaction via the SAME predicate
  // the checklist uses (evaluateProductizationGate) - the two can never disagree.
  const gate = await evaluateProductizationGate(
    p.source_bom_id,
    source.current_revision_id,
    client,
  );
  if (gate.missingSignoffs.length > 0) {
    reject(
      'APPROVAL_REQUIRED',
      'Productization requires engineering, procurement, and qc sign-offs',
      { bom_id: p.source_bom_id, missing_signoffs: gate.missingSignoffs },
      409,
    );
  }
  if (gate.placeholderLineNos.length > 0) {
    reject(
      'RD_PLACEHOLDER_UNRESOLVED',
      'A placeholder cannot become a production component - resolve placeholders before productizing',
      { bom_id: p.source_bom_id, placeholder_line_nos: gate.placeholderLineNos },
      409,
    );
  }

  // Serialize concurrent productizations of the same parent item: two R&D drafts of the same
  // parent lock their OWN bom rows, so without this advisory lock both could pass the pre-check
  // below and the loser would hit uq_bom_parent_item, which store.ts maps to a generic
  // DUPLICATE_EVENT (not the mandated BOM_ALREADY_EXISTS). Story 3.4 precedent:
  // pg_advisory_xact_lock for exactly this cross-row race.
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))', [
    p.parent_item_id,
  ]);

  // The serial path: a non-rnd BOM already exists for this parent item. The correct path for
  // changing an existing production BOM is an ECO (Story 5.3).
  const existingProduction = await client.query(
    `SELECT bom_id FROM bom WHERE parent_item_id = $1 AND bom_type <> 'rnd'`,
    [p.parent_item_id],
  );
  if (existingProduction.rows.length > 0) {
    reject(
      'BOM_ALREADY_EXISTS',
      'A production BOM already exists for this parent item - changes go through an ECO',
      { parent_item_id: p.parent_item_id, existing_bom_id: existingProduction.rows[0]!.bom_id },
      409,
    );
  }

  const existing = await client.query('SELECT 1 FROM bom WHERE bom_id = $1', [p.bom_id]);
  if (existing.rows.length > 0) {
    reject('DUPLICATE_EVENT', 'A BOM with this bom_id already exists', { bom_id: p.bom_id }, 409);
  }

  const sourceRevisionId = await resolveSourceRevisionId(source, client);
  const occurredAt = envelope.metadata.occurred_at;
  assertValidOccurredAt(occurredAt);
  const occurredAtIso = new Date(occurredAt).toISOString();
  const actorId = envelope.metadata.actor.user_id;

  // The new production BOM lands in 'draft', NOT 'released': it travels the ordinary Story 5.2
  // release path including the full release gate. Productization is not a release. The source
  // R&D draft is NOT modified - it keeps iterating.
  await insertBom(
    {
      bom_id: p.bom_id,
      parent_item_id: source.parent_item_id,
      parent_sku: source.parent_sku,
      parent_uom: source.parent_uom,
      business_stream: source.business_stream,
      bom_type: 'production',
      status: 'draft',
      current_revision_id: p.revision_id,
      blocking_line_count: 0,
      status_changed_at: null,
      status_changed_by: null,
      origin: 'native',
      remediation_flag: false,
      kit_ref: null,
      cloned_from_bom_id: null,
      productized_from_bom_id: p.source_bom_id,
      created_by: actorId,
      correlation_id: p.correlation_id ?? null,
      source_event_id: eventId,
    },
    client,
  );

  await insertBomRevision(
    {
      revision_id: p.revision_id,
      bom_id: p.bom_id,
      revision_code: p.revision_code,
      revision_status: 'draft',
      drafted_by: actorId,
      drafted_at: occurredAtIso,
      released_at: null,
      released_by: null,
      source_eco_id: null,
      source_event_id: eventId,
    },
    client,
  );

  const sourceLines = await getBomLines(sourceRevisionId, client);
  await copyRevisionLines(sourceLines, p.line_ids, p.revision_id, p.bom_id, eventId, client);
}
