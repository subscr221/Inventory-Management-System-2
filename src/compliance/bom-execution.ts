import type { PoolClient } from 'pg';
import type { EventEnvelope } from '../events/store.js';
import { AppError } from '../middleware/error.js';
import { getItemById } from '../read/projections/item_master.js';
import { assertNotRdDraft, isReleasedItemMaster } from './bom.js';
import { insertBomAlternate } from '../read/projections/bom_alternate.js';
import { insertExplosion, insertExplosionLine } from '../read/projections/bom_explosion.js';
import type {
  BomAlternateDefinedPayload,
  BomSubstitutionApprovedPayload,
  BomExplodedPayload,
  BomExplosionRequirement,
} from '../events/schema.js';

/**
 * Story 5.5 compliance seam for the BOM execution events (FR-B-12, FR-B-07). Structurally mirrors
 * eco.ts and rd-bom.ts: a synchronous shape assert that runs BEFORE the persist transaction (so a
 * malformed event never consumes an idempotency key) and an async applier that runs INSIDE it.
 *
 * Every state and authority gate lives here rather than in the HTTP handlers, so a direct
 * POST /api/v1/events cannot bypass them.
 */

const ENGINEERING_STREAM_TYPES = new Set(['engineering']);
const BOM_EXECUTION_EVENT_TYPES = new Set([
  'bom.alternate_defined',
  'bom.substitution_approved',
  'bom.exploded',
]);

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_REGEX = /^(\d{4})-(\d{2})-(\d{2})$/;
// Shape-gate decimal strings only: hex and scientific notation pass Number() and then die inside
// PostgreSQL as a raw 500. Each regex is bounded to its receiving column's precision so
// PostgreSQL never silently rounds or overflows.
const ORDER_QTY_REGEX = /^\d{1,12}(\.\d{1,6})?$/;
const REQUIRED_QTY_REGEX = /^\d{1,100}(\.\d{1,100})?$/;
const BASE_QTY_REGEX = /^\d{1,10}(\.\d{1,8})?$/;
const SCRAP_REGEX = /^\d{1,3}(\.\d{1,6})?$/;
const MAX_PRIORITY = 2147483647;
const SUPPLY_METHODS = new Set(['directed_issue', 'backflush']);

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_REGEX.test(value);
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

export function bomExecutionEventType(envelope: EventEnvelope): string | null {
  if (!ENGINEERING_STREAM_TYPES.has(envelope.stream_type)) return null;
  if (!BOM_EXECUTION_EVENT_TYPES.has(envelope.event_type)) return null;
  return envelope.event_type;
}

export function assertBomExecutionShape(envelope: EventEnvelope): void {
  const type = bomExecutionEventType(envelope);
  if (!type) return;
  const p = envelope.payload as Record<string, unknown>;

  switch (type) {
    case 'bom.alternate_defined':
      assertAlternateShape(p, 'approved');
      break;
    case 'bom.substitution_approved':
      assertAlternateShape(p, 'ad_hoc');
      break;
    case 'bom.exploded':
      assertExplodedShape(p);
      break;
  }
}

