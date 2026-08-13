import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool } from '../config/db.js';
import { config } from '../config/index.js';
import { AppError } from '../middleware/error.js';
import { assertNotRdDraft } from '../compliance/bom.js';
import { getBomById } from '../read/projections/bom.js';
import { getOpenAlternatesForLinesOnDate } from '../read/projections/bom_alternate.js';
import { toIstCalendarDate } from '../lib/business-days.js';
import type { BomExplosionAlternate, BomExplosionRequirement } from '../events/schema.js';

/**
 * Story 5.5 BOM explosion service (FR-B-07).
 *
 * `explodeBomForExecution` is the EXPORTED integration surface Epic 6 (FR-MO-03, production-order
 * release) calls; it is deliberately pure - it reads and computes, and performs no persistence, no
 * event emission and no HTTP work, so a caller can run it inside its own transaction by passing a
 * PoolClient. Epic 6 imports this function; it must never re-implement the walk.
 *
 * All arithmetic happens in PostgreSQL NUMERIC inside one recursive CTE. Quantities enter and
 * leave as exact decimal strings - no value is ever converted to a JS float.
 */

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Matches the NUMERIC(18,6) ceiling used across the BOM module. A plain decimal string only -
// hex and scientific notation pass Number() and then die inside PostgreSQL as a raw 500.
const DECIMAL_REGEX = /^\d{1,12}(\.\d{1,6})?$/;
const MAX_ORDER_QUANTITY = '999999999999.999999';

export interface ExplodeBomInput {
  bom_id: string;
  quantity: string;
  occurred_at?: string;
}

export interface ExplosionResult {
  explosion_id: string;
  bom_id: string;
  revision_id: string;
  order_quantity: string;
  business_date: string;
  depth_truncated: boolean;
  requirements: BomExplosionRequirement[];
}

function reject(
  code: string,
  message: string,
  details?: Record<string, unknown>,
  status: number = 400,
): never {
  throw new AppError(status, code, message, details);
}

/**
 * String-only, finite, strictly positive, within NUMERIC(18,6) scale and the module ceiling.
 * Rejected shapes never reach PostgreSQL, so an invalid quantity is a 400, never a 500.
 */
function assertOrderQuantity(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !DECIMAL_REGEX.test(value)) {
    reject(
      'EXPLOSION_QUANTITY_INVALID',
      'quantity is required and must be a positive decimal string with at most 6 decimal places',
      { quantity: typeof value === 'string' ? value : null },
    );
  }
  // The regex already bounds the value to 12 integer digits and 6 decimals, i.e. exactly
  // MAX_ORDER_QUANTITY; only the strictly-positive half needs a separate check.
  if (Number(value) <= 0) {
    reject('EXPLOSION_QUANTITY_INVALID', 'quantity must be strictly positive', {
      quantity: value,
      max: MAX_ORDER_QUANTITY,
    });
  }
}

/**
 * Strict ISO 8601 validation: rejects malformed strings (NaN) AND calendar-impossible dates such
 * as '2021-02-30', which new Date() silently rolls over to March 2 and would otherwise derive a
 * wrong business_date.
 */
