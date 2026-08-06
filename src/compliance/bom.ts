import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { EventEnvelope } from '../events/store.js';
import { AppError } from '../middleware/error.js';
import { getItemById } from '../read/projections/item_master.js';
import type {
  BomDraftedPayload,
  BomLineAddedPayload,
  BomLineAmendedPayload,
} from '../events/schema.js';

const ENGINEERING_STREAM_TYPES = new Set(['engineering']);
const BOM_EVENT_TYPES = new Set(['bom.drafted', 'bom_line.added', 'bom_line.amended']);

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_REGEX = /^(\d{4})-(\d{2})-(\d{2})$/;
// eslint-disable-next-line no-loss-of-precision
const MAX_NUMERIC_18_6 = 999_999_999_999.999_999;
const MAX_NUMERIC_18_8 = 99_999_999.9999_9999;

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

export function bomEventType(envelope: EventEnvelope): string | null {
  if (!ENGINEERING_STREAM_TYPES.has(envelope.stream_type)) return null;
  if (!BOM_EVENT_TYPES.has(envelope.event_type)) return null;
  return envelope.event_type;
}

export function assertBomShape(envelope: EventEnvelope): void {
  const type = bomEventType(envelope);
  if (!type) return;
  const p = envelope.payload as Record<string, unknown>;

  switch (type) {
    case 'bom.drafted':
      assertBomDraftedShape(p);
      break;
    case 'bom_line.added':
      assertBomLineAddedShape(p);
      break;
    case 'bom_line.amended':
      assertBomLineAmendedShape(p);
      break;
  }
}

function assertBomDraftedShape(p: Record<string, unknown>): void {
  if (!isUuid(p['bom_id'])) reject('INVALID_PARAMS', 'bom_id is required and must be a UUID');
  if (!isUuid(p['parent_item_id']))
    reject('INVALID_PARAMS', 'parent_item_id is required and must be a UUID');
  if (!isNonEmptyString(p['revision_code']))
    reject('INVALID_PARAMS', 'revision_code is required and must be a non-empty string');

  const bomType = p['bom_type'] as string | undefined;
  if (bomType !== undefined && !['production', 'rnd', 'job_work_kit'].includes(bomType)) {
    reject('INVALID_PARAMS', 'bom_type must be one of production, rnd, job_work_kit');
  }

  const lines = p['lines'];
  if (!Array.isArray(lines) || lines.length === 0)
    reject('BOM_LINE_REQUIRED', 'At least one line is required');
  if (lines.length > 200) reject('INVALID_PARAMS', 'Maximum 200 lines per BOM');

  const seenLineNos = new Set<number>();
  for (const line of lines as Record<string, unknown>[]) {
    const lineNo = line['line_no'];
    if (typeof lineNo !== 'number' || !Number.isInteger(lineNo) || lineNo <= 0) {
      reject('INVALID_PARAMS', 'line_no must be a positive integer');
    }
    if (seenLineNos.has(lineNo)) reject('INVALID_PARAMS', 'Duplicate line_no in request');
    seenLineNos.add(lineNo);

    if (!isUuid(line['component_item_id'])) {
      reject('INVALID_PARAMS', 'component_item_id is required and must be a UUID');
    }

    const outputClass = line['output_class'] as string;
    if (!['component', 'co_product', 'by_product'].includes(outputClass)) {
      reject('INVALID_PARAMS', 'output_class must be one of component, co_product, by_product');
    }

    if (outputClass !== 'component' && !line['expected_yield_percent']) {
      reject(
        'BOM_YIELD_REQUIRED',
        'expected_yield_percent is required for co_product and by_product',
      );
    }
    if (outputClass === 'component' && line['expected_yield_percent']) {
      reject('INVALID_PARAMS', 'expected_yield_percent must not be set for component output_class');
    }

    assertDecimalString(
      line['quantity_per'],
      'INVALID_PARAMS',
      'quantity_per must be a positive decimal string',
      MAX_NUMERIC_18_6,
      6,
    );
    if (!isNonEmptyString(line['line_uom']))
      reject('INVALID_PARAMS', 'line_uom is required and must be a non-empty string');
    assertDecimalString(
      line['uom_conversion_factor'],
      'BOM_INVALID_CONVERSION_FACTOR',
      'uom_conversion_factor must be a positive decimal string',
      MAX_NUMERIC_18_8,
      8,
    );
    assertScrapPercent(line['scrap_percent']);
    assertYieldPercent(line['expected_yield_percent']);

    const isPhantom = line['is_phantom'];
    if (typeof isPhantom !== 'boolean') reject('INVALID_PARAMS', 'is_phantom must be a boolean');
    if (isPhantom && !isUuid(line['phantom_source_bom_id'])) {
      reject('INVALID_PARAMS', 'phantom_source_bom_id is required when is_phantom is true');
    }

    if (!isDateString(line['effective_from']))
      reject('INVALID_PARAMS', 'effective_from is required and must be a YYYY-MM-DD date');
    if (
      line['effective_to'] !== undefined &&
      line['effective_to'] !== null &&
      !isDateString(line['effective_to'])
    ) {
      reject('INVALID_PARAMS', 'effective_to must be a YYYY-MM-DD date or null');
    }
    if (line['effective_to'] && line['effective_from']) {
      if (line['effective_to'] < line['effective_from']) {
        reject('INVALID_PARAMS', 'effective_to must be on or after effective_from');
      }
    }
  }
}