function assertAlternateShape(p: Record<string, unknown>, origin: 'approved' | 'ad_hoc'): void {
  if (!isUuid(p['bom_alternate_id']))
    reject('INVALID_PARAMS', 'bom_alternate_id is required and must be a UUID');
  if (!isUuid(p['bom_id'])) reject('INVALID_PARAMS', 'bom_id is required and must be a UUID');
  if (!isUuid(p['revision_id']))
    reject('INVALID_PARAMS', 'revision_id is required and must be a UUID');
  if (!isUuid(p['bom_line_id']))
    reject('INVALID_PARAMS', 'bom_line_id is required and must be a UUID');
  if (!isUuid(p['component_item_id']))
    reject('INVALID_PARAMS', 'component_item_id is required and must be a UUID');
  if (!isUuid(p['alternate_item_id']))
    reject('INVALID_PARAMS', 'alternate_item_id is required and must be a UUID');
  if (p['alternate_item_id'] === p['component_item_id']) {
    reject('INVALID_PARAMS', 'alternate_item_id must differ from component_item_id');
  }

  const lineNo = p['line_no'];
  if (typeof lineNo !== 'number' || !Number.isInteger(lineNo) || lineNo <= 0) {
    reject('INVALID_PARAMS', 'line_no must be a positive integer');
  }

  const priority = p['priority'];
  if (
    typeof priority !== 'number' ||
    !Number.isInteger(priority) ||
    priority < 1 ||
    priority > MAX_PRIORITY
  ) {
    reject('INVALID_PARAMS', `priority must be an integer between 1 and ${MAX_PRIORITY}`);
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
  if (
    typeof p['effective_to'] === 'string' &&
    typeof p['effective_from'] === 'string' &&
    p['effective_to'] < p['effective_from']
  ) {
    reject('INVALID_PARAMS', 'effective_to must be on or after effective_from');
  }

  if (p['origin'] !== origin) {
    reject('INVALID_PARAMS', `origin must be '${origin}' for this event type`);
  }

  // The ad-hoc pairing is a hard requirement, not an optional field: a substitution without its
  // resolved DOA evidence is exactly the unlogged approval FR-DOA-01 forbids.
  if (origin === 'ad_hoc') {
    if (!isUuid(p['doa_entry_id']))
      reject('INVALID_PARAMS', 'doa_entry_id is required and must be a UUID for ad-hoc origin');
    if (!isUuid(p['approver_actor_id'])) {
      reject(
        'INVALID_PARAMS',
        'approver_actor_id is required and must be a UUID for ad-hoc origin',
      );
    }
  } else {
    if (p['doa_entry_id'] !== undefined && p['doa_entry_id'] !== null)
      reject('INVALID_PARAMS', 'doa_entry_id must not be set for approved origin');
    if (p['approver_actor_id'] !== undefined && p['approver_actor_id'] !== null)
      reject('INVALID_PARAMS', 'approver_actor_id must not be set for approved origin');
  }
}

function assertExplodedShape(p: Record<string, unknown>): void {
  if (!isUuid(p['explosion_id']))
    reject('INVALID_PARAMS', 'explosion_id is required and must be a UUID');
  if (!isUuid(p['bom_id'])) reject('INVALID_PARAMS', 'bom_id is required and must be a UUID');
  if (!isUuid(p['revision_id']))
    reject('INVALID_PARAMS', 'revision_id is required and must be a UUID');

  const quantity = p['order_quantity'];
  if (typeof quantity !== 'string' || !ORDER_QTY_REGEX.test(quantity) || Number(quantity) <= 0) {
    reject('EXPLOSION_QUANTITY_INVALID', 'order_quantity must be a positive decimal string');
  }

  if (!isDateString(p['business_date']))
    reject('INVALID_PARAMS', 'business_date is required and must be a YYYY-MM-DD date');
  if (typeof p['depth_truncated'] !== 'boolean')
    reject('INVALID_PARAMS', 'depth_truncated must be a boolean');

  const requirements = p['requirements'];
  if (!Array.isArray(requirements))
    reject('INVALID_PARAMS', 'requirements must be an array of requirement rows');
  for (const raw of requirements as unknown[]) {
    if (typeof raw !== 'object' || raw === null)
      reject('INVALID_PARAMS', 'each requirement must be an object');
    assertRequirementShape(raw as Record<string, unknown>);
  }
}

function assertRequirementShape(r: Record<string, unknown>): void {
  // explosion_line_id is capture-minted and travels in the payload (replay determinism).
  if (!isUuid(r['explosion_line_id']))
    reject('INVALID_PARAMS', 'requirement explosion_line_id must be a UUID');
  const depth = r['depth'];
  if (typeof depth !== 'number' || !Number.isInteger(depth) || depth < 0)
    reject('INVALID_PARAMS', 'requirement depth must be an integer greater than or equal to 0');
  if (typeof r['path'] !== 'string' || r['path'].length === 0)
    reject('INVALID_PARAMS', 'requirement path is required');
  if (!isUuid(r['source_bom_id']))
    reject('INVALID_PARAMS', 'requirement source_bom_id must be a UUID');
  if (!isUuid(r['source_revision_id']))
    reject('INVALID_PARAMS', 'requirement source_revision_id must be a UUID');
  if (!isUuid(r['bom_line_id'])) reject('INVALID_PARAMS', 'requirement bom_line_id must be a UUID');
  if (!isUuid(r['component_item_id']))
    reject('INVALID_PARAMS', 'requirement component_item_id must be a UUID');

  const lineNo = r['line_no'];
  if (typeof lineNo !== 'number' || !Number.isInteger(lineNo) || lineNo <= 0)
    reject('INVALID_PARAMS', 'requirement line_no must be a positive integer');

  if (typeof r['supply_method'] !== 'string' || !SUPPLY_METHODS.has(r['supply_method']))
    reject('INVALID_PARAMS', "requirement supply_method must be 'directed_issue' or 'backflush'");

  const required = r['required_quantity'];
  if (typeof required !== 'string' || !REQUIRED_QTY_REGEX.test(required) || Number(required) <= 0)
    reject('INVALID_PARAMS', 'requirement required_quantity must be a positive decimal string');

  const base = r['base_quantity_per'];
  if (typeof base !== 'string' || !BASE_QTY_REGEX.test(base))
    reject('INVALID_PARAMS', 'requirement base_quantity_per must be a decimal string');

  const scrap = r['scrap_percent'];
  if (
    scrap !== null &&
    scrap !== undefined &&
    (typeof scrap !== 'string' || !SCRAP_REGEX.test(scrap))
  )
    reject('INVALID_PARAMS', 'requirement scrap_percent must be a decimal string or null');

  if (typeof r['has_child_bom'] !== 'boolean')
    reject('INVALID_PARAMS', 'requirement has_child_bom must be a boolean');
  if (typeof r['via_phantom'] !== 'boolean')
    reject('INVALID_PARAMS', 'requirement via_phantom must be a boolean');

  const alternates = r['alternates'];
  if (!Array.isArray(alternates)) {
    reject('INVALID_PARAMS', 'requirement alternates must be an array');
  }
  for (const raw of alternates as unknown[]) {
    if (typeof raw !== 'object' || raw === null)
      reject('INVALID_PARAMS', 'each requirement alternate must be an object');
    const alt = raw as Record<string, unknown>;
    if (!isUuid(alt['alternate_item_id']))
      reject('INVALID_PARAMS', 'requirement alternate alternate_item_id must be a UUID');
    const altPriority = alt['priority'];
    if (
      typeof altPriority !== 'number' ||
      !Number.isInteger(altPriority) ||
      altPriority < 1 ||
      altPriority > MAX_PRIORITY
    )
      reject(
        'INVALID_PARAMS',
        `requirement alternate priority must be an integer between 1 and ${MAX_PRIORITY}`,
      );
    if (alt['origin'] !== 'approved' && alt['origin'] !== 'ad_hoc')
      reject('INVALID_PARAMS', "requirement alternate origin must be 'approved' or 'ad_hoc'");
    if (
      alt['alternate_sku'] !== null &&
      (typeof alt['alternate_sku'] !== 'string' || alt['alternate_sku'].length === 0)
    )
      reject(
        'INVALID_PARAMS',
        'requirement alternate alternate_sku must be a non-empty string or null',
      );
  }
}

async function alreadyPersisted(envelope: EventEnvelope, client: PoolClient): Promise<boolean> {
  if (!envelope.idempotency_key && !envelope.event_id) return false;
  const existing = await client.query(
    `SELECT 1 FROM domain_events WHERE ($1::text IS NOT NULL AND idempotency_key = $1) OR event_id = $2 LIMIT 1`,
    [envelope.idempotency_key ?? null, envelope.event_id ?? null],
  );
  return existing.rows.length > 0;
}

export async function applyBomExecutionProjection(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
): Promise<void> {
  const type = bomExecutionEventType(envelope);
  if (!type) return;

  switch (type) {
    case 'bom.alternate_defined':
    case 'bom.substitution_approved':
      await applyBomAlternate(envelope, client, eventId);
      break;
    case 'bom.exploded':
      await applyBomExploded(envelope, client, eventId);
      break;
  }
}

/**
 * Locks the BOM, its current revision and the target line, then runs every alternate gate. Shared
 * verbatim by bom.alternate_defined and bom.substitution_approved: the two events differ only in
 * their origin and DOA evidence, which the shape assert has already pinned.
 */
async function applyBomAlternate(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
): Promise<void> {
  if (await alreadyPersisted(envelope, client)) return;

  const p = envelope.payload as unknown as
    BomAlternateDefinedPayload | BomSubstitutionApprovedPayload;

  const bomRow = await client.query('SELECT * FROM bom WHERE bom_id = $1 FOR UPDATE', [p.bom_id]);
  if (bomRow.rows.length === 0) reject('BOM_NOT_FOUND', 'BOM not found', { bom_id: p.bom_id }, 404);
  // Post-lock re-check: a concurrent same-key retry may have committed while we waited.
  if (await alreadyPersisted(envelope, client)) return;

  const bom = bomRow.rows[0]!;
  assertNotRdDraft(bom);
  if (bom.status !== 'released') {
    reject(
      'BOM_NOT_RELEASED',
      'Alternates can only be defined on a Released BOM',
      { bom_id: p.bom_id, status: bom.status },
      409,
    );
  }

  const revisionRow = await client.query(
    'SELECT * FROM bom_revision WHERE revision_id = $1 AND bom_id = $2 FOR UPDATE',
    [p.revision_id, p.bom_id],
  );
  if (
    revisionRow.rows.length === 0 ||
    revisionRow.rows[0]!.revision_status !== 'released' ||
    bom.current_revision_id !== p.revision_id
  ) {
    reject(
      'INVALID_PARAMS',
      'revision_id must be the current released revision of the BOM',
      {
        bom_id: p.bom_id,
        revision_id: p.revision_id,
        current_revision_id: bom.current_revision_id,
      },
      409,
    );
  }

  // Story 5.3 cross-revision scoping rule: a line lookup is ALWAYS scoped by revision_id.
  const lineRow = await client.query(
    'SELECT * FROM bom_line WHERE bom_line_id = $1 AND revision_id = $2 FOR UPDATE',
    [p.bom_line_id, p.revision_id],
  );
  if (lineRow.rows.length === 0) {
    reject(
      'BOM_LINE_NOT_FOUND',
      'BOM line not found on this revision',
      { bom_line_id: p.bom_line_id, revision_id: p.revision_id },
      404,
    );
  }
  const line = lineRow.rows[0]!;
  if (line.component_item_id === null) {
    reject(
      'INVALID_PARAMS',
      'A placeholder line has no component identity and cannot carry alternates',
      { bom_line_id: p.bom_line_id },
    );
  }
  if (line.is_phantom) {
    reject(
      'INVALID_PARAMS',
      'A phantom line is a pass-through and never becomes a requirement, so it cannot carry alternates',
      { bom_line_id: p.bom_line_id },
    );
  }
  if (line.component_item_id !== p.component_item_id || line.line_no !== p.line_no) {
    reject(
      'INVALID_PARAMS',
      'component_item_id and line_no must match the BOM line',
      {
        bom_line_id: p.bom_line_id,
        component_item_id: line.component_item_id,
        line_no: line.line_no,
      },
      409,
    );
  }

  const alternateItem = await getItemById(p.alternate_item_id, client);
  if (!alternateItem || !isReleasedItemMaster(alternateItem)) {
    reject(
      'BOM_ITEM_NOT_ACTIVE',
      'Alternate item master must exist and be active',
      { alternate_item_id: p.alternate_item_id, status: alternateItem?.status ?? null },
      409,
    );
  }

  // Date columns are selected as ::text so effectivity windows are compared as YYYY-MM-DD
  // strings, never via a JS Date round-trip: node-pg parses DATE as local midnight, and
  // toISOString() shifts it one calendar day back on any east-of-UTC server.
  const existing = await client.query(
    `SELECT bom_alternate_id, alternate_item_id, priority, origin,
            effective_from::text AS effective_from, effective_to::text AS effective_to
       FROM bom_alternate WHERE bom_line_id = $1 FOR UPDATE`,
    [p.bom_line_id],
  );

  for (const row of existing.rows) {
    if (row.alternate_item_id === p.alternate_item_id) {
      // An ad-hoc substitution for an item already on the EFFECTIVE approved list is a governance
      // error, not an overlap: the approved entry is already available to execution. A closed
      // window means the item is not on the effective list (the execution read model agrees), so
      // a substitution whose window does not intersect it is legitimate.
      if (p.origin === 'ad_hoc' && row.origin === 'approved' && windowsOverlap(row, p)) {
        reject(
          'ALTERNATE_ALREADY_APPROVED',
          'This item is already an approved alternate for the line; no substitution approval is required',
          { bom_line_id: p.bom_line_id, alternate_item_id: p.alternate_item_id },
          409,
        );
      }
      if (windowsOverlap(row, p)) {
        reject(
          'EFFECTIVITY_OVERLAP',
          'Overlapping effectivity window for the same alternate item on this line',
          {
            bom_alternate_id: row.bom_alternate_id,
            conflicting_effective_from: row.effective_from,
            conflicting_effective_to: row.effective_to,
          },
          409,
        );
      }
    }
    // Priority is a per-line execution contract (AC 1): two alternates holding the same priority
    // must never be simultaneously available, so the conflict is window-overlap-aware - a
    // same-priority alternate whose window never intersects this one cannot create a tie.
    if (row.priority === p.priority && windowsOverlap(row, p)) {
      reject(
        'ALTERNATE_PRIORITY_CONFLICT',
        'Another alternate on this line whose window overlaps this one already holds this priority',
        {
          bom_alternate_id: row.bom_alternate_id,
          priority: p.priority,
          alternate_item_id: row.alternate_item_id,
        },
        409,
      );
    }
  }

  await insertBomAlternate(
    {
      bom_alternate_id: p.bom_alternate_id,
      bom_id: p.bom_id,
      revision_id: p.revision_id,
      bom_line_id: p.bom_line_id,
      line_no: p.line_no,
      component_item_id: p.component_item_id,
      alternate_item_id: p.alternate_item_id,
      alternate_sku: alternateItem.sku,
      priority: p.priority,
      effective_from: p.effective_from,
      effective_to: p.effective_to ?? null,
      origin: p.origin,
      doa_entry_id: p.origin === 'ad_hoc' ? p.doa_entry_id : null,
      approver_actor_id: p.origin === 'ad_hoc' ? p.approver_actor_id : null,
      defined_by: envelope.metadata.actor.user_id,
      source_event_id: eventId,
    },
    client,
  );
}

/**
 * Half-open-aware overlap: a NULL effective_to means "open ended", so it overlaps everything from
 * its start onwards. Both sides are YYYY-MM-DD strings (existing rows are selected with ::text
 * casts), which sort as dates.
 */
function windowsOverlap(
  existing: { effective_from: unknown; effective_to: unknown },
  incoming: { effective_from: string; effective_to: string | null },
): boolean {
  const existingFrom = toDateString(existing.effective_from);
  const existingTo = toDateString(existing.effective_to);
  const incomingTo = incoming.effective_to ?? null;
  if (existingTo !== null && existingTo < incoming.effective_from) return false;
  if (incomingTo !== null && existingFrom !== null && incomingTo < existingFrom) return false;
  return true;
}

function toDateString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return String(value).slice(0, 10);
}

