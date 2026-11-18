import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';

/**
 * Story 4.11: stores counter issue slips. One `indent_issue` row per `indent.issued` event, any
 * number of `indent_issue_line` rows of the same requisition. The slip text is immutable once
 * written; `standing_grant_id` is the Story 4.8 seam and stays null here.
 */
export interface IndentIssueRow {
  issue_id: string;
  issue_number_ext: string;
  indent_id: string;
  site_id: string;
  issued_by: string;
  issued_at: string;
  slip_content: string;
  source_event_id: string;
  correlation_id: string | null;
  created_at: string;
}

export interface IndentIssueLineRow {
  issue_line_id: string;
  issue_id: string;
  indent_id: string;
  indent_line_id: string;
  line_no: number;
  sku: string;
  quantity: string;
  uom: string;
  location_id: string;
  location_code: string;
  lot_id: string | null;
  serials: Array<{ serial_number: string }> | null;
  stock_issued_event_id: string;
  approval_basis: string;
  standing_grant_id: string | null;
}

type Queryable = Pick<PoolClient, 'query'>;

function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function insertIndentIssue(
  row: Omit<IndentIssueRow, 'created_at' | 'slip_content'> & { slip_content?: string },
  client: PoolClient,
): Promise<void> {
  await client.query(
    `INSERT INTO indent_issue (
      issue_id, issue_number_ext, indent_id, site_id, issued_by, issued_at,
      slip_content, source_event_id, correlation_id
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      row.issue_id,
      row.issue_number_ext,
      row.indent_id,
      row.site_id,
      row.issued_by,
      row.issued_at,
      row.slip_content ?? '',
      row.source_event_id,
      row.correlation_id,
    ],
  );
}

export async function setIndentIssueSlip(
  issueId: string,
  slipContent: string,
  client: PoolClient,
): Promise<void> {
  await client.query(`UPDATE indent_issue SET slip_content = $2 WHERE issue_id = $1`, [
    issueId,
    slipContent,
  ]);
}

export async function insertIndentIssueLine(
  row: IndentIssueLineRow,
  client: PoolClient,
): Promise<void> {
  await client.query(
    `INSERT INTO indent_issue_line (
      issue_line_id, issue_id, indent_id, indent_line_id, line_no, sku, quantity, uom,
      location_id, location_code, lot_id, serials, stock_issued_event_id, approval_basis,
      standing_grant_id
    ) VALUES ($1,$2,$3,$4,$5,$6,$7::numeric,$8,$9,$10,$11,$12::jsonb,$13,$14,$15)`,
    [
      row.issue_line_id,
      row.issue_id,
      row.indent_id,
      row.indent_line_id,
      row.line_no,
      row.sku,
      row.quantity,
      row.uom,
      row.location_id,
      row.location_code,
      row.lot_id,
      row.serials === null ? null : JSON.stringify(row.serials),
      row.stock_issued_event_id,
      row.approval_basis,
      row.standing_grant_id,
    ],
  );
}

export async function getIndentIssueById(
  issueId: string,
  client?: PoolClient,
): Promise<IndentIssueRow | null> {
  if (!UUID_REGEX.test(issueId)) return null;
  const result = await runner(client).query(`SELECT * FROM indent_issue WHERE issue_id = $1`, [
    issueId,
  ]);
  return (result.rows[0] as IndentIssueRow) ?? null;
}

export async function getIndentIssueLines(
  issueId: string,
  client?: PoolClient,
): Promise<IndentIssueLineRow[]> {
  if (!UUID_REGEX.test(issueId)) return [];
  const result = await runner(client).query(
    `SELECT * FROM indent_issue_line WHERE issue_id = $1 ORDER BY line_no ASC`,
    [issueId],
  );
  return result.rows as IndentIssueLineRow[];
}

/** Oldest first, so a slip can list the earlier slips of the same requisition in order. */
export async function listIndentIssuesByIndent(
  indentId: string,
  client?: PoolClient,
): Promise<IndentIssueRow[]> {
  if (!UUID_REGEX.test(indentId)) return [];
  const result = await runner(client).query(
    `SELECT * FROM indent_issue WHERE indent_id = $1 ORDER BY issued_at ASC, issue_number_ext ASC`,
    [indentId],
  );
  return result.rows as IndentIssueRow[];
}

/**
 * Allocates the next human-readable slip number in the ISS-YYYY-NNNN format from the
 * indent_issue_number_seq sequence (the allocateIndentNumber idiom): server-side only, never
 * client-supplied, never MAX(...)+1.
 */
export async function allocateIssueNumber(year: number, client: PoolClient): Promise<string> {
  const result = await client.query(`SELECT nextval('indent_issue_number_seq') AS n`);
  const n = String(result.rows[0]['n']);
  return `ISS-${year}-${n.padStart(4, '0')}`;
}
