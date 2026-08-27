import type { PoolClient } from 'pg';
import { AppError } from '../middleware/error.js';
import { explodeBomForExecution } from '../engineering/bom-explosion.js';
import type { BomExplosionAlternate } from '../events/schema.js';
import type { ProductionOrderRow } from '../read/projections/production_order.js';

/**
 * Story 6.2 requirement-set service (FR-MO-04). The `src/production/release-gate.ts` twin: PURE
 * read-and-compute - no persistence, no event emission, no HTTP work - so a caller can run it
 * inside its own transaction by passing a PoolClient.
 *
 * Delegation, never re-implementation (Binding Decision 1): the BOM walk is delegated to the
 * exported Story 5.5 service `explodeBomForExecution`, which already owns BOM existence
 * (BOM_NOT_FOUND 404), the R&D execution bar (RD_EXECUTION_BARRED 409), released-BOM/revision
 * status (BOM_NOT_RELEASED 409), date effectivity, the NUMERIC quantity contract
 * (EXPLOSION_QUANTITY_INVALID 400), cycle detection, the depth cap and phantom pass-through.
 * This service adds exactly three things on top: the supply-method filter, revision pinning
 * against the order's released revision (Binding Decision 2), and the truncated-set rejection.
 * Staging explodes at the ORDER quantity; backflush explodes at the CONFIRMED quantity
 * (proportionality by construction - AC2); both filter the result by supply_method.
 *
 * All arithmetic happens in PostgreSQL NUMERIC inside the delegated walk; quantities leave and
 * re-enter as exact decimal strings. No value in this path is ever converted to a JS float.
 */

export interface MaterialRequirementLine {
  bom_line_id: string;
  line_no: number;
  component_item_id: string;
  component_sku: string;
  supply_method: 'directed_issue' | 'backflush';
  required_quantity: string;
  scrap_percent: string | null;
  base_quantity_per: string;
  alternates: BomExplosionAlternate[];
}

export interface MaterialRequirementSet {
  revision_id: string;
  business_date: string;
  depth_truncated: boolean;
  lines: MaterialRequirementLine[];
}

export interface ResolveMaterialRequirementsInput {
  order: ProductionOrderRow;
  quantity: string;
  supplyMethodFilter: 'directed_issue' | 'backflush';
  occurred_at?: string;
}

function reject(
  code: string,
  message: string,
  details?: Record<string, unknown>,
  status: number = 400,
): never {
  throw new AppError(status, code, message, details);
}

export async function resolveMaterialRequirements(
  input: ResolveMaterialRequirementsInput,
  client?: PoolClient,
): Promise<MaterialRequirementSet> {
  const explosion = await explodeBomForExecution(
    input.occurred_at !== undefined
      ? { bom_id: input.order.bom_id, quantity: input.quantity, occurred_at: input.occurred_at }
      : { bom_id: input.order.bom_id, quantity: input.quantity },
    client,
  );

  // Binding Decision 2: revision pinning. A Released order executes against the revision it was
  // gated against; if an ECO moved the BOM (Story 5.3), execution blocks until a conscious
  // re-release or cancel. A null released_revision_id (an order that somehow left planned without
  // a release) is a drift too - there is nothing to pin to.
  if (explosion.revision_id !== input.order.released_revision_id) {
    reject(
      'BOM_REVISION_DRIFT',
      'The BOM revision has changed since the order was released; re-release or cancel the order before executing it',
      {
        production_order_id: input.order.production_order_id,
        bom_id: input.order.bom_id,
        released_revision_id: input.order.released_revision_id,
        current_revision_id: explosion.revision_id,
      },
      409,
    );
  }

  // Binding Decision 1 / the 6.1 release-gate precedent: a truncated walk means the requirement
  // set is incomplete - never execute against it.
  if (explosion.depth_truncated) {
    reject(
      'MATERIAL_REQUIREMENT_SET_TRUNCATED',
      'The BOM explosion was depth-truncated; the requirement set is incomplete',
      {
        production_order_id: input.order.production_order_id,
        bom_id: input.order.bom_id,
        depth_truncated: true,
      },
      409,
    );
  }

  const lines: MaterialRequirementLine[] = [];
  for (const requirement of explosion.requirements) {
    if (requirement.supply_method !== input.supplyMethodFilter) continue;
    if (typeof requirement.component_sku !== 'string' || requirement.component_sku === '') {
      reject(
        'COMPONENT_SKU_UNRESOLVED',
        'A requirement line has no resolvable component SKU',
        {
          production_order_id: input.order.production_order_id,
          bom_id: input.order.bom_id,
          bom_line_id: requirement.bom_line_id,
          component_item_id: requirement.component_item_id,
        },
        409,
      );
    }
    lines.push({
      bom_line_id: requirement.bom_line_id,
      line_no: requirement.line_no,
      component_item_id: requirement.component_item_id,
      component_sku: requirement.component_sku,
      supply_method: requirement.supply_method,
      required_quantity: requirement.required_quantity,
      scrap_percent: requirement.scrap_percent,
      base_quantity_per: requirement.base_quantity_per,
      alternates: requirement.alternates,
    });
  }

  return {
    revision_id: explosion.revision_id,
    business_date: explosion.business_date,
    depth_truncated: false,
    lines,
  };
}
