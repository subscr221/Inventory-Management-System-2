import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';
import type { RdScrapPendingRow } from './rd_disposition.js';

export async function listRdScrapPendingByPrototype(
  prototypeId: string,
  client?: PoolClient,
): Promise<RdScrapPendingRow[]> {
  const result = await (client ?? getPool()).query(
    'SELECT * FROM rd_scrap_pending WHERE prototype_id = $1 ORDER BY created_at, scrap_pending_id',
    [prototypeId],
  );
  return result.rows as RdScrapPendingRow[];
}

export async function listRdScrapPendingByProject(
  projectCode: string,
  client?: PoolClient,
): Promise<RdScrapPendingRow[]> {
  const result = await (client ?? getPool()).query(
    'SELECT * FROM rd_scrap_pending WHERE project_code = $1 ORDER BY created_at, scrap_pending_id',
    [projectCode],
  );
  return result.rows as RdScrapPendingRow[];
}
