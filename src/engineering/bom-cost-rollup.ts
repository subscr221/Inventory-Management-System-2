import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool } from '../config/db.js';
import { config } from '../config/index.js';
import { AppError } from '../middleware/error.js';
import { assertNotRdDraft } from '../compliance/bom.js';
import { getBomById } from '../read/projections/bom.js';
import { toIstCalendarDate } from '../lib/business-days.js';
import type { BomCostRollupLine } from '../events/schema.js';

/**
 * Story 5.6 BOM cost rollup service (FR-B-15).
 *
 * `rollUpBomCost` is a pure read-plus-compute surface, deliberately shaped like
 * src/engineering/bom-explosion.ts: it reads and computes, performs no persistence, no event
 * emission and no HTTP work, and takes an optional PoolClient so a caller (the release gate, a
 * future auto-rollup) can run it inside its own transaction.
 *
 * CRITICAL DIFFERENCE FROM THE EXPLOSION SERVICE: a rollup MUST run against draft and on_hold
 * BOMs. A completed rollup is a precondition of release (AC 3), so copying explosion's
 * BOM_NOT_RELEASED guard would make the release gate unreachable.
 *
 * A rollup is a SIMULATION (C-10): it posts no valuation, sets no standard cost, and never writes
 * a rate. Rates are inbound-only reference data owned by INT-ERP-01.
 *
 * All arithmetic happens in PostgreSQL NUMERIC. Costs and quantities enter and leave as exact
 * decimal strings - no value is ever converted to a JS float.
 */

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The ONLY permitted rate source, and the only designation that makes a rate usable (Story 2.4). */
export const IND_AS_2_DESIGNATION = 'ind_as_2_para_21_measurement_technique';
export const COST_ROLLUP_RATE_BASIS = 'item_master_standard_cost';

export interface RollUpBomCostInput {
  bom_id: string;
  occurred_at?: string;
}

