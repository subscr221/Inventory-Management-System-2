import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { EventEnvelope } from '../events/store.js';
import { AppError } from '../middleware/error.js';
import { getItemById } from '../read/projections/item_master.js';
import { releaseBomRevision, updateBomStatus } from '../read/projections/bom.js';
import type {
  BomDraftedPayload,
  BomLineAddedPayload,
  BomLineAmendedPayload,
  BomReleasedPayload,
  BomHeldPayload,
  BomObsoletedPayload,
  LegacyKitMigratedPayload,
} from '../events/schema.js';

const ENGINEERING_STREAM_TYPES = new Set(['engineering']);
const BOM_EVENT_TYPES = new Set([
  'bom.drafted',
  'bom_line.added',
  'bom_line.amended',
  'bom.released',
  'bom.held',
  'bom.obsoleted',
  'bom.migrated_from_kit',
]);

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

/**
 * A-11 predicate (Story 5.1 binding decision, extracted in Story 5.2): item_master has no
 * released state - "released item master" means status = 'active'. Every release-gate,
 * blocking-flag, and migration evaluation MUST go through this single predicate.
 */
export function isReleasedItemMaster(item: { status: string }): boolean {
  return item.status === 'active';
}

/**
 * Story 5.4 execution bar (AC 2): the single definition of the R&D regime block. An R&D draft
 * (bom_type = 'rnd') can never be gate-evaluated, released, or exploded to execution. Story 5.5's
 * explosion service and Epic 6's production-order release call THIS function and must not
 * re-derive the predicate.
 */
export function assertNotRdDraft(bom: { bom_id: string; bom_type: string }): void {
  if (bom.bom_type === 'rnd') {
    reject(
      'RD_EXECUTION_BARRED',
      'R&D draft BOMs are barred from release-gate evaluation and execution',
      { bom_id: bom.bom_id, bom_type: 'rnd' },
      409,
    );
  }
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
    case 'bom.released':
      assertBomReleasedShape(p);
      break;
    case 'bom.held':
    case 'bom.obsoleted':
      assertBomTransitionShape(p);
      break;
    case 'bom.migrated_from_kit':
      assertLegacyKitMigratedShape(p);
      break;
  }
}

function assertBomReleasedShape(p: Record<string, unknown>): void {
  if (!isUuid(p['bom_id'])) reject('INVALID_PARAMS', 'bom_id is required and must be a UUID');
  if (!isUuid(p['revision_id']))
    reject('INVALID_PARAMS', 'revision_id is required and must be a UUID');
  if (p['reason'] !== undefined && !isNonEmptyString(p['reason']))
    reject('INVALID_PARAMS', 'reason must be a non-empty string when provided');
}

function assertBomTransitionShape(p: Record<string, unknown>): void {
  if (!isUuid(p['bom_id'])) reject('INVALID_PARAMS', 'bom_id is required and must be a UUID');
  if (p['reason'] !== undefined && !isNonEmptyString(p['reason']))
    reject('INVALID_PARAMS', 'reason must be a non-empty string when provided');
}

