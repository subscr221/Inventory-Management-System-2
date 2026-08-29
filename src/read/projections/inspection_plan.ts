import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';

/**
 * Story 8.1 accessors for the versioned inspection-plan family (FR-Q-01, AC 1 and AC 2):
 * inspection_plan (the scope-grain header), inspection_plan_version (immutable, effective-dated,
 * carrying the Story 8.2 sampling inputs) and inspection_plan_characteristic (the per-line
 * definitions). Approval evidence lives in src/read/projections/inspection_plan_approval.ts and is
 * JOINed here for the approved-state reads; the plan tables never carry an approval column.
 *
 * app_user holds INSERT and SELECT only on all three tables, so no accessor here takes a row lock:
 * the seam serializes version allocation and approval on pg_advisory_xact_lock keyed by plan_id
 * (see src/compliance/quality.ts) and the unique constraints are the backstops.
 *
 * DATE columns are read back as text (`::text`) so a calendar date never round-trips through a
 * JS Date at local midnight (the doa_registry mapDelegation lesson).
 */

export type InspectionPlanScope = 'standard' | 'customer_override';
export type CharacteristicClass = 'critical' | 'major' | 'minor';
export type ResultKind = 'numeric' | 'attribute';

export interface InspectionPlanRow {
  plan_id: string;
  scope: InspectionPlanScope;
  item_id: string;
  sku: string;
  bom_revision_id: string;
  source_order_type: 'job_work_order' | null;
  source_order_ref: string | null;
  created_by: string;
  source_event_id: string;
  created_at: string;
}

export interface InspectionPlanVersionRow {
  plan_version_id: string;
  plan_id: string;
  version_no: number;
  effective_from: string;
  aql: string | null;
  inspection_level: string | null;
  created_by: string;
  source_event_id: string;
  created_at: string;
  /** Approval evidence when present (JOINed from inspection_plan_approval). */
  approved: boolean;
  approved_at: string | null;
  approved_by: string | null;
}

export interface InspectionPlanCharacteristicRow {
  characteristic_id: string;
  plan_version_id: string;
  line_no: number;
  characteristic_name: string;
  characteristic_class: CharacteristicClass;
  test_method_ref: string;
  instrument_type: string | null;
  result_kind: ResultKind;
  lower_limit: string | null;
  upper_limit: string | null;
  limit_uom: string | null;
  acceptance_criteria: string | null;
  sample_handling: string;
}

export interface InspectionPlanGrain {
  item_id: string;
  bom_revision_id: string;
  scope: InspectionPlanScope;
  source_order_type: 'job_work_order' | null;
  source_order_ref: string | null;
}

type Queryable = Pick<PoolClient, 'query'>;

function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PLAN_COLUMNS = `plan_id, scope, item_id, sku, bom_revision_id, source_order_type,
    source_order_ref, created_by, source_event_id, created_at`;

const VERSION_COLUMNS = `v.plan_version_id, v.plan_id, v.version_no, v.effective_from::text AS effective_from,
    v.aql::text AS aql, v.inspection_level, v.created_by, v.source_event_id, v.created_at,
    (a.plan_version_id IS NOT NULL) AS approved, a.approved_at, a.approved_by`;

const VERSION_FROM = `FROM inspection_plan_version v
    LEFT JOIN inspection_plan_approval a ON a.plan_version_id = v.plan_version_id`;

const CHARACTERISTIC_COLUMNS = `characteristic_id, plan_version_id, line_no, characteristic_name,
    characteristic_class, test_method_ref, instrument_type, result_kind, lower_limit::text AS lower_limit,
    upper_limit::text AS upper_limit, limit_uom, acceptance_criteria, sample_handling`;

function mapPlan(row: Record<string, unknown>): InspectionPlanRow {
  return {
    plan_id: row['plan_id'] as string,
    scope: row['scope'] as InspectionPlanScope,
    item_id: row['item_id'] as string,
    sku: row['sku'] as string,
    bom_revision_id: row['bom_revision_id'] as string,
    source_order_type: (row['source_order_type'] as 'job_work_order' | null) ?? null,
    source_order_ref: (row['source_order_ref'] as string | null) ?? null,
    created_by: row['created_by'] as string,
    source_event_id: row['source_event_id'] as string,
    created_at:
      row['created_at'] instanceof Date
        ? row['created_at'].toISOString()
        : String(row['created_at']),
  };
}

function mapVersion(row: Record<string, unknown>): InspectionPlanVersionRow {
  const toIso = (v: unknown): string | null =>
    v === null || v === undefined ? null : v instanceof Date ? v.toISOString() : String(v);
  return {
    plan_version_id: row['plan_version_id'] as string,
    plan_id: row['plan_id'] as string,
    version_no: Number(row['version_no']),
    effective_from: String(row['effective_from']),
    aql: (row['aql'] as string | null) ?? null,
    inspection_level: (row['inspection_level'] as string | null) ?? null,
    created_by: row['created_by'] as string,
    source_event_id: row['source_event_id'] as string,
    created_at: toIso(row['created_at']) ?? '',
    approved: row['approved'] === true,
    approved_at: toIso(row['approved_at']),
    approved_by: (row['approved_by'] as string | null) ?? null,
  };
}

