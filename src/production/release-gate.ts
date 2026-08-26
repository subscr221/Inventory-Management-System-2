import type { PoolClient } from 'pg';
import { getPool } from '../config/db.js';
import { AppError } from '../middleware/error.js';
import { getBomById } from '../read/projections/bom.js';
import { getAvailableBalanceUnderSite } from '../read/projections/stock_balance.js';
import { explodeBomForExecution } from '../engineering/bom-explosion.js';

/**
 * Story 6.1 production-order release gate (FR-MO-03).
 *
 * `evaluateReleaseGate` is PURE read-and-compute: it performs no persistence, no event emission and
 * no HTTP work, so a caller can run it inside its own transaction by passing a PoolClient. It is
 * deliberately NOT a release seam - the compliance seam (src/compliance/production-order.ts) owns
 * the transition rules; this service owns exactly the two checks FR-MO-03 adds on top of the
 * explosion service, plus the per-line availability verdict the dry-run read route and the release
 * path share.
 *
 * DELIBERATELY NO LOCK: the gate takes no FOR UPDATE lock on any stock_balance row and performs no
 * allocation. Availability is advisory at release - a caller that reads `satisfied: true` and
 * releases has a true statement about the moment of release, not a reservation. Hard enforcement
 * under lock is Story 6.2's staging and issue path. Do not read the absence of a lock as a defect.
 *
 * The BOM walk is DELEGATED, never re-implemented: the gate calls the exported Story 5.5 service
 * `explodeBomForExecution`, which already owns BOM existence (BOM_NOT_FOUND 404), the Story 5.4
 * R&D execution bar (RD_EXECUTION_BARRED 409), released-BOM and released-revision status
 * (BOM_NOT_RELEASED 409), date effectivity, the depth cap, cycle detection
 * (BOM_EXPLOSION_CYCLE_DETECTED 409) and the NUMERIC quantity contract
 * (EXPLOSION_QUANTITY_INVALID 400). The gate adds exactly two things: the output-item-to-BOM
 * identity check, and the per-line availability comparison. Every delegated code is surfaced
 * unchanged.
 *
 * This service NEVER throws INSUFFICIENT_STOCK: it reports `satisfied: false` plus per-line
 * shortfalls and the caller decides - the dry-run read route returns the same verdict as a 200 body
 * while the release path raises 409 INSUFFICIENT_STOCK. A truncated walk means the requirement set
 * is incomplete, so `depth_truncated: true` returns `satisfied: false` regardless of the per-line
 * verdicts; an explosion with zero requirement lines returns `satisfied: false` with
 * `empty_requirement_set: true`, never a trivially satisfied verdict (the Story 5.6 empty-rollup
 * decision applied here).
 *
 * All arithmetic happens in PostgreSQL NUMERIC: availability is summed by
 * getAvailableBalanceUnderSite (owned stock at or beneath the plant site, the generated `available`
 * column) and every comparison and shortfall is evaluated in SQL. No value in this path is ever
 * converted to a JS float.
 */

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface EvaluateReleaseGateInput {
  bom_id: string;
  output_item_id: string;
  plant_location_id: string;
  quantity: string;
  occurred_at?: string;
}

export interface ReleaseGateLine {
  component_item_id: string;
  component_sku: string;
  required_quantity: string;
  available_quantity: string;
  shortfall_quantity: string;
  satisfied: boolean;
}

export interface ReleaseGateResult {
  revision_id: string;
  business_date: string;
  depth_truncated: boolean;
  satisfied: boolean;
  empty_requirement_set: boolean;
  lines: ReleaseGateLine[];
}

function reject(
  code: string,
  message: string,
  details?: Record<string, unknown>,
  status: number = 400,
): never {
  throw new AppError(status, code, message, details);
}

/**
 * Compares availability against the requirement in SQL NUMERIC and returns the per-line verdict
 * plus an exact shortfall. NEVER parsed as a JS float.
 */
async function compareAvailability(
  componentSku: string,
  plantLocationId: string,
  requiredQuantity: string,
  client?: PoolClient,
): Promise<Pick<ReleaseGateLine, 'available_quantity' | 'shortfall_quantity' | 'satisfied'>> {
  const runner = client ?? getPool();
  const availableQuantity = await getAvailableBalanceUnderSite(
    componentSku,
    plantLocationId,
    client,
  );
  const result = await runner.query(
    `SELECT $1::numeric AS required_quantity,
            $2::numeric AS available_quantity,
            ($2::numeric >= $1::numeric) AS satisfied,
            GREATEST($1::numeric - $2::numeric, 0)::text AS shortfall_quantity`,
    [requiredQuantity, availableQuantity],
  );
  return {
    available_quantity: String(result.rows[0]!['available_quantity']),
    shortfall_quantity: result.rows[0]!['shortfall_quantity'] as string,
    satisfied: result.rows[0]!['satisfied'] === true,
  };
}

