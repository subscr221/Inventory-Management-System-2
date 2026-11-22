import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';

/**
 * Story 10.2 (FR-AC-02/03): read model for the immutable R&D issue costing record.
 */

export interface RdIssueCostRow {
  issue_cost_id: string;
  issue_id: string;
  requisition_id: string;
  requisition_line_id: string;
  project_code: string;
  issue_type: string;
  phase: 'research' | 'development';
  capitalization: 'expensed' | 'capitalized';
  capitalization_blocked_reason: string | null;
  checklist_reference: string | null;
  cost_amount: string;
  unit_cost: string | null;
  business_date: string;
  source_event_id: string;
  created_at: string;
}

type Queryable = Pick<PoolClient, 'query'>;

function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}

function mapRow(row: Record<string, unknown>): RdIssueCostRow {
  return {
    issue_cost_id: row['issue_cost_id'] as string,
    issue_id: row['issue_id'] as string,
    requisition_id: row['requisition_id'] as string,
    requisition_line_id: row['requisition_line_id'] as string,
    project_code: row['project_code'] as string,
    issue_type: row['issue_type'] as string,
    phase: row['phase'] as RdIssueCostRow['phase'],
    capitalization: row['capitalization'] as RdIssueCostRow['capitalization'],
    capitalization_blocked_reason: (row['capitalization_blocked_reason'] as string | null) ?? null,
    checklist_reference: (row['checklist_reference'] as string | null) ?? null,
    cost_amount: String(row['cost_amount']),
    unit_cost: row['unit_cost'] === null || row['unit_cost'] === undefined ? null : String(row['unit_cost']),
    business_date: row['business_date'] instanceof Date ? row['business_date'].toISOString().slice(0, 10) : String(row['business_date']),
    source_event_id: row['source_event_id'] as string,
    created_at: row['created_at'] instanceof Date ? row['created_at'].toISOString() : String(row['created_at']),
  };
}

export interface InsertRdIssueCostInput {
  issue_cost_id: string;
  issue_id: string;
  requisition_id: string;
  requisition_line_id: string;
  project_code: string;
  issue_type: string;
  phase: string;
  capitalization: string;
  capitalization_blocked_reason: string | null;
  checklist_reference: string | null;
  cost_amount: string;
  unit_cost: string | null;
  business_date: string;
  source_event_id: string;
}

export async function insertRdIssueCost(input: InsertRdIssueCostInput, client: PoolClient): Promise<void> {
  await client.query(
    `INSERT INTO rd_issue_cost
       (issue_cost_id, issue_id, requisition_id, requisition_line_id, project_code, issue_type,
        phase, capitalization, capitalization_blocked_reason, checklist_reference, cost_amount,
        unit_cost, business_date, source_event_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
    [
      input.issue_cost_id,
      input.issue_id,
      input.requisition_id,
      input.requisition_line_id,
      input.project_code,
      input.issue_type,
      input.phase,
      input.capitalization,
      input.capitalization_blocked_reason,
      input.checklist_reference,
      input.cost_amount,
      input.unit_cost,
      input.business_date,
      input.source_event_id,
    ],
  );
}

export async function listRdIssueCostsByRequisition(
  requisitionId: string,
  client?: PoolClient,
): Promise<RdIssueCostRow[]> {
  const r = runner(client);
  const result = await r.query(
    `SELECT issue_cost_id, issue_id, requisition_id, requisition_line_id, project_code, issue_type,
            phase, capitalization, capitalization_blocked_reason, checklist_reference, cost_amount,
            unit_cost, business_date, source_event_id, created_at
     FROM rd_issue_cost WHERE requisition_id = $1 ORDER BY created_at ASC, issue_cost_id ASC`,
    [requisitionId],
  );
  return result.rows.map(mapRow);
}