function mapCharacteristic(row: Record<string, unknown>): InspectionPlanCharacteristicRow {
  return {
    characteristic_id: row['characteristic_id'] as string,
    plan_version_id: row['plan_version_id'] as string,
    line_no: Number(row['line_no']),
    characteristic_name: row['characteristic_name'] as string,
    characteristic_class: row['characteristic_class'] as CharacteristicClass,
    test_method_ref: row['test_method_ref'] as string,
    instrument_type: (row['instrument_type'] as string | null) ?? null,
    result_kind: row['result_kind'] as ResultKind,
    lower_limit: (row['lower_limit'] as string | null) ?? null,
    upper_limit: (row['upper_limit'] as string | null) ?? null,
    limit_uom: (row['limit_uom'] as string | null) ?? null,
    acceptance_criteria: (row['acceptance_criteria'] as string | null) ?? null,
    sample_handling: row['sample_handling'] as string,
  };
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

export async function getInspectionPlanById(
  planId: string,
  client?: PoolClient,
): Promise<InspectionPlanRow | null> {
  if (!UUID_REGEX.test(planId)) return null;
  const result = await runner(client).query(
    `SELECT ${PLAN_COLUMNS} FROM inspection_plan WHERE plan_id = $1`,
    [planId],
  );
  return result.rows.length > 0 ? mapPlan(result.rows[0]!) : null;
}

export async function getInspectionPlanByGrain(
  grain: InspectionPlanGrain,
  client?: PoolClient,
): Promise<InspectionPlanRow | null> {
  const result = await runner(client).query(
    `SELECT ${PLAN_COLUMNS} FROM inspection_plan
      WHERE item_id = $1 AND bom_revision_id = $2 AND scope = $3
        AND source_order_type IS NOT DISTINCT FROM $4
        AND source_order_ref IS NOT DISTINCT FROM $5`,
    [
      grain.item_id,
      grain.bom_revision_id,
      grain.scope,
      grain.source_order_type,
      grain.source_order_ref,
    ],
  );
  return result.rows.length > 0 ? mapPlan(result.rows[0]!) : null;
}

export interface ListInspectionPlansParams {
  item_id?: string | undefined;
  bom_revision_id?: string | undefined;
  scope?: InspectionPlanScope | undefined;
  source_order_ref?: string | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

export async function listInspectionPlans(
  params: ListInspectionPlansParams,
  client?: PoolClient,
): Promise<InspectionPlanRow[]> {
  const where: string[] = [];
  const values: unknown[] = [];
  const push = (clause: string, value: unknown): void => {
    values.push(value);
    where.push(clause.replace('?', `$${values.length}`));
  };
  if (params.item_id) push('item_id = ?', params.item_id);
  if (params.bom_revision_id) push('bom_revision_id = ?', params.bom_revision_id);
  if (params.scope) push('scope = ?', params.scope);
  if (params.source_order_ref) push('source_order_ref = ?', params.source_order_ref);
  const limit = Math.min(Math.max(params.limit ?? 50, 1), 500);
  const offset = Math.max(params.offset ?? 0, 0);
  values.push(limit, offset);
  const result = await runner(client).query(
    `SELECT ${PLAN_COLUMNS} FROM inspection_plan
      ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY created_at DESC, plan_id ASC
      LIMIT $${values.length - 1} OFFSET $${values.length}`,
    values,
  );
  return result.rows.map(mapPlan);
}

export async function insertInspectionPlan(
  row: Omit<InspectionPlanRow, 'created_at'>,
  client: PoolClient,
): Promise<void> {
  await client.query(
    `INSERT INTO inspection_plan (plan_id, scope, item_id, sku, bom_revision_id, source_order_type,
       source_order_ref, created_by, source_event_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      row.plan_id,
      row.scope,
      row.item_id,
      row.sku,
      row.bom_revision_id,
      row.source_order_type,
      row.source_order_ref,
      row.created_by,
      row.source_event_id,
    ],
  );
}

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

export async function getInspectionPlanVersionById(
  planVersionId: string,
  client?: PoolClient,
): Promise<InspectionPlanVersionRow | null> {
  if (!UUID_REGEX.test(planVersionId)) return null;
  const result = await runner(client).query(
    `SELECT ${VERSION_COLUMNS} ${VERSION_FROM} WHERE v.plan_version_id = $1`,
    [planVersionId],
  );
  return result.rows.length > 0 ? mapVersion(result.rows[0]!) : null;
}

export async function listInspectionPlanVersions(
  planId: string,
  client?: PoolClient,
): Promise<InspectionPlanVersionRow[]> {
  if (!UUID_REGEX.test(planId)) return [];
  const result = await runner(client).query(
    `SELECT ${VERSION_COLUMNS} ${VERSION_FROM} WHERE v.plan_id = $1
      ORDER BY v.version_no ASC`,
    [planId],
  );
  return result.rows.map(mapVersion);
}

/** The highest allocated version number for a plan (0 when none). Read under the seam's advisory lock. */
export async function getMaxInspectionPlanVersionNo(
  planId: string,
  client: PoolClient,
): Promise<number> {
  const result = await client.query(
    `SELECT COALESCE(MAX(version_no), 0)::int AS max_no FROM inspection_plan_version WHERE plan_id = $1`,
    [planId],
  );
  return result.rows[0]!['max_no'] as number;
}

export async function getInspectionPlanVersionByEffectiveFrom(
  planId: string,
  effectiveFrom: string,
  client?: PoolClient,
): Promise<InspectionPlanVersionRow | null> {
  const result = await runner(client).query(
    `SELECT ${VERSION_COLUMNS} ${VERSION_FROM}
      WHERE v.plan_id = $1 AND v.effective_from = $2::date`,
    [planId, effectiveFrom],
  );
  return result.rows.length > 0 ? mapVersion(result.rows[0]!) : null;
}

export interface InsertInspectionPlanVersionRow {
  plan_version_id: string;
  plan_id: string;
  version_no: number;
  effective_from: string;
  aql: string | null;
  inspection_level: string | null;
  created_by: string;
  source_event_id: string;
}

export async function insertInspectionPlanVersion(
  row: InsertInspectionPlanVersionRow,
  client: PoolClient,
): Promise<void> {
  await client.query(
    `INSERT INTO inspection_plan_version (plan_version_id, plan_id, version_no, effective_from, aql,
       inspection_level, created_by, source_event_id)
     VALUES ($1, $2, $3, $4::date, $5::numeric, $6, $7, $8)`,
    [
      row.plan_version_id,
      row.plan_id,
      row.version_no,
      row.effective_from,
      row.aql,
      row.inspection_level,
      row.created_by,
      row.source_event_id,
    ],
  );
}

/**
 * Deterministic resolution (Task 4): among the APPROVED versions of `planId`, the one with the
 * greatest effective_from not after `businessDate`; version_no descending is only a tie-break
 * behind uq_inspection_plan_version_effective. Returns the resolved version, or null when the plan
 * has no approved version effective on that date (future-effective and draft versions are excluded
 * by construction). `ambiguous` is true only if grain/date uniqueness has been corrupted (two
 * approved versions sharing the greatest effective_from) - the caller fails closed on it.
 */
export async function resolveApprovedInspectionPlanVersion(
  planId: string,
  businessDate: string,
  client?: PoolClient,
): Promise<{ version: InspectionPlanVersionRow | null; ambiguous: boolean }> {
  const result = await runner(client).query(
    `SELECT ${VERSION_COLUMNS} ${VERSION_FROM}
      WHERE v.plan_id = $1 AND a.plan_version_id IS NOT NULL AND v.effective_from <= $2::date
      ORDER BY v.effective_from DESC, v.version_no DESC
      LIMIT 2`,
    [planId, businessDate],
  );
  if (result.rows.length === 0) return { version: null, ambiguous: false };
  const first = mapVersion(result.rows[0]!);
  const second = result.rows.length > 1 ? mapVersion(result.rows[1]!) : null;
  return {
    version: first,
    ambiguous: second !== null && second.effective_from === first.effective_from,
  };
}

// ---------------------------------------------------------------------------
// Characteristics
// ---------------------------------------------------------------------------

export async function listInspectionPlanCharacteristics(
  planVersionId: string,
  client?: PoolClient,
): Promise<InspectionPlanCharacteristicRow[]> {
  if (!UUID_REGEX.test(planVersionId)) return [];
  const result = await runner(client).query(
    `SELECT ${CHARACTERISTIC_COLUMNS} FROM inspection_plan_characteristic
      WHERE plan_version_id = $1 ORDER BY line_no ASC`,
    [planVersionId],
  );
  return result.rows.map(mapCharacteristic);
}

export async function insertInspectionPlanCharacteristic(
  row: InspectionPlanCharacteristicRow,
  client: PoolClient,
): Promise<void> {
  await client.query(
    `INSERT INTO inspection_plan_characteristic (characteristic_id, plan_version_id, line_no,
       characteristic_name, characteristic_class, test_method_ref, instrument_type, result_kind,
       lower_limit, upper_limit, limit_uom, acceptance_criteria, sample_handling)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::numeric, $10::numeric, $11, $12, $13)`,
    [
      row.characteristic_id,
      row.plan_version_id,
      row.line_no,
      row.characteristic_name,
      row.characteristic_class,
      row.test_method_ref,
      row.instrument_type,
      row.result_kind,
      row.lower_limit,
      row.upper_limit,
      row.limit_uom,
      row.acceptance_criteria,
      row.sample_handling,
    ],
  );
}