/**
 * Persists an explosion run EXACTLY as captured. The explosion math ran at capture time in
 * src/engineering/bom-explosion.ts and travels inside the payload, so replay is byte-deterministic
 * and this applier recomputes nothing.
 */
async function applyBomExploded(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
): Promise<void> {
  if (await alreadyPersisted(envelope, client)) return;

  const p = envelope.payload as unknown as BomExplodedPayload;

  const bomRow = await client.query('SELECT * FROM bom WHERE bom_id = $1 FOR UPDATE', [p.bom_id]);
  if (bomRow.rows.length === 0) reject('BOM_NOT_FOUND', 'BOM not found', { bom_id: p.bom_id }, 404);
  if (await alreadyPersisted(envelope, client)) return;

  const bom = bomRow.rows[0]!;
  assertNotRdDraft(bom);
  if (bom.status !== 'released') {
    reject(
      'BOM_NOT_RELEASED',
      'Only a Released BOM can be exploded to execution',
      { bom_id: p.bom_id, status: bom.status },
      409,
    );
  }
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

  const requirements: BomExplosionRequirement[] = p.requirements;
  const requirementCount = requirements.length;

  await insertExplosion(
    {
      explosion_id: p.explosion_id,
      bom_id: p.bom_id,
      revision_id: p.revision_id,
      order_quantity: p.order_quantity,
      business_date: p.business_date,
      depth_truncated: p.depth_truncated,
      requirement_count: requirementCount,
      exploded_by: envelope.metadata.actor.user_id,
      correlation_id: p.correlation_id ?? null,
      source_event_id: eventId,
    },
    client,
  );

  for (const requirement of requirements) {
    await insertExplosionLine(
      {
        // The line id was minted at CAPTURE time and embedded in the payload, so a projection
        // rebuild replays the same rows (capture-time-minted-IDs replay rule).
        explosion_line_id: requirement.explosion_line_id,
        explosion_id: p.explosion_id,
        depth: requirement.depth,
        path: requirement.path,
        source_bom_id: requirement.source_bom_id,
        source_revision_id: requirement.source_revision_id,
        bom_line_id: requirement.bom_line_id,
        line_no: requirement.line_no,
        component_item_id: requirement.component_item_id,
        component_sku: requirement.component_sku ?? null,
        supply_method: requirement.supply_method,
        required_quantity: requirement.required_quantity,
        scrap_percent: requirement.scrap_percent ?? null,
        base_quantity_per: requirement.base_quantity_per,
        has_child_bom: requirement.has_child_bom,
        via_phantom: requirement.via_phantom,
        alternates: requirement.alternates,
        source_event_id: eventId,
      },
      client,
    );
  }

  const persistedCount = await client.query(
    'SELECT COUNT(*)::int AS cnt FROM bom_explosion_line WHERE explosion_id = $1',
    [p.explosion_id],
  );
  if (Number(persistedCount.rows[0]!.cnt) !== requirementCount) {
    reject(
      'INVALID_PARAMS',
      'Persisted requirement rows do not match the captured requirement count',
      { explosion_id: p.explosion_id, requirement_count: requirementCount },
      409,
    );
  }
}
