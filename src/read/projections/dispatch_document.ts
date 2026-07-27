import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';

export interface DispatchDocument {
  document_id: string;
  dispatch_order_id: string;
  document_type: 'bol' | 'packing_slip' | 'commercial_invoice' | 'label';
  document_content: string | null;
  generated_by: string;
  generated_at: string;
}

export interface CreateDispatchDocumentInput {
  document_id: string;
  dispatch_order_id: string;
  document_type: string;
  document_content: string;
  generated_by: string;
}

type Queryable = Pick<PoolClient, 'query'>;

function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}

const COLUMNS = `document_id, dispatch_order_id, document_type, document_content, generated_by, generated_at`;

function mapRow(row: Record<string, unknown>): DispatchDocument {
  return {
    document_id: row['document_id'] as string,
    dispatch_order_id: row['dispatch_order_id'] as string,
    document_type: row['document_type'] as DispatchDocument['document_type'],
    document_content: row['document_content'] as string | null,
    generated_by: row['generated_by'] as string,
    generated_at: row['generated_at'] as string,
  };
}

export async function createDispatchDocument(
  input: CreateDispatchDocumentInput,
  client?: PoolClient,
): Promise<DispatchDocument> {
  const result = await runner(client).query(
    `INSERT INTO dispatch_document
       (document_id, dispatch_order_id, document_type, document_content, generated_by)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING ${COLUMNS}`,
    [input.document_id, input.dispatch_order_id, input.document_type, input.document_content, input.generated_by],
  );
  return mapRow(result.rows[0]!);
}

export async function listDocumentsByDispatchOrder(
  dispatchOrderId: string,
  client?: PoolClient,
): Promise<DispatchDocument[]> {
  const result = await runner(client).query(
    `SELECT ${COLUMNS} FROM dispatch_document
     WHERE dispatch_order_id = $1
     ORDER BY generated_at ASC`,
    [dispatchOrderId],
  );
  return result.rows.map(mapRow);
}

export async function getDocumentById(
  documentId: string,
  client?: PoolClient,
): Promise<DispatchDocument | null> {
  const result = await runner(client).query(
    `SELECT ${COLUMNS} FROM dispatch_document WHERE document_id = $1`,
    [documentId],
  );
  return result.rows.length > 0 ? mapRow(result.rows[0]!) : null;
}

export async function clearDocumentsByDispatchOrder(
  dispatchOrderId: string,
  client?: PoolClient,
): Promise<number> {
  const result = await runner(client).query(
    `DELETE FROM dispatch_document WHERE dispatch_order_id = $1`,
    [dispatchOrderId],
  );
  return result.rowCount ?? 0;
}