function assertBomLineAddedShape(p: Record<string, unknown>): void {
  if (!isUuid(p['bom_id'])) reject('INVALID_PARAMS', 'bom_id is required and must be a UUID');
  if (!isUuid(p['revision_id']))
    reject('INVALID_PARAMS', 'revision_id is required and must be a UUID');
  if (!isUuid(p['bom_line_id']))
    reject('INVALID_PARAMS', 'bom_line_id is required and must be a UUID');

  const lineNo = p['line_no'];
  if (typeof lineNo !== 'number' || !Number.isInteger(lineNo) || lineNo <= 0) {
    reject('INVALID_PARAMS', 'line_no must be a positive integer');
  }

  if (!isUuid(p['component_item_id']))
    reject('INVALID_PARAMS', 'component_item_id is required and must be a UUID');

  const outputClass = p['output_class'] as string;
  if (!['component', 'co_product', 'by_product'].includes(outputClass)) {
    reject('INVALID_PARAMS', 'output_class must be one of component, co_product, by_product');
  }

  if (outputClass !== 'component' && !p['expected_yield_percent']) {
    reject(
      'BOM_YIELD_REQUIRED',
      'expected_yield_percent is required for co_product and by_product',
    );
  }

  assertDecimalString(
    p['quantity_per'] as string,
    'INVALID_PARAMS',
    'quantity_per must be a positive decimal string',
    MAX_NUMERIC_18_6,
    6,
  );
  if (!isNonEmptyString(p['line_uom']))
    reject('INVALID_PARAMS', 'line_uom is required and must be a non-empty string');
  assertDecimalString(
    p['uom_conversion_factor'] as string,
    'BOM_INVALID_CONVERSION_FACTOR',
    'uom_conversion_factor must be a positive decimal string',
    MAX_NUMERIC_18_8,
    8,
  );
  assertScrapPercent(p['scrap_percent']);
  assertYieldPercent(p['expected_yield_percent']);

  const isPhantom = p['is_phantom'];
  if (typeof isPhantom !== 'boolean') reject('INVALID_PARAMS', 'is_phantom must be a boolean');
  if (isPhantom && !isUuid(p['phantom_source_bom_id'])) {
    reject('INVALID_PARAMS', 'phantom_source_bom_id is required when is_phantom is true');
  }

  if (!isDateString(p['effective_from']))
    reject('INVALID_PARAMS', 'effective_from is required and must be a YYYY-MM-DD date');
  if (
    p['effective_to'] !== undefined &&
    p['effective_to'] !== null &&
    !isDateString(p['effective_to'])
  ) {
    reject('INVALID_PARAMS', 'effective_to must be a YYYY-MM-DD date or null');
  }
}

