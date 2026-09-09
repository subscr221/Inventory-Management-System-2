import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';
import { dateColumnToString } from './site_gstin.js';

/**
 * Branch transfer statutory classification (Story 11.5, code review D1): the supply class STAMPED
 * at transfer_request.created, one row per transfer regardless of class. The ship gate reads this
 * row; it must never re-derive the class from site_gstin, because that configuration is dated and
 * mutable - a registration edited between create and ship would silently reclassify an in-flight
 * transfer and either demand documents that were never required or waive documents that were.
 *
 * Sibling of branch_transfer_valuation (which exists only for `inter_gstin`), written ONLY by the
 * transfer-seam applier inside the event transaction. `from_gstin_ext` / `to_gstin_ext` record the
 * registrations the class was decided on: both NULL for `intra_site`, and for `intra_gstin` the one
 * shared GSTIN is written to BOTH columns so the resolved evidence is never half-recorded.
 */

export const BRANCH_TRANSFER_SUPPLY_CLASSES = ['intra_site', 'intra_gstin', 'inter_gstin'] as const;
export type BranchTransferSupplyClass = (typeof BRANCH_TRANSFER_SUPPLY_CLASSES)[number];

export function isBranchTransferSupplyClass(value: unknown): value is BranchTransferSupplyClass {
  return (
    typeof value === 'string' &&
    (BRANCH_TRANSFER_SUPPLY_CLASSES as readonly string[]).includes(value)
  );
}

export interface BranchTransferClassificationRow {
  transfer_request_id: string;
  supply_class: BranchTransferSupplyClass;
  from_site_id: string;
  to_site_id: string;
  from_gstin_ext: string | null;
  to_gstin_ext: string | null;
  business_date: string;
  source_event_id: string;
  created_at: string;
  updated_at: string;
}

export interface InsertBranchTransferClassificationInput {
  transfer_request_id: string;
  supply_class: BranchTransferSupplyClass;
  from_site_id: string;
  to_site_id: string;
  from_gstin_ext: string | null;
  to_gstin_ext: string | null;
  business_date: string;
  source_event_id: string;
}

type Queryable = Pick<PoolClient, 'query'>;

function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}

function ts(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

const CLASSIFICATION_COLUMNS = `transfer_request_id, supply_class, from_site_id, to_site_id,
       from_gstin_ext, to_gstin_ext, business_date, source_event_id, created_at, updated_at`;

function mapClassification(row: Record<string, unknown>): BranchTransferClassificationRow {
  return {
    transfer_request_id: row['transfer_request_id'] as string,
    supply_class: row['supply_class'] as BranchTransferSupplyClass,
    from_site_id: row['from_site_id'] as string,
    to_site_id: row['to_site_id'] as string,
    from_gstin_ext: (row['from_gstin_ext'] as string | null) ?? null,
    to_gstin_ext: (row['to_gstin_ext'] as string | null) ?? null,
    business_date: dateColumnToString(row['business_date']),
    source_event_id: row['source_event_id'] as string,
    created_at: ts(row['created_at']),
    updated_at: ts(row['updated_at']),
  };
}

/**
 * Inserts the stamped classification inside the transfer_request.created transaction, following
 * insertBranchTransferValuation: a plain INSERT with no ON CONFLICT clause, so a replayed create
 * raises the primary-key violation rather than quietly re-stamping a class the ship gate has
 * already read. Replay suppression is the event store's job at the seam, not this projection's.
 */
export async function insertBranchTransferClassification(
  input: InsertBranchTransferClassificationInput,
  client: PoolClient,
): Promise<BranchTransferClassificationRow> {
  const result = await client.query(
    `INSERT INTO branch_transfer_classification
       (transfer_request_id, supply_class, from_site_id, to_site_id, from_gstin_ext, to_gstin_ext,
        business_date, source_event_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING ${CLASSIFICATION_COLUMNS}`,
    [
      input.transfer_request_id,
      input.supply_class,
      input.from_site_id,
      input.to_site_id,
      input.from_gstin_ext,
      input.to_gstin_ext,
      input.business_date,
      input.source_event_id,
    ],
  );
  return mapClassification(result.rows[0]!);
}

/**
 * The class stamped for a transfer, or null when none was stamped - a legacy transfer created
 * before this table existed. The ship gate must treat null as unclassified and refuse, never as
 * an invitation to re-derive the class from current configuration.
 */
export async function getBranchTransferClassification(
  transferRequestId: string,
  client?: PoolClient,
): Promise<BranchTransferClassificationRow | null> {
  const result = await runner(client).query(
    `SELECT ${CLASSIFICATION_COLUMNS} FROM branch_transfer_classification
      WHERE transfer_request_id = $1`,
    [transferRequestId],
  );
  return result.rows.length > 0 ? mapClassification(result.rows[0]!) : null;
}

/**
 * Code review E3-P: the whole page's classifications in ONE query, keyed by transfer_request_id.
 * The transfer-request LIST route used to fan out one classification (and one valuation, and one
 * document) read PER ROW, so a fifty-row page cost fifty round trips against a table it could have
 * read with a single ANY(). Transfers with no stamp are simply absent from the Map - the caller
 * distinguishes them the same way getBranchTransferClassification's null does, and must treat them
 * as unclassified rather than re-deriving the class.
 */
export async function getBranchTransferClassifications(
  transferRequestIds: string[],
  client?: PoolClient,
): Promise<Map<string, BranchTransferClassificationRow>> {
  const out = new Map<string, BranchTransferClassificationRow>();
  if (transferRequestIds.length === 0) return out;
  const result = await runner(client).query(
    `SELECT ${CLASSIFICATION_COLUMNS} FROM branch_transfer_classification
      WHERE transfer_request_id = ANY($1::uuid[])`,
    [transferRequestIds],
  );
  for (const row of result.rows) {
    const mapped = mapClassification(row);
    out.set(mapped.transfer_request_id, mapped);
  }
  return out;
}