export async function evaluateReleaseGate(
  input: EvaluateReleaseGateInput,
  client?: PoolClient,
): Promise<ReleaseGateResult> {
  if (typeof input?.bom_id !== 'string' || !UUID_REGEX.test(input.bom_id)) {
    reject('INVALID_PARAMS', 'bom_id is required and must be a UUID');
  }
  if (typeof input?.output_item_id !== 'string' || !UUID_REGEX.test(input.output_item_id)) {
    reject('INVALID_PARAMS', 'output_item_id is required and must be a UUID');
  }
  if (typeof input?.plant_location_id !== 'string' || !UUID_REGEX.test(input.plant_location_id)) {
    reject('INVALID_PARAMS', 'plant_location_id is required and must be a UUID');
  }

  // Table 3 guard sequence is fail-closed and order-sensitive: identity before status, status
  // before quantity, quantity before availability, so an invalid input never reaches the walk.
  // Step 2 (BOM exists) is owned by explodeBomForExecution; the identity check below surfaces the
  // same BOM_NOT_FOUND code up front so the order-level check and the delegated check agree.
  const bom = await getBomById(input.bom_id, client);
  if (!bom) {
    reject('BOM_NOT_FOUND', 'BOM not found', { bom_id: input.bom_id }, 404);
  }
  // UUID_REGEX is case-insensitive while PostgreSQL renders uuid columns lowercase; normalize both
  // sides so an uppercase-but-valid input cannot produce a false BOM_ITEM_MISMATCH.
  if (bom.parent_item_id.toLowerCase() !== input.output_item_id.toLowerCase()) {
    reject(
      'BOM_ITEM_MISMATCH',
      'The BOM parent item does not match the production order output item',
      {
        bom_id: bom.bom_id,
        bom_parent_item_id: bom.parent_item_id,
        order_output_item_id: input.output_item_id,
      },
      409,
    );
  }

  // Steps 4 to 7 are delegated: assertNotRdDraft, released-BOM/revision status, the quantity
  // contract and cycle detection all live inside the service. Re-deriving any of them here would be
  // a defect, not a safety net.
  const explosion = await explodeBomForExecution(
    input.occurred_at !== undefined
      ? { bom_id: input.bom_id, quantity: input.quantity, occurred_at: input.occurred_at }
      : { bom_id: input.bom_id, quantity: input.quantity },
    client,
  );

  const lines: ReleaseGateLine[] = [];
  for (const requirement of explosion.requirements) {
    // Both directed_issue AND backflush lines count: AC5 says every component line.
    if (typeof requirement.component_sku !== 'string' || requirement.component_sku === '') {
      reject(
        'COMPONENT_SKU_UNRESOLVED',
        'A requirement line has no resolvable component SKU',
        {
          bom_id: input.bom_id,
          bom_line_id: requirement.bom_line_id,
          component_item_id: requirement.component_item_id,
        },
        409,
      );
    }
    const availability = await compareAvailability(
      requirement.component_sku,
      input.plant_location_id,
      requirement.required_quantity,
      client,
    );
    lines.push({
      component_item_id: requirement.component_item_id,
      component_sku: requirement.component_sku,
      required_quantity: requirement.required_quantity,
      ...availability,
    });
  }

  // A truncated walk means the requirement set is incomplete: releasing against it would commit
  // the order to a build whose full bill of materials is unknown. Never trivially satisfied.
  if (explosion.depth_truncated) {
    return {
      revision_id: explosion.revision_id,
      business_date: explosion.business_date,
      depth_truncated: true,
      satisfied: false,
      empty_requirement_set: false,
      lines,
    };
  }

  if (explosion.requirements.length === 0) {
    return {
      revision_id: explosion.revision_id,
      business_date: explosion.business_date,
      depth_truncated: false,
      satisfied: false,
      empty_requirement_set: true,
      lines,
    };
  }

  const satisfied = lines.every((line) => line.satisfied);
  return {
    revision_id: explosion.revision_id,
    business_date: explosion.business_date,
    depth_truncated: false,
    satisfied,
    empty_requirement_set: false,
    lines,
  };
}
