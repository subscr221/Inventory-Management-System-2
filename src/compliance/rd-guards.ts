import type { PoolClient } from 'pg';
import { AppError } from '../middleware/error.js';

/**
 * Story 10.1 (FR-RD-01..03): the single shared R&D rule. The pure asserts take already-loaded
 * rows; `assertRdIssueGuards` loads them (inside the caller's transaction) for the material-issue
 * seam. Demand is R&D when the requisition's business stream is research or maker_hub.
 */

const RD_LOCATION_TYPES = new Set(['rd_store', 'maker_hub_store']);
const RD_DEMAND_STREAMS = new Set(['research', 'maker_hub']);

export interface RdLotFacts {
  rd_designated: boolean;
}
export interface RdLocationFacts {
  location_type: string;
}
export interface RdProjectFacts {
  status: string;
}

export function isRdSource(lot: RdLotFacts | null, location: RdLocationFacts | null): boolean {
  return (lot?.rd_designated ?? false) || RD_LOCATION_TYPES.has(location?.location_type ?? '');
}

export function assertRdCrossIssue(
  lot: RdLotFacts | null,
  sourceLocation: RdLocationFacts | null,
  demandIsRd: boolean,
  approvedReclass: boolean,
): void {
  if (isRdSource(lot, sourceLocation) && !demandIsRd && !approvedReclass) {
    throw new AppError(
      409,
      'CROSS_ISSUE_BLOCKED',
      'R&D stock cannot be issued to non-R&D demand without an approved reclassification',
    );
  }
}

export function assertProjectCodeActive(
  projectCode: string | null | undefined,
  project: RdProjectFacts | null,
): void {
  if (!projectCode || !project || project.status !== 'active') {
    throw new AppError(
      409,
      'PROJECT_CODE_REQUIRED',
      'An R&D material transaction needs an active project code',
      { project_code: projectCode ?? null },
    );
  }
}

/** Runs both guards for one issued line; no-op for non-R&D stock to non-R&D demand. */
export async function assertRdIssueGuards(
  client: PoolClient,
  line: { location_id: string; lot_id: string | null; sku: string },
  businessStream: string,
  rawProjectCode: string | null,
): Promise<void> {
  const projectCode = rawProjectCode?.trim().toUpperCase() || null;
  const loc = await client.query(
    'SELECT location_type FROM location_register WHERE location_id = $1',
    [line.location_id],
  );
  if (loc.rows.length === 0) {
    throw new AppError(404, 'LOCATION_NOT_FOUND', 'Issue location not found', {
      location_id: line.location_id,
    });
  }
  const location = loc.rows[0] as RdLocationFacts;
  let lot: RdLotFacts | null = null;
  let approvedReclass = false;
  if (line.lot_id) {
    // The issue line names a lot by lot_number or lot_id (see getLotById), scoped to the line's sku.
    const l = await client.query(
      `SELECT lot_id, rd_designated FROM lot_master WHERE sku = $2 AND (lot_id::text = $1 OR lot_number = $1) LIMIT 1`,
      [line.lot_id, line.sku],
    );
    if (l.rows.length === 0) {
      throw new AppError(404, 'LOT_NOT_FOUND', 'Issue line names a lot that does not exist', {
        lot_id: line.lot_id,
        sku: line.sku,
      });
    }
    lot = l.rows[0] as RdLotFacts;
    const r = await client.query(
      `SELECT 1 FROM rd_reclassification WHERE lot_id = $1 AND status = 'approved' AND approved_by <> requested_by LIMIT 1`,
      [l.rows[0].lot_id],
    );
    approvedReclass = r.rows.length > 0;
  }
  const demandIsRd = RD_DEMAND_STREAMS.has(businessStream);
  assertRdCrossIssue(lot, location, demandIsRd, approvedReclass);
  if (demandIsRd) {
    const p = projectCode
      ? await client.query('SELECT status FROM rd_project WHERE project_code = $1', [projectCode])
      : null;
    assertProjectCodeActive(projectCode, (p?.rows[0] as RdProjectFacts | undefined) ?? null);
  }
}
