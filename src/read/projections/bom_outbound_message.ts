import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';
import type { BomOutboundPayload } from '../../adapters/erp/bom-outbound.js';

/**
 * Story 5.6 BOM outbound message accessor (FR-B-17, INT-ERP-01), mirroring
 * insertPoOutboundMessage / getPoOutboundMessage in purchase_order.ts. Placed in its own module
 * rather than bom.ts, which is already the BOM module's largest accessor file.
 *
 * The row is DERIVED state written atomically with bom.released inside the same persistEvent
 * transaction. Live transmission to the ERP is per-deployment configuration and out of scope.
 */

export interface BomOutboundMessageRow {
  message_id: string;
  bom_id: string;
  revision_id: string;
  payload: BomOutboundPayload;
  recorded_at: string;
}

type Queryable = Pick<PoolClient, 'query'>;

function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function insertBomOutboundMessage(
  messageId: string,
  bomId: string,
  revisionId: string,
  payload: BomOutboundPayload,
  client: PoolClient,
): Promise<void> {
  await client.query(
    `INSERT INTO bom_outbound_message (message_id, bom_id, revision_id, payload)
     VALUES ($1, $2, $3, $4::jsonb)`,
    [messageId, bomId, revisionId, JSON.stringify(payload)],
  );
}

/** The most recent outbound message recorded for a BOM, or null when it has never published. */
export async function getBomOutboundMessage(
  bomId: string,
  client?: PoolClient,
): Promise<BomOutboundMessageRow | null> {
  if (!UUID_REGEX.test(bomId)) return null;
  const result = await runner(client).query(
    `SELECT message_id, bom_id, revision_id, payload, recorded_at
       FROM bom_outbound_message WHERE bom_id = $1 ORDER BY recorded_at DESC LIMIT 1`,
    [bomId],
  );
  return (result.rows[0] as BomOutboundMessageRow) ?? null;
}
