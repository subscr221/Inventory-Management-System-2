import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';
import { AppError } from '../../middleware/error.js';

/**
 * Story 8.9: read and write helpers for the damage_report projection and its append-only action
 * history. Writes only ever run on the persistEvent transaction client (AD-14). Numeric columns are
 * read back as their NUMERIC text so quantities and percentages never pass through a float.
 */

export type DamageStatus =
  'on_hold' | 'cleared' | 'awaiting_keys' | 'escalated' | 'outcome_final' | 'closed';

export type DamagePhysicalState =
  'awaiting_arrival' | 'in_qc_hold' | 'at_external_check' | 'with_reporter' | 'not_held';

export type DamageKeyStatus = 'pending' | 'turned' | 'disagreed';

export interface DamageReportRow {
  report_id: string;
  report_number: string;
  site_id: string;
  reporter_user_id: string;
  reported_at: string;
  source_event_id: string;
  source: 'report' | 'receipt';
  source_grn_line_id: string | null;
  source_reason_code: string | null;
  source_photo_ref: string | null;
  sku: string;
  lot_number: string | null;
  quantity: string;
  uom: string;
  found_at: 'stock' | 'in_use';
  bin_location_id: string | null;
  bin_code: string | null;
  reason_code: string;
  reason_note: string | null;
  photo_attachment_id: string | null;
  hold_mode: 'quarantined' | 'record_only';
  hold_note: string | null;
  quarantine_location_id: string | null;
  physical_state: DamagePhysicalState;
  arrived_by: string | null;
  arrived_at: string | null;
  external_destination: string | null;
  external_sent_by: string | null;
  external_sent_at: string | null;
  external_expected_return_date: string | null;
  external_gate_pass_ref_ext: string | null;
  external_returned_at: string | null;
  external_result_ref_ext: string | null;
  whole_lot_requested: boolean;
  whole_lot_decision: 'hold_lot' | 'keep_local' | null;
  whole_lot_hold_id: string | null;
  whole_lot_already_held: boolean | null;
  whole_lot_decided_by: string | null;
  whole_lot_decided_at: string | null;
  status: DamageStatus;
  confirmed_quantity: string | null;
  defect_code: string | null;
  inspected_by: string | null;
  inspected_at: string | null;
  case_value: string | null;
  qc_key_status: DamageKeyStatus;
  qc_key_user_id: string | null;
  qc_key_outcome: string | null;
  qc_key_price_reduction_pct: string | null;
  qc_key_at: string | null;
  finance_key_status: DamageKeyStatus;
  finance_key_user_id: string | null;
  finance_key_outcome: string | null;
  finance_key_price_reduction_pct: string | null;
  finance_key_at: string | null;
  final_outcome: string | null;
  final_price_reduction_pct: string | null;
  decided_by: 'concurrence' | 'escalation' | null;
  escalation_user_id: string | null;
  decided_at: string | null;
  erp_document_ref_ext: string | null;
  outcome_recorded_by: string | null;
  outcome_recorded_at: string | null;
  replacement_indent_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface DamageReportActionRow {
  action_id: string;
  report_id: string;
  action: string;
  actor_user_id: string;
  actor_role: string;
  actor_display_name: string | null;
  at: string;
  detail: Record<string, unknown>;
}

type Queryable = Pick<PoolClient, 'query'>;

function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const TIMESTAMP_COLUMNS = [
  'reported_at',
  'arrived_at',
  'external_sent_at',
  'external_returned_at',
  'whole_lot_decided_at',
  'inspected_at',
  'qc_key_at',
  'finance_key_at',
  'decided_at',
  'outcome_recorded_at',
  'created_at',
  'updated_at',
];

/** NUMERIC and DATE columns are selected as text; every other column as stored. */
const SELECT_COLUMNS = `
  d.*,
  d.quantity::text AS quantity,
  d.confirmed_quantity::text AS confirmed_quantity,
  d.case_value::text AS case_value,
  d.qc_key_price_reduction_pct::text AS qc_key_price_reduction_pct,
  d.finance_key_price_reduction_pct::text AS finance_key_price_reduction_pct,
  d.final_price_reduction_pct::text AS final_price_reduction_pct,
  to_char(d.external_expected_return_date, 'YYYY-MM-DD') AS external_expected_return_date`;

export function mapDamageRow(row: Record<string, unknown>): DamageReportRow {
  const out: Record<string, unknown> = { ...row };
  for (const column of TIMESTAMP_COLUMNS) {
    const value = out[column];
    if (value instanceof Date) out[column] = value.toISOString();
  }
  return out as unknown as DamageReportRow;
}

export async function getDamageReportById(
  reportId: string,
  client?: PoolClient,
  lock: 'none' | 'update' | 'share' = 'none',
): Promise<DamageReportRow | null> {
  if (!UUID_REGEX.test(reportId)) return null;
  const lockClause = lock === 'update' ? ' FOR UPDATE' : lock === 'share' ? ' FOR SHARE' : '';
  const result = await runner(client).query(
    `SELECT ${SELECT_COLUMNS} FROM damage_report d WHERE d.report_id = $1${lockClause}`,
    [reportId],
  );
  return result.rows.length > 0 ? mapDamageRow(result.rows[0]!) : null;
}

export async function getDamageReportByGrnLine(
  grnLineId: string,
  client?: PoolClient,
  lock: 'none' | 'share' = 'none',
): Promise<DamageReportRow | null> {
  if (!UUID_REGEX.test(grnLineId)) return null;
  const lockClause = lock === 'share' ? ' FOR SHARE' : '';
  const result = await runner(client).query(
    `SELECT ${SELECT_COLUMNS} FROM damage_report d WHERE d.source_grn_line_id = $1${lockClause}`,
    [grnLineId],
  );
  return result.rows.length > 0 ? mapDamageRow(result.rows[0]!) : null;
}

/** DMG-YYYY-NNNN from damage_report_number_seq (the indent_number_seq precedent), IST year. */
export async function allocateDamageReportNumber(
  year: string,
  client: PoolClient,
): Promise<string> {
  const result = await client.query(`SELECT nextval('damage_report_number_seq') AS n`);
  const n = String(result.rows[0]!['n']);
  return `DMG-${year}-${n.padStart(4, '0')}`;
}

export interface InsertDamageReportInput {
  report_id: string;
  report_number: string;
  site_id: string;
  reporter_user_id: string;
  reported_at: string;
  source_event_id: string;
  source: 'report' | 'receipt';
  source_grn_line_id: string | null;
  source_reason_code: string | null;
  source_photo_ref: string | null;
  sku: string;
  lot_number: string | null;
  quantity: string;
  uom: string;
  found_at: 'stock' | 'in_use';
  bin_location_id: string | null;
  bin_code: string | null;
  reason_code: string;
  reason_note: string | null;
  photo_attachment_id: string | null;
  hold_mode: 'quarantined' | 'record_only';
  hold_note: string | null;
  quarantine_location_id: string | null;
  physical_state: DamagePhysicalState;
  whole_lot_requested: boolean;
  replacement_indent_id: string | null;
}

export async function insertDamageReport(
  row: InsertDamageReportInput,
  client: PoolClient,
): Promise<void> {
  await client.query(
    `INSERT INTO damage_report (
       report_id, report_number, site_id, reporter_user_id, reported_at, source_event_id, source,
       source_grn_line_id, source_reason_code, source_photo_ref, sku, lot_number, quantity, uom,
       found_at, bin_location_id, bin_code, reason_code, reason_note, photo_attachment_id,
       hold_mode, hold_note, quarantine_location_id, physical_state, whole_lot_requested,
       replacement_indent_id
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::numeric,$14,$15,$16,$17,$18,$19,$20,$21,
               $22,$23,$24,$25,$26)`,
    [
      row.report_id,
      row.report_number,
      row.site_id,
      row.reporter_user_id,
      row.reported_at,
      row.source_event_id,
      row.source,
      row.source_grn_line_id,
      row.source_reason_code,
      row.source_photo_ref,
      row.sku,
      row.lot_number,
      row.quantity,
      row.uom,
      row.found_at,
      row.bin_location_id,
      row.bin_code,
      row.reason_code,
      row.reason_note,
      row.photo_attachment_id,
      row.hold_mode,
      row.hold_note,
      row.quarantine_location_id,
      row.physical_state,
      row.whole_lot_requested,
      row.replacement_indent_id,
    ],
  );
}

/**
 * Applies a column patch to one case. Column names come only from this module's callers (never
 * from a request), and every value is bound; `updated_at` is always stamped.
 */
/** Every column `updateDamageReport` may set - every damage_report column except the primary key and timestamps it manages itself. */
const UPDATABLE_COLUMNS: ReadonlySet<string> = new Set([
  'report_number',
  'site_id',
  'reporter_user_id',
  'reported_at',
  'source_event_id',
  'source',
  'source_grn_line_id',
  'source_reason_code',
  'source_photo_ref',
  'sku',
  'lot_number',
  'quantity',
  'uom',
  'found_at',
  'bin_location_id',
  'bin_code',
  'reason_code',
  'reason_note',
  'photo_attachment_id',
  'hold_mode',
  'hold_note',
  'quarantine_location_id',
  'physical_state',
  'arrived_by',
  'arrived_at',
  'external_destination',
  'external_sent_by',
  'external_sent_at',
  'external_expected_return_date',
  'external_gate_pass_ref_ext',
  'external_returned_at',
  'external_result_ref_ext',
  'whole_lot_requested',
  'whole_lot_decision',
  'whole_lot_hold_id',
  'whole_lot_already_held',
  'whole_lot_decided_by',
  'whole_lot_decided_at',
  'status',
  'confirmed_quantity',
  'defect_code',
  'inspected_by',
  'inspected_at',
  'case_value',
  'qc_key_status',
  'qc_key_user_id',
  'qc_key_outcome',
  'qc_key_price_reduction_pct',
  'qc_key_at',
  'finance_key_status',
  'finance_key_user_id',
  'finance_key_outcome',
  'finance_key_price_reduction_pct',
  'finance_key_at',
  'final_outcome',
  'final_price_reduction_pct',
  'decided_by',
  'escalation_user_id',
  'decided_at',
  'erp_document_ref_ext',
  'outcome_recorded_by',
  'outcome_recorded_at',
  'replacement_indent_id',
]);

export async function updateDamageReport(
  reportId: string,
  patch: Record<string, unknown>,
  client: PoolClient,
): Promise<void> {
  const columns = Object.keys(patch);
  if (columns.length === 0) return;
  for (const column of columns) {
    if (!UPDATABLE_COLUMNS.has(column)) {
      throw new Error(`updateDamageReport: "${column}" is not an updatable damage_report column`);
    }
  }
  const sets = columns.map((column, i) => `${column} = $${i + 2}`);
  await client.query(
    `UPDATE damage_report SET ${sets.join(', ')}, updated_at = now() WHERE report_id = $1`,
    [reportId, ...columns.map((column) => patch[column])],
  );
}

export async function insertDamageAction(
  input: {
    report_id: string;
    action: string;
    actor_user_id: string;
    actor_role: string;
    at: string;
    detail: Record<string, unknown>;
    source_event_id: string;
  },
  client: PoolClient,
): Promise<void> {
  await client.query(
    `INSERT INTO damage_report_action (report_id, action, actor_user_id, actor_role, at, detail, source_event_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (source_event_id) DO NOTHING`,
    [
      input.report_id,
      input.action,
      input.actor_user_id,
      input.actor_role,
      input.at,
      JSON.stringify(input.detail),
      input.source_event_id,
    ],
  );
}

export async function listDamageActions(
  reportId: string,
  client?: PoolClient,
): Promise<DamageReportActionRow[]> {
  const result = await runner(client).query(
    `SELECT a.action_id, a.report_id, a.action, a.actor_user_id, a.actor_role,
            COALESCE(u.display_name, u.email) AS actor_display_name, a.at, a.detail
       FROM damage_report_action a
       LEFT JOIN users u ON u.user_id = a.actor_user_id
      WHERE a.report_id = $1
      ORDER BY a.at DESC, a.created_at DESC`,
    [reportId],
  );
  return result.rows.map((row) => ({
    ...(row as DamageReportActionRow),
    at: row['at'] instanceof Date ? row['at'].toISOString() : String(row['at']),
  }));
}

/** Display names for a set of users: users.display_name, else the email (D11). */
export async function displayNamesFor(
  userIds: (string | null)[],
  client?: PoolClient,
): Promise<Map<string, string>> {
  const ids = [...new Set(userIds.filter((id): id is string => id !== null))];
  if (ids.length === 0) return new Map();
  const result = await runner(client).query(
    `SELECT user_id, COALESCE(display_name, email) AS name FROM users WHERE user_id = ANY($1::uuid[])`,
    [ids],
  );
  return new Map(result.rows.map((r) => [r['user_id'] as string, r['name'] as string]));
}

export interface ListDamageReportsFilter {
  /** Own cases at any site. */
  reporterUserId?: string;
  /** Sites where the caller sees every case (a qc or warehouse holder); wildcard = every site. */
  siteScope?: { wildcard: boolean; sites: string[] };
  /** Additional case ids the caller sees as a resolved authority. */
  extraReportIds?: string[];
  siteId?: string;
  status?: DamageStatus;
  limit: number;
}

/**
 * Lists cases newest first. Closed and cleared cases older than 30 days drop out of the workbench
 * (Table 11 "Closed (last 30 days)"); a reporter's own list keeps its whole history.
 */
export async function listDamageReports(
  filter: ListDamageReportsFilter,
  client?: PoolClient,
): Promise<DamageReportRow[]> {
  const where: string[] = [];
  const values: unknown[] = [];
  const bind = (value: unknown): string => {
    values.push(value);
    return `$${values.length}`;
  };
  if (filter.reporterUserId !== undefined) {
    where.push(`d.reporter_user_id = ${bind(filter.reporterUserId)}`);
  } else {
    const visibility: string[] = [];
    if (filter.siteScope?.wildcard) visibility.push('TRUE');
    else if (filter.siteScope && filter.siteScope.sites.length > 0) {
      visibility.push(`d.site_id = ANY(${bind(filter.siteScope.sites)}::uuid[])`);
    }
    if (filter.extraReportIds && filter.extraReportIds.length > 0) {
      visibility.push(`d.report_id = ANY(${bind(filter.extraReportIds)}::uuid[])`);
    }
    if (visibility.length === 0) return [];
    where.push(`(${visibility.join(' OR ')})`);
    where.push(
      `(d.status NOT IN ('closed', 'cleared') OR d.updated_at >= now() - interval '30 days')`,
    );
  }
  if (filter.siteId !== undefined) where.push(`d.site_id = ${bind(filter.siteId)}`);
  if (filter.status !== undefined) where.push(`d.status = ${bind(filter.status)}`);
  const result = await runner(client).query(
    `SELECT ${SELECT_COLUMNS} FROM damage_report d
      ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY d.reported_at DESC, d.report_id
      LIMIT ${bind(filter.limit)}`,
    values,
  );
  return result.rows.map(mapDamageRow);
}

/**
 * Open cases a DOA authority might act on: every case not yet closed or cleared, plus a closed or
 * cleared case updated in the last 30 days (the same trailing window `listDamageReports` keeps for
 * the workbench).
 */
export async function listOpenDamageReports(client?: PoolClient): Promise<DamageReportRow[]> {
  const result = await runner(client).query(
    `SELECT ${SELECT_COLUMNS} FROM damage_report d
      WHERE d.status NOT IN ('closed', 'cleared')
         OR d.updated_at >= now() - interval '30 days'
      ORDER BY d.reported_at DESC
      LIMIT 2000`,
  );
  return result.rows.map(mapDamageRow);
}

/**
 * The SQL twin of heldQuantity() in src/compliance/damage.ts (D5): the reported quantity before
 * inspection, the confirmed quantity after, 0 once cleared or closed as accept-as-is. Only
 * quarantined cases hold stock. Pinned against the pure function by the integration suite.
 */
export const HELD_QUANTITY_SQL = `CASE
  WHEN d.hold_mode <> 'quarantined' THEN 0
  WHEN d.status = 'cleared' THEN 0
  WHEN d.status = 'closed' AND d.final_outcome = 'accept_as_is_price_reduction' THEN 0
  ELSE COALESCE(d.confirmed_quantity, d.quantity)
END`;

/**
 * Story 8.9 (D5): the damage hold is a quantity guard on stock leaving quarantine. Called by
 * applyStockIssue AFTER its drain, so on_hand already reflects the issue. Active only when an open
 * quarantined case holds this SKU, the source is a quarantine location and the destination is not
 * one (a relocation between quarantine bins keeps the units held). The held units are counted
 * against the site's whole quarantine pool - every location at or beneath a quarantine flag - so a
 * move between quarantine bins does not strand the hold on the old bin. Lot-named cases are also
 * checked lot by lot. The case rows are read FOR SHARE, so a concurrent decision that would release
 * units waits for this issue, and this issue sees every hold committed before it.
 */
export async function assertDamageHeldQuantity(
  input: {
    sku: string;
    sourceLocationId: string;
    targetLocationId?: string | null;
    stockClass: string;
  },
  client: PoolClient,
  isQuarantineLocation: (locationId: string, client: PoolClient) => Promise<boolean>,
): Promise<void> {
  if (input.stockClass !== 'owned') return;
  const held = await client.query(
    `SELECT d.site_id FROM damage_report d
      WHERE d.sku = $1 AND d.hold_mode = 'quarantined' AND (${HELD_QUANTITY_SQL}) > 0
      FOR SHARE OF d`,
    [input.sku],
  );
  if (held.rows.length === 0) return;
  if (!(await isQuarantineLocation(input.sourceLocationId, client))) return;
  if (input.targetLocationId && (await isQuarantineLocation(input.targetLocationId, client)))
    return;
  const site = await client.query(`SELECT site_id FROM location_register WHERE location_id = $1`, [
    input.sourceLocationId,
  ]);
  const siteId = (site.rows[0]?.['site_id'] as string | undefined) ?? null;
  if (siteId === null || !held.rows.some((r) => r['site_id'] === siteId)) return;
  const check = await client.query(
    `WITH RECURSIVE pool AS (
       SELECT location_id, 0 AS depth FROM location_register WHERE site_id = $2 AND quarantine = true
       UNION
       SELECT c.location_id, p.depth + 1 FROM location_register c
         JOIN pool p ON c.parent_location_id = p.location_id
        WHERE p.depth < 10
     ),
     held AS (
       SELECT d.lot_number, SUM(${HELD_QUANTITY_SQL}) AS h
         FROM damage_report d
        WHERE d.sku = $1 AND d.site_id = $2 AND d.hold_mode = 'quarantined'
        GROUP BY d.lot_number
     ),
     stock AS (
       SELECT lot_id, SUM(on_hand) AS s FROM stock_balance
        WHERE sku = $1 AND stock_class = 'owned'
          AND location_id IN (SELECT location_id FROM pool)
        GROUP BY lot_id
     )
     SELECT (SELECT COALESCE(SUM(h), 0) FROM held)::text AS held_quantity,
            (SELECT COALESCE(SUM(s), 0) FROM stock)::text AS remaining_quantity,
            (SELECT COALESCE(SUM(h), 0) FROM held) <= (SELECT COALESCE(SUM(s), 0) FROM stock)
              AND NOT EXISTS (
                SELECT 1 FROM held
                 WHERE held.lot_number IS NOT NULL
                   AND held.h > COALESCE((SELECT stock.s FROM stock WHERE stock.lot_id = held.lot_number), 0)
              ) AS covered`,
    [input.sku, siteId],
  );
  const row = check.rows[0]!;
  if (row['covered'] !== true) {
    throw new AppError(
      409,
      'DAMAGE_UNITS_HELD',
      `Units of ${input.sku} in quarantine are held by an open damage case and cannot leave it`,
      {
        sku: input.sku,
        location_id: input.sourceLocationId,
        held_quantity: row['held_quantity'],
        remaining_quantity: row['remaining_quantity'],
      },
    );
  }
}