function assertBomLineAmendedShape(p: Record<string, unknown>): void {
  if (!isUuid(p['bom_id'])) reject('INVALID_PARAMS', 'bom_id is required and must be a UUID');
  if (!isUuid(p['revision_id']))
    reject('INVALID_PARAMS', 'revision_id is required and must be a UUID');
  if (!isUuid(p['bom_line_id']))
    reject('INVALID_PARAMS', 'bom_line_id is required and must be a UUID');

  if (p['quantity_per'] !== undefined) {
    assertDecimalString(
      p['quantity_per'] as string,
      'INVALID_PARAMS',
      'quantity_per must be a positive decimal string',
      MAX_NUMERIC_18_6,
      6,
    );
  }
  if (p['line_uom'] !== undefined && !isNonEmptyString(p['line_uom'])) {
    reject('INVALID_PARAMS', 'line_uom must be a non-empty string');
  }
  if (p['uom_conversion_factor'] !== undefined) {
    assertDecimalString(
      p['uom_conversion_factor'] as string,
      'BOM_INVALID_CONVERSION_FACTOR',
      'uom_conversion_factor must be a positive decimal string',
      MAX_NUMERIC_18_8,
      8,
    );
  }
  if (p['scrap_percent'] !== undefined) assertScrapPercent(p['scrap_percent']);
  if (p['expected_yield_percent'] !== undefined) assertYieldPercent(p['expected_yield_percent']);
  if (p['effective_from'] !== undefined && !isDateString(p['effective_from'])) {
    reject('INVALID_PARAMS', 'effective_from must be a YYYY-MM-DD date');
  }
  if (
    p['effective_to'] !== undefined &&
    p['effective_to'] !== null &&
    !isDateString(p['effective_to'])
  ) {
    reject('INVALID_PARAMS', 'effective_to must be a YYYY-MM-DD date or null');
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

export async function applyBomProjection(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
): Promise<void> {
  const type = bomEventType(envelope);
  if (!type) return;

  switch (type) {
    case 'bom.drafted':
      await applyBomDrafted(envelope, client, eventId);
      break;
    case 'bom_line.added':
      await applyBomLineAdded(envelope, client, eventId);
      break;
    case 'bom_line.amended':
      await applyBomLineAmended(envelope, client, eventId);
      break;
  }
}

async function applyBomDrafted(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
): Promise<void> {
  if (await alreadyPersisted(envelope, client)) return;

  const p = envelope.payload as unknown as BomDraftedPayload;
  const bomId = p.bom_id;

  const existing = await client.query('SELECT 1 FROM bom WHERE bom_id = $1', [bomId]);
  if (existing.rows.length > 0) {
    reject('DUPLICATE_EVENT', 'A BOM with this bom_id already exists', { bom_id: bomId }, 409);
  }

  const parentItem = await getItemById(p.parent_item_id, client);
  if (!parentItem)
    reject(
      'BOM_ITEM_NOT_FOUND',
      'Parent item not found',
      { parent_item_id: p.parent_item_id },
      404,
    );
  if (parentItem.status !== 'active') {
    reject(
      'BOM_ITEM_NOT_ACTIVE',
      'Parent item must be active',
      { parent_item_id: p.parent_item_id, status: parentItem.status },
      409,
    );
  }

  const revisionId = randomUUID();
  const occurredAt = envelope.metadata.occurred_at;
  if (
    !occurredAt ||
    typeof occurredAt !== 'string' ||
    Number.isNaN(new Date(occurredAt).getTime())
  ) {
    reject('INVALID_PARAMS', 'occurred_at is required and must be a valid ISO 8601 date string');
  }

  await client.query(
    `INSERT INTO bom (bom_id, parent_item_id, parent_sku, parent_uom, business_stream, bom_type, status, current_revision_id, blocking_line_count, created_by, correlation_id, source_event_id)
     VALUES ($1, $2, $3, $4, $5, $6, 'draft', $7, 0, $8, $9, $10)`,
    [
      bomId,
      parentItem.item_id,
      parentItem.sku,
      parentItem.uom,
      parentItem.business_stream,
      p.bom_type ?? 'production',
      revisionId,
      envelope.metadata.actor.user_id,
      p.correlation_id ?? null,
      eventId,
    ],
  );

  await client.query(
    `INSERT INTO bom_revision (revision_id, bom_id, revision_code, revision_status, drafted_by, drafted_at, source_event_id)
     VALUES ($1, $2, $3, 'draft', $4, $5, $6)`,
    [
      revisionId,
      bomId,
      p.revision_code,
      envelope.metadata.actor.user_id,
      new Date(occurredAt).toISOString(),
      eventId,
    ],
  );

  let blockingCount = 0;
  for (const line of p.lines) {
    const componentItem = await getItemById(line.component_item_id, client);
    if (!componentItem) {
      reject(
        'BOM_ITEM_NOT_FOUND',
        'Component item not found',
        { component_item_id: line.component_item_id },
        404,
      );
    }

    let blockingRelease = false;
    let blockingReason: string | null = null;
    if (componentItem.status !== 'active') {
      blockingRelease = true;
      blockingReason = `Component item ${componentItem.sku} is ${componentItem.status} - BOM cannot be released until item is active`;
      blockingCount++;
    }

    const bomLineId = randomUUID();
    const effectiveTo = line.effective_to ?? null;

    await client.query(
      `INSERT INTO bom_line (bom_line_id, revision_id, bom_id, line_no, component_item_id, component_sku, output_class, quantity_per, line_uom, uom_conversion_factor, base_quantity_per, scrap_percent, expected_yield_percent, is_phantom, phantom_source_bom_id, effective_from, effective_to, blocking_release, blocking_reason, source_event_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)`,
      [
        bomLineId,
        revisionId,
        bomId,
        line.line_no,
        componentItem.item_id,
        componentItem.sku,
        line.output_class,
        line.quantity_per,
        line.line_uom,
        line.uom_conversion_factor,
        String(Number(line.quantity_per) * Number(line.uom_conversion_factor)),
        line.scrap_percent ?? null,
        line.expected_yield_percent ?? null,
        line.is_phantom,
        line.phantom_source_bom_id ?? null,
        line.effective_from,
        effectiveTo,
        blockingRelease,
        blockingReason,
        eventId,
      ],
    );
  }

  if (blockingCount > 0) {
    await client.query(
      'UPDATE bom SET blocking_line_count = $1, updated_at = now() WHERE bom_id = $2',
      [blockingCount, bomId],
    );
  }
}

async function applyBomLineAdded(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
): Promise<void> {
  if (await alreadyPersisted(envelope, client)) return;

  const p = envelope.payload as unknown as BomLineAddedPayload;

  const bomRow = await client.query('SELECT * FROM bom WHERE bom_id = $1 FOR UPDATE', [p.bom_id]);
  if (bomRow.rows.length === 0) reject('BOM_NOT_FOUND', 'BOM not found', { bom_id: p.bom_id }, 404);
  if (bomRow.rows[0]!.status !== 'draft')
    reject(
      'BOM_NOT_DRAFT',
      'Can only add lines to a draft BOM',
      { bom_id: p.bom_id, status: bomRow.rows[0]!.status },
      409,
    );

  await client.query('SELECT 1 FROM bom_revision WHERE revision_id = $1 FOR UPDATE', [
    p.revision_id,
  ]);

  const componentItem = await getItemById(p.component_item_id, client);
  if (!componentItem)
    reject(
      'BOM_ITEM_NOT_FOUND',
      'Component item not found',
      { component_item_id: p.component_item_id },
      404,
    );

  const existingLine = await client.query(
    'SELECT 1 FROM bom_line WHERE revision_id = $1 AND line_no = $2',
    [p.revision_id, p.line_no],
  );
  if (existingLine.rows.length > 0)
    reject('INVALID_PARAMS', 'A line with this line_no already exists in this revision');

  const overlapCheck = await client.query(
    `SELECT line_no, effective_from, effective_to FROM bom_line
     WHERE revision_id = $1 AND component_item_id = $2
     AND effective_from <= $3 AND (effective_to IS NULL OR effective_to >= $4)`,
    [p.revision_id, p.component_item_id, p.effective_to ?? '9999-12-31', p.effective_from],
  );
  if (overlapCheck.rows.length > 0) {
    const conflict = overlapCheck.rows[0]!;
    reject(
      'EFFECTIVITY_OVERLAP',
      'Overlapping effectivity window with existing line',
      {
        conflicting_line_no: conflict.line_no,
        conflicting_effective_from: (conflict as Record<string, unknown>).effective_from,
        conflicting_effective_to: (conflict as Record<string, unknown>).effective_to,
      },
      409,
    );
  }

  let blockingRelease = false;
  let blockingReason: string | null = null;
  if (componentItem.status !== 'active') {
    blockingRelease = true;
    blockingReason = `Component item ${componentItem.sku} is ${componentItem.status}`;
  }

  await client.query(
    `INSERT INTO bom_line (bom_line_id, revision_id, bom_id, line_no, component_item_id, component_sku, output_class, quantity_per, line_uom, uom_conversion_factor, base_quantity_per, scrap_percent, expected_yield_percent, is_phantom, phantom_source_bom_id, effective_from, effective_to, blocking_release, blocking_reason, source_event_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)`,
    [
      p.bom_line_id,
      p.revision_id,
      p.bom_id,
      p.line_no,
      componentItem.item_id,
      componentItem.sku,
      p.output_class,
      p.quantity_per,
      p.line_uom,
      p.uom_conversion_factor,
      String(Number(p.quantity_per) * Number(p.uom_conversion_factor)),
      p.scrap_percent ?? null,
      p.expected_yield_percent ?? null,
      p.is_phantom,
      p.phantom_source_bom_id ?? null,
      p.effective_from,
      p.effective_to ?? null,
      blockingRelease,
      blockingReason,
      eventId,
    ],
  );

  if (blockingRelease) {
    await client.query(
      'UPDATE bom SET blocking_line_count = blocking_line_count + 1, updated_at = now() WHERE bom_id = $1',
      [p.bom_id],
    );
  }
}

async function applyBomLineAmended(
  envelope: EventEnvelope,
  client: PoolClient,
  _eventId: string,
): Promise<void> {
  if (await alreadyPersisted(envelope, client)) return;

  const p = envelope.payload as unknown as BomLineAmendedPayload;

  const bomRow = await client.query('SELECT * FROM bom WHERE bom_id = $1 FOR UPDATE', [p.bom_id]);
  if (bomRow.rows.length === 0) reject('BOM_NOT_FOUND', 'BOM not found', { bom_id: p.bom_id }, 404);
  if (bomRow.rows[0]!.status !== 'draft')
    reject(
      'BOM_NOT_DRAFT',
      'Can only amend lines on a draft BOM',
      { bom_id: p.bom_id, status: bomRow.rows[0]!.status },
      409,
    );

  await client.query('SELECT 1 FROM bom_revision WHERE revision_id = $1 FOR UPDATE', [
    p.revision_id,
  ]);

  const lineRow = await client.query('SELECT * FROM bom_line WHERE bom_line_id = $1 FOR UPDATE', [
    p.bom_line_id,
  ]);
  if (lineRow.rows.length === 0)
    reject('BOM_LINE_NOT_FOUND', 'BOM line not found', { bom_line_id: p.bom_line_id }, 404);

  const currentLine = lineRow.rows[0]!;

  const sets: string[] = ['amended_at = now()', 'updated_at = now()'];
  const values: unknown[] = [];
  let paramIdx = 1;

  if (p.quantity_per !== undefined) {
    sets.push(`quantity_per = $${paramIdx++}`);
    values.push(p.quantity_per);
    sets.push(`base_quantity_per = $${paramIdx++}`);
    values.push(
      String(
        Number(p.quantity_per) *
          Number(p.uom_conversion_factor ?? currentLine.uom_conversion_factor),
      ),
    );
  }
  if (p.line_uom !== undefined) {
    sets.push(`line_uom = $${paramIdx++}`);
    values.push(p.line_uom);
  }
  if (p.uom_conversion_factor !== undefined) {
    sets.push(`uom_conversion_factor = $${paramIdx++}`);
    values.push(p.uom_conversion_factor);
    if (p.quantity_per !== undefined) {
      sets.push(`base_quantity_per = $${paramIdx++}`);
      values.push(String(Number(p.quantity_per) * Number(p.uom_conversion_factor)));
    } else {
      const currentQtyPer = Number(currentLine.quantity_per);
      sets.push(`base_quantity_per = $${paramIdx++}`);
      values.push(String(currentQtyPer * Number(p.uom_conversion_factor)));
    }
  }
  if (p.scrap_percent !== undefined) {
    sets.push(`scrap_percent = $${paramIdx++}`);
    values.push(p.scrap_percent || null);
  }
  if (p.expected_yield_percent !== undefined) {
    sets.push(`expected_yield_percent = $${paramIdx++}`);
    values.push(p.expected_yield_percent || null);
  }
  if (p.effective_from !== undefined) {
    sets.push(`effective_from = $${paramIdx++}`);
    values.push(p.effective_from);
  }
  if (p.effective_to !== undefined) {
    sets.push(`effective_to = $${paramIdx++}`);
    values.push(p.effective_to || null);
  }

  values.push(p.bom_line_id);

  await client.query(
    `UPDATE bom_line SET ${sets.join(', ')} WHERE bom_line_id = $${paramIdx}`,
    values,
  );
}
