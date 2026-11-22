import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';

/**
 * Story 10.2 (FR-AC-03): read model for the six Ind AS 38 development-capitalization criteria and
 * the project's forward-only capitalization_effective_date.
 */

export const RD_CHECKLIST_CRITERIA = [
  'technical_feasibility',
  'intention_to_complete',
  'ability_to_use_or_sell',
  'future_economic_benefits',
  'resources_available',
  'expenditure_measurable',
] as const;

export type RdCriterionCode = (typeof RD_CHECKLIST_CRITERIA)[number];

export interface RdProjectChecklistRow {
  checklist_id: string;
  project_code: string;
  criterion_code: RdCriterionCode;
  met: boolean;
  met_at: string | null;
  updated_at: string;
}

type Queryable = Pick<PoolClient, 'query'>;

function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}

function mapRow(row: Record<string, unknown>): RdProjectChecklistRow {
  return {
    checklist_id: row['checklist_id'] as string,
    project_code: row['project_code'] as string,
    criterion_code: row['criterion_code'] as RdCriterionCode,
    met: row['met'] === true,
    met_at: row['met_at'] instanceof Date ? row['met_at'].toISOString() : (row['met_at'] as string | null) ?? null,
    updated_at: row['updated_at'] instanceof Date ? row['updated_at'].toISOString() : String(row['updated_at']),
  };
}

export async function getRdProjectChecklist(
  projectCode: string,
  client?: PoolClient,
): Promise<RdProjectChecklistRow[]> {
  const r = runner(client);
  const result = await r.query(
    `SELECT checklist_id, project_code, criterion_code, met, met_at, updated_at
     FROM rd_project_checklist WHERE project_code = $1 ORDER BY criterion_code ASC`,
    [projectCode],
  );
  return result.rows.map(mapRow);
}

export async function upsertRdProjectChecklistCriterion(
  projectCode: string,
  criterionCode: RdCriterionCode,
  met: boolean,
  client: PoolClient,
): Promise<void> {
  await client.query(
    `INSERT INTO rd_project_checklist (project_code, criterion_code, met, met_at, updated_at)
     VALUES ($1, $2, $3, CASE WHEN $3 THEN now() ELSE NULL END, now())
     ON CONFLICT (project_code, criterion_code)
     DO UPDATE SET met = EXCLUDED.met,
                   met_at = CASE WHEN EXCLUDED.met AND rd_project_checklist.met_at IS NULL
                                 THEN now() ELSE rd_project_checklist.met_at END,
                   updated_at = now()`,
    [projectCode, criterionCode, met],
  );
}

export interface RdProjectCapitalizationDates {
  capitalization_effective_date: string | null;
  /** IST calendar date of the effective timestamp, for date-only comparisons. */
  capitalization_effective_date_ist: string | null;
}

export async function getRdProjectCapitalizationDates(
  projectCode: string,
  client: PoolClient,
): Promise<RdProjectCapitalizationDates> {
  const result = await client.query(
    `SELECT capitalization_effective_date,
            (capitalization_effective_date AT TIME ZONE 'Asia/Kolkata')::date::text AS capitalization_effective_date_ist
     FROM rd_project WHERE project_code = $1`,
    [projectCode],
  );
  const row = result.rows[0] as Record<string, unknown> | undefined;
  const effective = row?.['capitalization_effective_date'];
  return {
    capitalization_effective_date: effective instanceof Date ? effective.toISOString() : (effective as string | null) ?? null,
    capitalization_effective_date_ist: (row?.['capitalization_effective_date_ist'] as string | null) ?? null,
  };
}

export async function setRdProjectCapitalizationEffectiveDate(
  projectCode: string,
  client: PoolClient,
): Promise<void> {
  await client.query(
    `UPDATE rd_project SET capitalization_effective_date = now(), updated_at = now()
     WHERE project_code = $1 AND capitalization_effective_date IS NULL`,
    [projectCode],
  );
}