function assertLegacyKitMigratedShape(p: Record<string, unknown>): void {
  if (!isUuid(p['bom_id'])) reject('INVALID_PARAMS', 'bom_id is required and must be a UUID');
  if (!isUuid(p['parent_item_id']))
    reject('INVALID_PARAMS', 'parent_item_id is required and must be a UUID');
  if (!isNonEmptyString(p['kit_ref']))
    reject('INVALID_PARAMS', 'kit_ref is required and must be a non-empty string');
  if (!isNonEmptyString(p['revision_code']))
    reject('INVALID_PARAMS', 'revision_code is required and must be a non-empty string');
  if (p['outcome'] !== 'released' && p['outcome'] !== 'draft_remediation')
    reject('INVALID_PARAMS', 'outcome must be released or draft_remediation');

  const lines = p['lines'];
  if (!Array.isArray(lines) || lines.length === 0)
    reject('BOM_LINE_REQUIRED', 'At least one line is required');
  if (lines.length > 200) reject('INVALID_PARAMS', 'Maximum 200 lines per BOM');
  assertBomLineInputArray(lines as Record<string, unknown>[]);
  // Story 5.4: legacy kit migrations always land as production BOMs, which can never carry
  // placeholder lines - reject at shape time so the applier can rely on component identity.
  for (const line of lines as Record<string, unknown>[]) {
    if (line['is_placeholder'] === true) {
      reject(
        'RD_PLACEHOLDER_NOT_PERMITTED',
        'Placeholder lines are only permitted on R&D draft BOMs',
        { line_no: line['line_no'] },
        400,
      );
    }
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
  assertBomLineInputArray(lines as Record<string, unknown>[]);
}

/**
 * Story 5.4: a line carries EITHER a real component identity (component_item_id UUID) OR a
 * placeholder (is_placeholder true + non-empty free_text, no component identity). Whether a
 * placeholder is ADMISSIBLE (R&D drafts only) is decided in the applier, which can see
 * bom.bom_type - this shape check only enforces internal consistency.
 */
function assertLinePlaceholderIdentity(line: Record<string, unknown>): void {
  const isPlaceholder = line['is_placeholder'];
  if (isPlaceholder !== undefined && typeof isPlaceholder !== 'boolean') {
    reject('INVALID_PARAMS', 'is_placeholder must be a boolean when provided');
  }
  if (isPlaceholder === true) {
    if (line['component_item_id'] !== undefined && line['component_item_id'] !== null) {
      reject('INVALID_PARAMS', 'component_item_id must not be set on a placeholder line');
    }
    if (!isNonEmptyString(line['free_text'])) {
      reject('INVALID_PARAMS', 'free_text is required and must be non-empty on a placeholder line');
    }
  } else {
    if (!isUuid(line['component_item_id'])) {
      reject('INVALID_PARAMS', 'component_item_id is required and must be a UUID');
    }
    if (line['free_text'] !== undefined && line['free_text'] !== null) {
      reject('INVALID_PARAMS', 'free_text is only permitted on placeholder lines');
    }
  }
}

function assertBomLineInputArray(lines: Record<string, unknown>[]): void {
  const seenLineNos = new Set<number>();
  for (const line of lines) {
    const lineNo = line['line_no'];
    if (typeof lineNo !== 'number' || !Number.isInteger(lineNo) || lineNo <= 0) {
      reject('INVALID_PARAMS', 'line_no must be a positive integer');
    }
    if (seenLineNos.has(lineNo)) reject('INVALID_PARAMS', 'Duplicate line_no in request');
    seenLineNos.add(lineNo);

    assertLinePlaceholderIdentity(line);

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
    if (
      !isPhantom &&
      line['phantom_source_bom_id'] !== undefined &&
      line['phantom_source_bom_id'] !== null
    ) {
      reject('INVALID_PARAMS', 'phantom_source_bom_id must not be set when is_phantom is false');
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

  assertLinePlaceholderIdentity(p);

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
    case 'bom.released':
      await applyBomReleased(envelope, client, eventId);
      break;
    case 'bom.held':
      await applyBomHeld(envelope, client, eventId);
      break;
    case 'bom.obsoleted':
      await applyBomObsoleted(envelope, client, eventId);
      break;
    case 'bom.migrated_from_kit':
      await applyLegacyKitMigrated(envelope, client, eventId);
      break;
  }
}

interface GateLineRow {
  bom_line_id: string;
  line_no: number;
  component_item_id: string | null;
  scrap_percent: string | null;
  blocking_release: boolean;
  blocking_reason: string | null;
}

/**
 * Approved-ECO release gate condition (Story 5.3, AC 9). Exemption predicate: count released
 * revisions for this bom_id EXCLUDING the revision under release. Zero means first release of a
 * brand-new BOM - the condition is EXEMPT and reported met (this is what makes initial release
 * achievable with no ECO in existence yet). Otherwise the condition is met only when the
 * revision under release carries source_eco_id and that ECO is approved or implemented. The SAME
 * predicate backs release_gate_checklist.ts - the checklist and the gate can never disagree.
 */
export async function isApprovedEcoConditionMet(
  bomId: string,
  revisionId: string,
  client: Pick<PoolClient, 'query'>,
): Promise<boolean> {
  const priorReleased = await client.query(
    `SELECT COUNT(*) AS cnt FROM bom_revision
      WHERE bom_id = $1 AND revision_status = 'released' AND revision_id <> $2`,
    [bomId, revisionId],
  );
  if (Number(priorReleased.rows[0]!.cnt) === 0) return true;

  const revision = await client.query(
    `SELECT source_eco_id FROM bom_revision WHERE revision_id = $1`,
    [revisionId],
  );
  const sourceEcoId = revision.rows[0]?.source_eco_id as string | null | undefined;
  if (!sourceEcoId) return false;

  const eco = await client.query(`SELECT status FROM eco WHERE eco_id = $1`, [sourceEcoId]);
  const status = eco.rows[0]?.status as string | undefined;
  return status === 'approved' || status === 'implemented';
}

/**
 * Release gate (Story 5.2, D4 staging): enforces released component item masters (A-11) and
 * filled scrap percents, plus the Story 5.3 approved-ECO condition (now enforced). Completed-
 * cost-rollup (Story 5.6) remains a staged condition surfaced with enforced: false. The A-11
 * check re-evaluates EVERY line at release time - blocking flags stamped at line-add time go
 * stale when item masters deactivate.
 */
async function evaluateReleaseGate(
  bomId: string,
  revisionId: string,
  client: PoolClient,
): Promise<{
  unmetConditions: string[];
  blockingLines: { bom_line_id: string; line_no: number }[];
  scrapMissingLines: { bom_line_id: string; line_no: number }[];
}> {
  // Story 5.4 (AC 2): the R&D bar fires FIRST so a direct caller cannot bypass the
  // applyBomReleased check. An R&D draft must never even be gate-evaluated.
  const bomTypeRow = await client.query('SELECT bom_type FROM bom WHERE bom_id = $1', [bomId]);
  if (bomTypeRow.rows.length > 0) {
    assertNotRdDraft({ bom_id: bomId, bom_type: bomTypeRow.rows[0]!.bom_type as string });
  }

  const lineRows = await client.query(
    `SELECT bom_line_id, line_no, component_item_id, scrap_percent, blocking_release, blocking_reason
     FROM bom_line WHERE revision_id = $1 ORDER BY line_no`,
    [revisionId],
  );
  const lines = lineRows.rows as GateLineRow[];
  if (lines.length === 0) {
    reject('BOM_LINE_REQUIRED', 'Cannot release a BOM with no lines', { bom_id: bomId }, 409);
  }

  const blockingLines: { bom_line_id: string; line_no: number }[] = [];
  const scrapMissingLines: { bom_line_id: string; line_no: number }[] = [];

  for (const line of lines) {
    // Placeholder lines carry no component identity (Story 5.4). They are structurally
    // unreachable here (the R&D bar fired above and placeholders are barred from production
    // BOMs), but a NULL must never reach getItemById.
    if (line.component_item_id === null) {
      if (line.scrap_percent === null)
        scrapMissingLines.push({ bom_line_id: line.bom_line_id, line_no: line.line_no });
      continue;
    }
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
    if (blockingRelease !== line.blocking_release || blockingReason !== line.blocking_reason) {
      await client.query(
        'UPDATE bom_line SET blocking_release = $1, blocking_reason = $2, updated_at = now() WHERE bom_line_id = $3',
        [blockingRelease, blockingReason, line.bom_line_id],
      );
    }
    if (blockingRelease)
      blockingLines.push({ bom_line_id: line.bom_line_id, line_no: line.line_no });
    if (line.scrap_percent === null)
      scrapMissingLines.push({ bom_line_id: line.bom_line_id, line_no: line.line_no });
  }

  await client.query(
    'UPDATE bom SET blocking_line_count = $1, updated_at = now() WHERE bom_id = $2',
    [blockingLines.length, bomId],
  );

  const unmetConditions: string[] = [];
  if (blockingLines.length > 0) unmetConditions.push('component_item_masters_released');
  if (scrapMissingLines.length > 0) unmetConditions.push('scrap_percent_missing');
  if (!(await isApprovedEcoConditionMet(bomId, revisionId, client)))
    unmetConditions.push('approved_eco');
  return { unmetConditions, blockingLines, scrapMissingLines };
}

const STAGED_CONDITIONS = [
  { condition: 'cost_rollup_complete', enforced: false, staged_by: 'Story 5.6' },
];

async function applyBomReleased(
  envelope: EventEnvelope,
  client: PoolClient,
  _eventId: string,
): Promise<void> {
  if (await alreadyPersisted(envelope, client)) return;

  const p = envelope.payload as unknown as BomReleasedPayload;

  const bomRow = await client.query('SELECT * FROM bom WHERE bom_id = $1 FOR UPDATE', [p.bom_id]);
  if (bomRow.rows.length === 0) reject('BOM_NOT_FOUND', 'BOM not found', { bom_id: p.bom_id }, 404);
  const bom = bomRow.rows[0]!;

  // Story 5.4 (AC 2): R&D drafts are structurally barred from release before any gate evaluation.
  assertNotRdDraft({ bom_id: p.bom_id, bom_type: bom.bom_type as string });

  if (bom.current_revision_id !== p.revision_id) {
    reject(
      'INVALID_PARAMS',
      'revision_id does not match the current revision of this BOM',
      {
        bom_id: p.bom_id,
        revision_id: p.revision_id,
        current_revision_id: bom.current_revision_id,
      },
      409,
    );
  }

  const status = bom.status as string;
  if (status !== 'draft' && status !== 'on_hold') {
    reject(
      'INVALID_STATE_TRANSITION',
      `Cannot release a BOM in ${status} state`,
      { bom_id: p.bom_id, status, allowed_from: ['draft', 'on_hold'] },
      409,
    );
  }

  const occurredAt = envelope.metadata.occurred_at;
  assertValidOccurredAt(occurredAt);
  const actorId = envelope.metadata.actor.user_id;

  if (status === 'draft') {
    // Full gate on first release. on_hold reinstatement skips it: the revision already passed
    // the gate and is unchanged by definition of immutability.
    const gate = await evaluateReleaseGate(p.bom_id, p.revision_id, client);
    if (gate.unmetConditions.length > 0) {
      reject(
        'RELEASE_GATE_UNMET',
        'Release gate conditions are not met',
        {
          bom_id: p.bom_id,
          unmet_conditions: gate.unmetConditions,
          component_item_masters_released: { blocking_lines: gate.blockingLines },
          scrap_percent_missing: { lines: gate.scrapMissingLines },
          staged_conditions: STAGED_CONDITIONS,
        },
        409,
      );
    }
    await releaseBomRevision(p.revision_id, new Date(occurredAt).toISOString(), actorId, client);
  }

  await updateBomStatus(p.bom_id, 'released', new Date(occurredAt).toISOString(), actorId, client);
}

async function applyBomHeld(
  envelope: EventEnvelope,
  client: PoolClient,
  _eventId: string,
): Promise<void> {
  if (await alreadyPersisted(envelope, client)) return;

  const p = envelope.payload as unknown as BomHeldPayload;

  const bomRow = await client.query('SELECT * FROM bom WHERE bom_id = $1 FOR UPDATE', [p.bom_id]);
  if (bomRow.rows.length === 0) reject('BOM_NOT_FOUND', 'BOM not found', { bom_id: p.bom_id }, 404);
  const status = bomRow.rows[0]!.status as string;
  if (status !== 'released') {
    reject(
      'INVALID_STATE_TRANSITION',
      `Cannot put a BOM in ${status} state on hold`,
      { bom_id: p.bom_id, status, allowed_from: ['released'] },
      409,
    );
  }

  assertValidOccurredAt(envelope.metadata.occurred_at);

  await updateBomStatus(
    p.bom_id,
    'on_hold',
    new Date(envelope.metadata.occurred_at).toISOString(),
    envelope.metadata.actor.user_id,
    client,
  );
}

async function applyBomObsoleted(
  envelope: EventEnvelope,
  client: PoolClient,
  _eventId: string,
): Promise<void> {
  if (await alreadyPersisted(envelope, client)) return;

  const p = envelope.payload as unknown as BomObsoletedPayload;

  const bomRow = await client.query('SELECT * FROM bom WHERE bom_id = $1 FOR UPDATE', [p.bom_id]);
  if (bomRow.rows.length === 0) reject('BOM_NOT_FOUND', 'BOM not found', { bom_id: p.bom_id }, 404);
  const status = bomRow.rows[0]!.status as string;
  if (status !== 'released' && status !== 'on_hold') {
    reject(
      'INVALID_STATE_TRANSITION',
      `Cannot obsolete a BOM in ${status} state`,
      { bom_id: p.bom_id, status, allowed_from: ['released', 'on_hold'] },
      409,
    );
  }

  assertValidOccurredAt(envelope.metadata.occurred_at);

  await updateBomStatus(
    p.bom_id,
    'obsolete',
    new Date(envelope.metadata.occurred_at).toISOString(),
    envelope.metadata.actor.user_id,
    client,
  );
}

async function applyLegacyKitMigrated(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
): Promise<void> {
  if (await alreadyPersisted(envelope, client)) return;

  const p = envelope.payload as unknown as LegacyKitMigratedPayload;

  const existing = await client.query(
    'SELECT 1 FROM bom WHERE bom_id = $1 OR parent_item_id = $2',
    [p.bom_id, p.parent_item_id],
  );
  if (existing.rows.length > 0) {
    reject(
      'DUPLICATE_EVENT',
      'A BOM already exists for this bom_id or parent item',
      { bom_id: p.bom_id, parent_item_id: p.parent_item_id },
      409,
    );
  }

  const parentItem = await getItemById(p.parent_item_id, client);
  if (!parentItem)
    reject(
      'BOM_ITEM_NOT_FOUND',
      'Parent item not found',
      { parent_item_id: p.parent_item_id },
      404,
    );

  const released = p.outcome === 'released';
  assertValidOccurredAt(envelope.metadata.occurred_at);
  const occurredAt = new Date(envelope.metadata.occurred_at).toISOString();
  const actorId = envelope.metadata.actor.user_id;
  const revisionId = randomUUID();

  let blockingCount = 0;
  const lineEvaluations: { blockingRelease: boolean; blockingReason: string | null }[] = [];
  for (const line of p.lines) {
    let blockingRelease = false;
    let blockingReason: string | null = null;
    if (!released) {
      const componentItem = await getItemById(line.component_item_id!, client);
      if (!componentItem) {
        blockingRelease = true;
        blockingReason = `Component item ${line.component_item_id} not found`;
      } else if (!isReleasedItemMaster(componentItem)) {
        blockingRelease = true;
        blockingReason = `Component item ${componentItem.sku} is ${componentItem.status} - BOM cannot be released until item is active`;
      }
      if (blockingRelease) blockingCount++;
    }
    lineEvaluations.push({ blockingRelease, blockingReason });
  }

  await client.query(
    `INSERT INTO bom (bom_id, parent_item_id, parent_sku, parent_uom, business_stream, bom_type, status, current_revision_id, blocking_line_count, status_changed_at, status_changed_by, origin, remediation_flag, kit_ref, created_by, correlation_id, source_event_id)
     VALUES ($1, $2, $3, $4, $5, 'production', $6, $7, $8, $9, $10, 'legacy_kit', $11, $12, $13, $14, $15)`,
    [
      p.bom_id,
      parentItem.item_id,
      parentItem.sku,
      parentItem.uom,
      parentItem.business_stream,
      released ? 'released' : 'draft',
      revisionId,
      blockingCount,
      occurredAt,
      actorId,
      !released,
      p.kit_ref,
      actorId,
      p.correlation_id ?? null,
      eventId,
    ],
  );

  await client.query(
    `INSERT INTO bom_revision (revision_id, bom_id, revision_code, revision_status, drafted_by, drafted_at, released_at, released_by, source_event_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      revisionId,
      p.bom_id,
      p.revision_code,
      released ? 'released' : 'draft',
      actorId,
      occurredAt,
      released ? occurredAt : null,
      released ? actorId : null,
      eventId,
    ],
  );

  for (let i = 0; i < p.lines.length; i++) {
    const line = p.lines[i]!;
    const evaluation = lineEvaluations[i]!;
    const componentItem = await getItemById(line.component_item_id!, client);
    // Migration-exempt released path defaults missing scrap to exact-decimal zero (AC 4).
    const scrapPercent = line.scrap_percent ?? (released ? '0.0000' : null);
    await client.query(
      `INSERT INTO bom_line (bom_line_id, revision_id, bom_id, line_no, component_item_id, component_sku, output_class, quantity_per, line_uom, uom_conversion_factor, base_quantity_per, scrap_percent, expected_yield_percent, is_phantom, phantom_source_bom_id, effective_from, effective_to, blocking_release, blocking_reason, source_event_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::numeric, $9, $10::numeric, $8::numeric * $10::numeric, $11, $12, $13, $14, $15, $16, $17, $18, $19)`,
      [
        randomUUID(),
        revisionId,
        p.bom_id,
        line.line_no,
        line.component_item_id,
        componentItem?.sku ?? line.component_item_id,
        line.output_class,
        line.quantity_per,
        line.line_uom,
        line.uom_conversion_factor,
        scrapPercent,
        line.expected_yield_percent ?? null,
        line.is_phantom,
        line.phantom_source_bom_id ?? null,
        line.effective_from,
        line.effective_to ?? null,
        evaluation.blockingRelease,
        evaluation.blockingReason,
        eventId,
      ],
    );
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
  if (!isReleasedItemMaster(parentItem)) {
    reject(
      'BOM_ITEM_NOT_ACTIVE',
      'Parent item must be active',
      { parent_item_id: p.parent_item_id, status: parentItem.status },
      409,
    );
  }

  const revisionId = randomUUID();
  const occurredAt = envelope.metadata.occurred_at;
  assertValidOccurredAt(occurredAt);

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

  const bomType = p.bom_type ?? 'production';
  let blockingCount = 0;
  for (const line of p.lines) {
    // Story 5.4: placeholder lines are admissible on R&D drafts ONLY. The DB CHECK cannot see
    // bom.bom_type, so this applier guard is the single enforcement point keeping item-less
    // lines off production BOMs. Placeholders skip the item-master lookup entirely and never
    // block or unblock release.
    const isPlaceholder = line.is_placeholder === true;
    if (isPlaceholder && bomType !== 'rnd') {
      reject(
        'RD_PLACEHOLDER_NOT_PERMITTED',
        'Placeholder lines are only permitted on R&D draft BOMs',
        { bom_id: bomId, line_no: line.line_no, bom_type: bomType },
        400,
      );
    }

    let componentItemId: string | null = null;
    let componentSku: string | null = null;
    let blockingRelease = false;
    let blockingReason: string | null = null;
    if (!isPlaceholder) {
      const componentItem = await getItemById(line.component_item_id!, client);
      if (!componentItem) {
        reject(
          'BOM_ITEM_NOT_FOUND',
          'Component item not found',
          { component_item_id: line.component_item_id },
          404,
        );
      }
      componentItemId = componentItem.item_id;
      componentSku = componentItem.sku;
      if (!isReleasedItemMaster(componentItem)) {
        blockingRelease = true;
        blockingReason = `Component item ${componentItem.sku} is ${componentItem.status} - BOM cannot be released until item is active`;
        blockingCount++;
      }
    }

    const bomLineId = randomUUID();
    const effectiveTo = line.effective_to ?? null;

    await client.query(
      `INSERT INTO bom_line (bom_line_id, revision_id, bom_id, line_no, component_item_id, component_sku, is_placeholder, free_text, output_class, quantity_per, line_uom, uom_conversion_factor, base_quantity_per, scrap_percent, expected_yield_percent, is_phantom, phantom_source_bom_id, effective_from, effective_to, blocking_release, blocking_reason, source_event_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $10::numeric * $12::numeric, $13, $14, $15, $16, $17, $18, $19, $20, $21)`,
      [
        bomLineId,
        revisionId,
        bomId,
        line.line_no,
        componentItemId,
        componentSku,
        isPlaceholder,
        isPlaceholder ? line.free_text : null,
        line.output_class,
        line.quantity_per,
        line.line_uom,
        line.uom_conversion_factor,
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

  // Released revisions are immutable (FR-B-03); other non-draft header states keep the
  // Story 5.1 BOM_NOT_DRAFT semantics.
  const revisionRow = await client.query(
    'SELECT revision_status FROM bom_revision WHERE revision_id = $1 FOR UPDATE',
    [p.revision_id],
  );
  if (revisionRow.rows.length > 0 && revisionRow.rows[0]!.revision_status === 'released') {
    reject(
      'IMMUTABLE_REVISION',
      'Released revisions are immutable - changes require an ECO',
      { bom_id: p.bom_id, revision_id: p.revision_id },
      409,
    );
  }
  if (bomRow.rows[0]!.status !== 'draft')
    reject(
      'BOM_NOT_DRAFT',
      'Can only add lines to a draft BOM',
      { bom_id: p.bom_id, status: bomRow.rows[0]!.status },
      409,
    );

  // Story 5.4: placeholder admission guard - see applyBomDrafted. Placeholders skip the
  // item-master lookup and the effectivity-overlap check (both key on component identity) and
  // never affect blocking-line accounting.
  const isPlaceholder = p.is_placeholder === true;
  if (isPlaceholder && bomRow.rows[0]!.bom_type !== 'rnd') {
    reject(
      'RD_PLACEHOLDER_NOT_PERMITTED',
      'Placeholder lines are only permitted on R&D draft BOMs',
      { bom_id: p.bom_id, line_no: p.line_no, bom_type: bomRow.rows[0]!.bom_type },
      400,
    );
  }

  let componentItemId: string | null = null;
  let componentSku: string | null = null;
  let blockingRelease = false;
  let blockingReason: string | null = null;
  if (!isPlaceholder) {
    const componentItem = await getItemById(p.component_item_id!, client);
    if (!componentItem)
      reject(
        'BOM_ITEM_NOT_FOUND',
        'Component item not found',
        { component_item_id: p.component_item_id },
        404,
      );
    componentItemId = componentItem.item_id;
    componentSku = componentItem.sku;
    if (!isReleasedItemMaster(componentItem)) {
      blockingRelease = true;
      blockingReason = `Component item ${componentItem.sku} is ${componentItem.status}`;
    }
  }

  const existingLine = await client.query(
    'SELECT 1 FROM bom_line WHERE revision_id = $1 AND line_no = $2',
    [p.revision_id, p.line_no],
  );
  if (existingLine.rows.length > 0)
    reject('INVALID_PARAMS', 'A line with this line_no already exists in this revision');

  if (!isPlaceholder) {
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
  }

  await client.query(
    `INSERT INTO bom_line (bom_line_id, revision_id, bom_id, line_no, component_item_id, component_sku, is_placeholder, free_text, output_class, quantity_per, line_uom, uom_conversion_factor, base_quantity_per, scrap_percent, expected_yield_percent, is_phantom, phantom_source_bom_id, effective_from, effective_to, blocking_release, blocking_reason, source_event_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $10::numeric * $12::numeric, $13, $14, $15, $16, $17, $18, $19, $20, $21)`,
    [
      p.bom_line_id,
      p.revision_id,
      p.bom_id,
      p.line_no,
      componentItemId,
      componentSku,
      isPlaceholder,
      isPlaceholder ? p.free_text : null,
      p.output_class,
      p.quantity_per,
      p.line_uom,
      p.uom_conversion_factor,
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

  // Released revisions are immutable (FR-B-03); other non-draft header states keep the
  // Story 5.1 BOM_NOT_DRAFT semantics.
  const revisionRow = await client.query(
    'SELECT revision_status FROM bom_revision WHERE revision_id = $1 FOR UPDATE',
    [p.revision_id],
  );
  if (revisionRow.rows.length > 0 && revisionRow.rows[0]!.revision_status === 'released') {
    reject(
      'IMMUTABLE_REVISION',
      'Released revisions are immutable - changes require an ECO',
      { bom_id: p.bom_id, revision_id: p.revision_id },
      409,
    );
  }
  if (bomRow.rows[0]!.status !== 'draft')
    reject(
      'BOM_NOT_DRAFT',
      'Can only amend lines on a draft BOM',
      { bom_id: p.bom_id, status: bomRow.rows[0]!.status },
      409,
    );

  // Story 5.3 (deferred-work.md line 210): filter by revision_id, not just bom_line_id. Without
  // this filter, a stale/foreign bom_line_id targeting an OLDER (released, immutable) revision
  // of the SAME bom_id would still match and be amended in place once this BOM has a second
  // revision - a released-revision immutability violation the earlier one-revision-per-BOM world
  // could never reach.
  const lineRow = await client.query(
    'SELECT * FROM bom_line WHERE bom_line_id = $1 AND revision_id = $2 FOR UPDATE',
    [p.bom_line_id, p.revision_id],
  );
  if (lineRow.rows.length === 0)
    reject(
      'BOM_LINE_NOT_FOUND',
      'BOM line not found in this revision',
      { bom_line_id: p.bom_line_id, revision_id: p.revision_id },
      404,
    );

  const currentLine = lineRow.rows[0]!;

  // Story 5.4: a placeholder line can only ever legitimately exist on an R&D draft; amending one
  // anywhere else means the admission guard was bypassed - fail loudly rather than proceed.
  if (currentLine.is_placeholder === true && bomRow.rows[0]!.bom_type !== 'rnd') {
    reject(
      'RD_PLACEHOLDER_NOT_PERMITTED',
      'Placeholder lines are only permitted on R&D draft BOMs',
      { bom_id: p.bom_id, bom_line_id: p.bom_line_id, bom_type: bomRow.rows[0]!.bom_type },
      400,
    );
  }

  const sets: string[] = ['amended_at = now()', 'updated_at = now()'];
  const values: unknown[] = [];
  let paramIdx = 1;

  // Track the param indices of the NEW quantity_per / uom_conversion_factor so base_quantity_per
  // can be recomputed in PostgreSQL NUMERIC from the new values (Story 5.2 Group 1 binding rule:
  // never JS floats). An UPDATE SET expression references the OLD row, so a factor that is not
  // being changed this call falls back to its column value.
  let qtyPerParam: number | null = null;
  let uomFactorParam: number | null = null;

  if (p.quantity_per !== undefined) {
    qtyPerParam = paramIdx;
    sets.push(`quantity_per = $${paramIdx++}`);
    values.push(p.quantity_per);
  }
  if (p.line_uom !== undefined) {
    sets.push(`line_uom = $${paramIdx++}`);
    values.push(p.line_uom);
  }
  if (p.uom_conversion_factor !== undefined) {
    uomFactorParam = paramIdx;
    sets.push(`uom_conversion_factor = $${paramIdx++}`);
    values.push(p.uom_conversion_factor);
  }
  if (qtyPerParam !== null || uomFactorParam !== null) {
    const qtyExpr = qtyPerParam !== null ? `$${qtyPerParam}::numeric` : 'quantity_per::numeric';
    const factorExpr =
      uomFactorParam !== null ? `$${uomFactorParam}::numeric` : 'uom_conversion_factor::numeric';
    sets.push(`base_quantity_per = ${qtyExpr} * ${factorExpr}`);
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