function assertOccurredAt(occurredAt: string | undefined): Date {
  if (occurredAt === undefined) return new Date();
  if (typeof occurredAt !== 'string' || Number.isNaN(new Date(occurredAt).getTime())) {
    reject('INVALID_PARAMS', 'occurred_at must be a valid ISO 8601 date string');
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(occurredAt);
  if (match) {
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const utc = new Date(Date.UTC(year, month - 1, day));
    const calendarValid =
      utc.getUTCFullYear() === year && utc.getUTCMonth() === month - 1 && utc.getUTCDate() === day;
    if (!calendarValid) {
      reject('INVALID_PARAMS', 'occurred_at must be a valid ISO 8601 date string');
    }
  }
  return new Date(occurredAt);
}

/**
 * One row of the recursive walk. A row is a single BOM LINE OCCURRENCE; the synthetic root row
 * (is_root) carries the order quantity and the revision the walk starts from.
 */
interface WalkRow {
  is_root: boolean;
  depth: number;
  path: string;
  source_bom_id: string;
  source_revision_id: string;
  bom_line_id: string;
  line_no: number;
  component_item_id: string;
  component_sku: string | null;
  supply_method: 'directed_issue' | 'backflush';
  required_quantity: string;
  scrap_percent: string | null;
  base_quantity_per: string;
  is_phantom: boolean;
  via_phantom: boolean;
  has_child_bom: boolean;
  expandable: boolean;
  is_cycle: boolean;
}

/**
 * The walk descends through:
 *  - a component whose item is the parent item of another Released, non-R&D BOM (multi-level
 *    explosion "to any depth"), and
 *  - a phantom line, which is NEVER itself a requirement: its children are lifted into the parent
 *    with the phantom's scrap-adjusted quantity multiplied through (Story 5.1 phantom model).
 *
 * `visited` carries the chain of BOM ids entered on THIS branch; re-entering one is a cycle, which
 * stops the branch and is reported as BOM_EXPLOSION_CYCLE_DETECTED. This defends the walk only -
 * authoring-time cycle detection (BOM_CYCLE_DETECTED) remains open Story 5.1 debt.
 */
const WALK_SQL = `
WITH RECURSIVE walk AS (
  SELECT
    true                              AS is_root,
    -1                                AS depth,
    ''::text                          AS path,
    $1::uuid                          AS source_bom_id,
    $2::uuid                          AS source_revision_id,
    NULL::uuid                        AS bom_line_id,
    NULL::int                         AS line_no,
    NULL::uuid                        AS component_item_id,
    NULL::text                        AS component_sku,
    NULL::text                        AS supply_method,
    $3::numeric                       AS required_quantity,
    NULL::numeric                     AS scrap_percent,
    NULL::numeric                     AS base_quantity_per,
    false                             AS is_phantom,
    false                             AS via_phantom,
    false                             AS has_child_bom,
    $2::uuid                          AS expand_revision_id,
    $1::uuid                          AS expand_bom_id,
    ARRAY[$1::uuid]                   AS visited,
    false                             AS is_cycle
  UNION ALL
  SELECT
    false,
    w.depth + 1,
    w.path || '/' || l.line_no::text,
    w.expand_bom_id,
    w.expand_revision_id,
    l.bom_line_id,
    l.line_no,
    l.component_item_id,
    l.component_sku,
    l.supply_method,
    (w.required_quantity * l.base_quantity_per * (1 + COALESCE(l.scrap_percent, 0) / 100))::numeric,
    l.scrap_percent,
    l.base_quantity_per,
    l.is_phantom,
    w.is_phantom,
    (cb.bom_id IS NOT NULL),
    CASE
      WHEN tgt.bom_id IS NULL OR tgt.bom_id = ANY (w.visited) THEN NULL::uuid
      ELSE tgt.current_revision_id
    END,
    CASE
      WHEN tgt.bom_id IS NULL OR tgt.bom_id = ANY (w.visited) THEN NULL::uuid
      ELSE tgt.bom_id
    END,
    CASE
      WHEN tgt.bom_id IS NULL OR tgt.bom_id = ANY (w.visited) THEN w.visited
      ELSE w.visited || tgt.bom_id
    END,
    (tgt.bom_id IS NOT NULL AND tgt.bom_id = ANY (w.visited))
  FROM walk w
  JOIN bom_line l
    ON l.revision_id = w.expand_revision_id
   AND l.output_class = 'component'
   AND l.component_item_id IS NOT NULL
   AND l.effective_from <= $4::date
   AND (l.effective_to IS NULL OR l.effective_to >= $4::date)
  LEFT JOIN bom cb
    ON cb.parent_item_id = l.component_item_id
   AND cb.status = 'released'
   AND cb.bom_type <> 'rnd'
   AND cb.current_revision_id IS NOT NULL
  LEFT JOIN bom pb
    ON l.is_phantom
   AND pb.bom_id = l.phantom_source_bom_id
   AND pb.status = 'released'
   AND pb.bom_type <> 'rnd'
   AND pb.current_revision_id IS NOT NULL
  LEFT JOIN bom_revision cb_rev
    ON cb_rev.revision_id = cb.current_revision_id
   AND cb_rev.revision_status = 'released'
  LEFT JOIN bom_revision pb_rev
    ON pb_rev.revision_id = pb.current_revision_id
   AND pb_rev.revision_status = 'released'
  LEFT JOIN LATERAL (
    SELECT
      CASE WHEN l.is_phantom THEN COALESCE(pb.bom_id, cb.bom_id) ELSE cb.bom_id END AS bom_id,
      CASE
        WHEN l.is_phantom THEN COALESCE(pb_rev.revision_id, cb_rev.revision_id)
        ELSE cb_rev.revision_id
      END AS current_revision_id
  ) tgt ON true
  WHERE w.expand_revision_id IS NOT NULL
    AND w.depth + 1 <= $5::int
)
SELECT
  is_root,
  depth,
  path,
  source_bom_id,
  source_revision_id,
  bom_line_id,
  line_no,
  component_item_id,
  component_sku,
  supply_method,
  required_quantity::text AS required_quantity,
  scrap_percent::text     AS scrap_percent,
  base_quantity_per::text AS base_quantity_per,
  is_phantom,
  via_phantom,
  has_child_bom,
  (expand_revision_id IS NOT NULL) AS expandable,
  is_cycle
FROM walk
WHERE NOT is_root
-- Path-order (DFS) semantics with NUMERIC segment comparison: lexicographic 'path ASC' sorts
-- '/1/10' before '/1/2' on BOMs with ten or more sibling lines.
ORDER BY string_to_array(substr(path, 2), '/')::int[] ASC
`;

export async function explodeBomForExecution(
  input: ExplodeBomInput,
  client?: PoolClient,
): Promise<ExplosionResult> {
  if (typeof input?.bom_id !== 'string' || !UUID_REGEX.test(input.bom_id)) {
    reject('INVALID_PARAMS', 'bom_id is required and must be a UUID');
  }

  const runner = client ?? getPool();

  // Guard sequence is fail-closed and order-sensitive: existence, then the Story 5.4 R&D
  // execution bar, then release state, then the quantity contract.
  const bom = await getBomById(input.bom_id, client);
  if (!bom) reject('BOM_NOT_FOUND', 'BOM not found', { bom_id: input.bom_id }, 404);
  assertNotRdDraft(bom);
  if (bom.status !== 'released') {
    reject(
      'BOM_NOT_RELEASED',
      'Only a Released BOM can be exploded to execution',
      { bom_id: bom.bom_id, status: bom.status },
      409,
    );
  }
  if (!bom.current_revision_id) {
    reject(
      'BOM_NOT_RELEASED',
      'BOM has no current revision to explode',
      { bom_id: bom.bom_id },
      409,
    );
  }
  // The walk's descent targets released revisions only (the CTE joins bom_revision with
  // revision_status = 'released'); the top level must hold the same invariant.
  const revisionRow = await runner.query(
    'SELECT revision_status FROM bom_revision WHERE revision_id = $1 AND bom_id = $2',
    [bom.current_revision_id, bom.bom_id],
  );
  if (revisionRow.rows.length === 0 || revisionRow.rows[0]!.revision_status !== 'released') {
    reject(
      'BOM_NOT_RELEASED',
      'The current revision of the BOM is not released',
      { bom_id: bom.bom_id, revision_id: bom.current_revision_id },
      409,
    );
  }
  assertOrderQuantity(input.quantity);

  const businessDate = toIstCalendarDate(assertOccurredAt(input.occurred_at));
  // A depth cap below 1 would silently produce an empty requirement set; fail loudly instead.
  const maxDepth = config.bom.maxDepth;
  if (!Number.isInteger(maxDepth) || maxDepth < 1) {
    reject(
      'INVALID_PARAMS',
      'config.bom.maxDepth must be a positive integer',
      { maxDepth },
      500,
    );
  }

  const result = await runner.query(WALK_SQL, [
    bom.bom_id,
    bom.current_revision_id,
    input.quantity,
    businessDate,
    maxDepth,
  ]);
  const rows = result.rows as WalkRow[];

  const cycle = rows.find((row) => row.is_cycle);
  if (cycle) {
    reject(
      'BOM_EXPLOSION_CYCLE_DETECTED',
      'BOM explosion walk encountered a cycle',
      { bom_id: bom.bom_id, path: cycle.path, component_item_id: cycle.component_item_id },
      409,
    );
  }

  // A branch was cut short only if a row sitting AT the cap still had somewhere to descend.
  const depthTruncated = rows.some((row) => row.depth >= maxDepth && row.expandable);

  // One batched query for every line's open alternates (N+1 avoidance), preserving the per-line
  // priority ASC ordering of AC 1.
  const requirementRows = rows.filter((row) => !row.is_phantom);
  const openAlternates = await getOpenAlternatesForLinesOnDate(
    requirementRows.map((row) => row.bom_line_id),
    businessDate,
    client,
  );
  const alternatesByLine = new Map<string, BomExplosionAlternate[]>();
  for (const alternate of openAlternates) {
    const list = alternatesByLine.get(alternate.bom_line_id) ?? [];
    list.push({
      alternate_item_id: alternate.alternate_item_id,
      alternate_sku: alternate.alternate_sku,
      priority: alternate.priority,
      origin: alternate.origin,
    });
    alternatesByLine.set(alternate.bom_line_id, list);
  }

  const requirements: BomExplosionRequirement[] = [];
  for (const row of requirementRows) {
    requirements.push({
      // Capture-time minted so the applier persists the SAME line ids on replay (deterministic
      // projection rebuilds).
      explosion_line_id: randomUUID(),
      depth: row.depth,
      path: row.path,
      source_bom_id: row.source_bom_id,
      source_revision_id: row.source_revision_id,
      bom_line_id: row.bom_line_id,
      line_no: row.line_no,
      component_item_id: row.component_item_id,
      component_sku: row.component_sku,
      supply_method: row.supply_method,
      required_quantity: row.required_quantity,
      scrap_percent: row.scrap_percent,
      base_quantity_per: row.base_quantity_per,
      has_child_bom: row.has_child_bom,
      via_phantom: row.via_phantom,
      alternates: alternatesByLine.get(row.bom_line_id) ?? [],
    });
  }

  return {
    explosion_id: randomUUID(),
    bom_id: bom.bom_id,
    revision_id: bom.current_revision_id,
    order_quantity: input.quantity,
    business_date: businessDate,
    depth_truncated: depthTruncated,
    requirements,
  };
}
