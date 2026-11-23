import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';

/**
 * Story 10.2 (FR-RD-06): read model for the R&D equipment custody register.
 */

export interface RdEquipmentCustodyRow {
  custody_id: string;
  issue_id: string;
  requisition_id: string;
  requisition_line_id: string;
  project_code: string;
  custodian_user_id: string;
  asset_id: string | null;
  sku: string;
  quantity: string;
  expected_return_date: string;
  condition_codes: string[];
  status: 'on_loan' | 'returned';
  overdue: boolean;
  overdue_days: number;
  source_event_id: string;
  created_at: string;
  updated_at: string;
}

type Queryable = Pick<PoolClient, 'query'>;

function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}

function mapRow(row: Record<string, unknown>): RdEquipmentCustodyRow {
  return {
    custody_id: row['custody_id'] as string,
    issue_id: row['issue_id'] as string,
    requisition_id: row['requisition_id'] as string,
    requisition_line_id: row['requisition_line_id'] as string,
    project_code: row['project_code'] as string,
    custodian_user_id: row['custodian_user_id'] as string,
    asset_id: (row['asset_id'] as string | null) ?? null,
    sku: row['sku'] as string,
    quantity: String(row['quantity']),
    expected_return_date: row['expected_return_date'] instanceof Date ? row['expected_return_date'].toISOString().slice(0, 10) : String(row['expected_return_date']),
    condition_codes: Array.isArray(row['condition_codes']) ? (row['condition_codes'] as string[]) : [],
    status: row['status'] as RdEquipmentCustodyRow['status'],
    overdue: row['overdue'] === true,
    overdue_days: typeof row['overdue_days'] === 'number' ? row['overdue_days'] : Number(row['overdue_days'] ?? 0),
    source_event_id: row['source_event_id'] as string,
    created_at: row['created_at'] instanceof Date ? row['created_at'].toISOString() : String(row['created_at']),
    updated_at: row['updated_at'] instanceof Date ? row['updated_at'].toISOString() : String(row['updated_at']),
  };
}

export interface InsertRdEquipmentCustodyInput {
  custody_id: string;
  issue_id: string;
  requisition_id: string;
  requisition_line_id: string;
  project_code: string;
  custodian_user_id: string;
  asset_id: string | null;
  sku: string;
  quantity: string;
  expected_return_date: string;
  condition_codes: string[];
  source_event_id: string;
}

export async function insertRdEquipmentCustody(
  input: InsertRdEquipmentCustodyInput,
  client: PoolClient,
): Promise<void> {
  await client.query(
    `INSERT INTO rd_equipment_custody
       (custody_id, issue_id, requisition_id, requisition_line_id, project_code, custodian_user_id,
        asset_id, sku, quantity, expected_return_date, condition_codes, source_event_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      input.custody_id,
      input.issue_id,
      input.requisition_id,
      input.requisition_line_id,
      input.project_code,
      input.custodian_user_id,
      input.asset_id,
      input.sku,
      input.quantity,
      input.expected_return_date,
      input.condition_codes,
      input.source_event_id,
    ],
  );
}

export async function listRdEquipmentCustodyByRequisition(
  requisitionId: string,
  client?: PoolClient,
): Promise<RdEquipmentCustodyRow[]> {
  const r = runner(client);
  const result = await r.query(
    `SELECT custody_id, issue_id, requisition_id, requisition_line_id, project_code,
            custodian_user_id, asset_id, sku, quantity, expected_return_date, condition_codes,
            status, source_event_id, created_at, updated_at,
            (status = 'on_loan' AND expected_return_date < (now() AT TIME ZONE 'Asia/Kolkata')::date) AS overdue,
            CASE WHEN status = 'on_loan' AND expected_return_date < (now() AT TIME ZONE 'Asia/Kolkata')::date
                 THEN (now() AT TIME ZONE 'Asia/Kolkata')::date - expected_return_date ELSE 0 END AS overdue_days
     FROM rd_equipment_custody WHERE requisition_id = $1 ORDER BY created_at ASC, custody_id ASC`,
    [requisitionId],
  );
  return result.rows.map(mapRow);
}

/** Returns true when any costing or custody row already exists for this issue_id. */
export async function rdIssueExists(issueId: string, client: PoolClient): Promise<boolean> {
  const result = await client.query(
    `SELECT 1 FROM rd_issue_cost WHERE issue_id = $1
     UNION ALL
     SELECT 1 FROM rd_equipment_custody WHERE issue_id = $1
     LIMIT 1`,
    [issueId],
  );
  return result.rows.length > 0;
}