export interface CostRollupResult {
  rollup_id: string;
  bom_id: string;
  revision_id: string;
  rollup_date: string;
  rate_basis: 'item_master_standard_cost';
  total_cost: string;
  line_count: number;
  missing_rate_count: number;
  depth_truncated: boolean;
  lines: BomCostRollupLine[];
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
 * Strict ISO 8601 validation: rejects malformed strings (NaN) AND calendar-impossible dates such
 * as '2021-02-30', which new Date() silently rolls over and would otherwise derive a wrong
 * rollup_date.
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

/** One row of the recursive walk. A row is a single BOM LINE OCCURRENCE. */
interface WalkRow {
  is_root: boolean;
  depth: number;
  path: string;
  source_bom_id: string;
  source_revision_id: string;
  bom_line_id: string;
  line_no: number;
  component_item_id: string | null;
  component_sku: string | null;
  effective_quantity_per: string;
  scrap_percent: string | null;
  unit_cost: string | null;
  extended_cost: string;
  is_phantom: boolean;
  via_phantom: boolean;
  has_child_bom: boolean;
  expandable: boolean;
  is_cycle: boolean;
}

/**
 * The walk descends through:
 *  - a component whose item is the parent item of another non-R&D BOM with a current revision
 *    (multi-level rollup to any depth), and
 *  - a phantom line, which is NEVER itself a costed line: its children are lifted into the parent
 *    with the phantom's scrap-adjusted quantity multiplied through (Story 5.1 phantom model).
 *
 * The BOM AT THE TOP of the walk may be draft or on_hold - a rollup is a release-gate input and
 * must run on a draft, which is the single most important difference from the Story 5.5 explosion
 * service. DESCENT, however, targets RELEASED child BOMs only, exactly as the explosion walk does:
 * a released sub-assembly is the authoritative structure to cost through, an unreleased one is
 * still being authored. A component whose only child BOM is a draft is therefore costed as a
 * purchased part from its own rate (or recorded rate_missing), which is also what keeps a
 * self-referential draft from tripping the cycle guard on its own first release.
 *
 * `visited` carries the chain of BOM ids entered on THIS branch; re-entering one is a cycle, which
 * stops the branch and is reported as BOM_COST_ROLLUP_CYCLE_DETECTED. The PG CYCLE clause is
 * deliberately NOT used - it keys on a column value and sibling lines legitimately share
 * source_bom_id at the same level, which would false-positive on every level-1 row (Story 5.5
 * completion note).
 *
 * unit_cost is sourced from item_master.standard_cost_amount and ONLY when the Ind AS 2 designation
 * is present alongside it (the existing chk_item_master_standard_cost_requires_designation
 * pairing). A component with no usable rate yields unit_cost NULL and extended_cost 0 - the rollup
 * NEVER fails on a missing rate and NEVER writes one.
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
    1::numeric                        AS effective_quantity_per,
    NULL::numeric                     AS scrap_percent,
    NULL::numeric                     AS unit_cost,
    0::numeric                        AS extended_cost,
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
    (w.effective_quantity_per * l.base_quantity_per * (1 + COALESCE(l.scrap_percent, 0) / 100))::numeric,
    l.scrap_percent,
    im.standard_cost_amount,
    COALESCE(
      (w.effective_quantity_per * l.base_quantity_per * (1 + COALESCE(l.scrap_percent, 0) / 100))
        * im.standard_cost_amount,
      0
    )::numeric,
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
   AND l.effective_from <= $3::date
   AND (l.effective_to IS NULL OR l.effective_to >= $3::date)
  LEFT JOIN item_master im
    ON im.item_id = l.component_item_id
   AND im.standard_cost_designation = $5::text
   AND im.standard_cost_amount IS NOT NULL
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
    AND w.depth + 1 <= $4::int
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
  effective_quantity_per::text AS effective_quantity_per,
  scrap_percent::text          AS scrap_percent,
  unit_cost::text              AS unit_cost,
  extended_cost::text          AS extended_cost,
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

/** Sums decimal strings in PostgreSQL NUMERIC - never in JS floats (binding NUMERIC discipline). */
async function sumNumeric(values: string[], runner: Pick<PoolClient, 'query'>): Promise<string> {
  if (values.length === 0) return '0';
  const result = await runner.query(
    `SELECT COALESCE(SUM(v::numeric), 0)::text AS total FROM unnest($1::text[]) AS v`,
    [values],
  );
  return result.rows[0]!.total as string;
}

export async function rollUpBomCost(
  input: RollUpBomCostInput,
  client?: PoolClient,
): Promise<CostRollupResult> {
  if (typeof input?.bom_id !== 'string' || !UUID_REGEX.test(input.bom_id)) {
    reject('INVALID_PARAMS', 'bom_id is required and must be a UUID');
  }

  const runner = client ?? getPool();

  // Guard sequence is fail-closed and order-sensitive: existence, then the Story 5.4 R&D execution
  // bar (a rollup is a release-gate input and an R&D draft can never be released), then a current
  // revision. Deliberately NO release-state guard - see the module comment.
  const bom = await getBomById(input.bom_id, client);
  if (!bom) reject('BOM_NOT_FOUND', 'BOM not found', { bom_id: input.bom_id }, 404);
  assertNotRdDraft(bom);
  if (!bom.current_revision_id) {
    reject('INVALID_PARAMS', 'BOM has no current revision to roll up', { bom_id: bom.bom_id }, 409);
  }

  const rollupDate = toIstCalendarDate(assertOccurredAt(input.occurred_at));
  // A depth cap below 1 would silently produce an empty cost set; fail loudly instead.
  const maxDepth = config.bom.maxDepth;
  if (!Number.isInteger(maxDepth) || maxDepth < 1) {
    reject('INVALID_PARAMS', 'config.bom.maxDepth must be a positive integer', { maxDepth }, 500);
  }

  const result = await runner.query(WALK_SQL, [
    bom.bom_id,
    bom.current_revision_id,
    rollupDate,
    maxDepth,
    IND_AS_2_DESIGNATION,
  ]);
  const rows = result.rows as WalkRow[];

  const cycle = rows.find((row) => row.is_cycle);
  if (cycle) {
    reject(
      'BOM_COST_ROLLUP_CYCLE_DETECTED',
      'BOM cost rollup walk encountered a cycle',
      { bom_id: bom.bom_id, path: cycle.path, component_item_id: cycle.component_item_id },
      409,
    );
  }

  // A branch was cut short only if a row sitting AT the cap still had somewhere to descend.
  const depthTruncated = rows.some((row) => row.depth >= maxDepth && row.expandable);

  // A phantom line is a pass-through: it is never itself a costed line, its children are.
  const costedRows = rows.filter((row) => !row.is_phantom);

  // Double-counting defense: a line whose costed descendants exist contributes ZERO itself - only
  // leaves carry cost. Descendant (not just direct-child) matching is what keeps a phantom in the
  // middle of a chain from stranding the cost of the subtree beneath it.
  const paths = costedRows.map((row) => row.path);
  const carriesOwnCost = (row: WalkRow): boolean =>
    !paths.some((other) => other.startsWith(`${row.path}/`));

  const lines: BomCostRollupLine[] = [];
  const contributingCosts: string[] = [];
  let missingRateCount = 0;
  for (const row of costedRows) {
    const isLeaf = carriesOwnCost(row);
    // rate_missing is a LEAF property: a parent node whose cost comes from its children is never
    // counted as a missing rate, and a subtree whose leaves all lack rates surfaces through those
    // leaves. Same rule for extended_cost, which is zeroed on a non-contributing parent.
    const rateMissing = isLeaf && row.unit_cost === null;
    if (rateMissing) missingRateCount += 1;
    const extendedCost = isLeaf ? row.extended_cost : '0';
    if (isLeaf) contributingCosts.push(extendedCost);
    lines.push({
      // Capture-time minted so the applier persists the SAME line ids on replay (deterministic
      // projection rebuilds).
      rollup_line_id: randomUUID(),
      depth: row.depth,
      path: row.path,
      source_bom_id: row.source_bom_id,
      source_revision_id: row.source_revision_id,
      bom_line_id: row.bom_line_id,
      line_no: row.line_no,
      component_item_id: row.component_item_id,
      component_sku: row.component_sku,
      effective_quantity_per: row.effective_quantity_per,
      scrap_percent: row.scrap_percent,
      unit_cost: isLeaf ? row.unit_cost : null,
      extended_cost: extendedCost,
      rate_missing: rateMissing,
      via_phantom: row.via_phantom,
      has_child_bom: row.has_child_bom,
    });
  }

  const totalCost = await sumNumeric(contributingCosts, runner);

  return {
    rollup_id: randomUUID(),
    bom_id: bom.bom_id,
    revision_id: bom.current_revision_id,
    rollup_date: rollupDate,
    rate_basis: COST_ROLLUP_RATE_BASIS,
    total_cost: totalCost,
    line_count: lines.length,
    missing_rate_count: missingRateCount,
    depth_truncated: depthTruncated,
    lines,
  };
}
