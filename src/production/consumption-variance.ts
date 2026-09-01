import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { AppError } from '../middleware/error.js';
import { config } from '../config/index.js';
import type { ProductionOrderRow } from '../read/projections/production_order.js';
import { getCompletedPrimaryQuantity } from '../read/projections/production_completion.js';
import { resolveMaterialRequirements, type MaterialRequirementLine } from './material-staging.js';
import {
  insertConsumptionVariance,
  type ProductionConsumptionVarianceRow,
} from '../read/projections/production_consumption_variance.js';

/**
 * Story 6.4 consumption variance report (FR-B-08). Written by the closure gate, inside the same
 * transaction as the production_order.state_changed event that closes the order.
 *
 * BASIS (binding decision): the expectation is exploded at the order's CUMULATIVE PRIMARY COMPLETED
 * quantity, not at its ordered quantity. FR-B-08 exists to recalibrate the BOM scrap percent, and
 * an order short-closed at 80 units would otherwise report a 20 percent under-consumption on every
 * single line - a measurement of the short close, not of scrap. Co-products and by-products are
 * excluded from the basis for the same reason Story 6.3 excludes them from the tolerance bounds:
 * they are separate outputs, not more of the ordered item.
 *
 * DELEGATION, never re-implementation: the requirement set comes from the Story 6.2 exported
 * resolver, which pins the order's released revision and delegates the walk to the Story 5.5
 * explosion service. This module adds only the actual-versus-expected arithmetic.
 *
 * GRACEFUL DEGRADATION (disclosed deviation): the resolver rejects when the BOM revision has moved
 * since release (BOM_REVISION_DRIFT) or when the walk truncates. Those are correct answers for
 * EXECUTION - never issue material against an unknown requirement set - but closure is not
 * execution: an engineering change made after the last confirmation must not permanently trap a
 * finished order in `completed`. The report is therefore best-effort: a resolver rejection is
 * caught, no rows are written, and the closure payload records `variance_computed: false` with the
 * reason code, so the gap is visible rather than silent. Every other failure still aborts the
 * transaction.
 */

export interface ConsumptionVarianceResult {
  computed: boolean;
  /** The error_code that prevented computation; null when the report was produced. */
  unavailable_reason: string | null;
  basis_quantity: string;
  revision_id: string | null;
  tolerance_percent: string;
  lines: ProductionConsumptionVarianceRow[];
  breached_line_count: number;
}

interface ActualConsumptionRow {
  bom_line_id: string;
  component_item_id: string;
  component_sku: string;
  actual_quantity: string;
  supply_method: 'directed_issue' | 'backflush';
}

/**
 * Net consumption per BOM line, settled in SQL NUMERIC: issue and backflush postings add, RETURN
 * postings subtract (the material went back on the shelf). Relief postings are excluded - a relief
 * closes open WIP value, it does not un-consume material, and counting it would subtract every
 * consumption from itself at completion time.
 */
async function getActualConsumptionByLine(
  orderId: string,
  client: PoolClient,
): Promise<ActualConsumptionRow[]> {
  const result = await client.query(
    `SELECT bom_line_id,
            MIN(component_item_id::text) AS component_item_id,
            MIN(component_sku) AS component_sku,
            SUM(
              CASE WHEN posting_type IN ('directed_issue','backflush') THEN quantity
                   WHEN posting_type = 'return' THEN -quantity
                   ELSE 0 END
            )::text AS actual_quantity,
            -- The supply method is DERIVED from the postings, never guessed: it is the only honest
            -- answer for a line the pinned revision no longer requires, where no requirement row
            -- exists to read it from.
            bool_or(posting_type = 'directed_issue') AS has_directed_issue
       FROM production_wip_ledger
      WHERE production_order_id = $1
        AND posting_type IN ('directed_issue','backflush','return')
      GROUP BY bom_line_id`,
    [orderId],
  );
  return result.rows.map((row) => ({
    bom_line_id: row['bom_line_id'] as string,
    component_item_id: row['component_item_id'] as string,
    component_sku: row['component_sku'] as string,
    actual_quantity: String(row['actual_quantity']),
    supply_method: row['has_directed_issue'] === true ? 'directed_issue' : 'backflush',
  }));
}

/**
 * The requirement with this line's OWN scrap allowance removed: required / (1 + scrap/100).
 *
 * Deliberately NOT `base_quantity_per * basis`. base_quantity_per is the line's factor against its
 * immediate BOM parent, so on a multi-level explosion it is not a per-unit-of-finished-good figure
 * at all and would understate the expectation by every intermediate level's factor. Dividing the
 * already-exploded requirement by its own scrap factor removes exactly the allowance being
 * recalibrated, at any depth, and leaves any parent-level allowance embedded - which is correct:
 * this line's scrap percent is being measured given everything above it.
 *
 * Settled in SQL NUMERIC at the ledger's own scale, never through a JS float.
 */
async function requirementWithoutScrap(
  client: PoolClient,
  requiredQuantity: string,
  scrapPercent: string | null,
): Promise<string> {
  // Code review 2026-09-01: a scrap_percent at or below -100 drives the denominator to zero (or
  // negative), which Postgres rejects with a division-by-zero error that would abort the whole
  // closure transaction. A scrap percent that low is nonsensical (it would mean more material
  // returns than goes in), so it is rejected here as bad BOM data rather than left to blow up SQL.
  if (scrapPercent !== null && Number(scrapPercent) <= -100) {
    throw new AppError(409, 'INVALID_SCRAP_PERCENT', 'BOM line scrap_percent cannot be <= -100', {
      scrap_percent: scrapPercent,
    });
  }
  const result = await client.query(
    `SELECT ROUND($1::numeric / (1 + COALESCE($2::numeric, 0) / 100), 6)::text AS base`,
    [requiredQuantity, scrapPercent],
  );
  return String(result.rows[0]!['base']);
}

export async function computeConsumptionVariance(
  order: ProductionOrderRow,
  sourceEventId: string,
  client: PoolClient,
): Promise<ConsumptionVarianceResult> {
  const tolerancePercent = config.production.consumptionVarianceTolerancePercent;
  const basisQuantity = await getCompletedPrimaryQuantity(order.production_order_id, client);
  const actuals = await getActualConsumptionByLine(order.production_order_id, client);

  let requirementLines: MaterialRequirementLine[] = [];
  let revisionId: string | null = null;
  try {
    // Both supply methods, because both consume material and both post to the WIP ledger. The
    // resolver filters to one method per call, so it is called once per method and the results are
    // concatenated - the BOM line ids are disjoint across methods by construction.
    for (const supplyMethod of ['directed_issue', 'backflush'] as const) {
      const set = await resolveMaterialRequirements(
        { order, quantity: basisQuantity, supplyMethodFilter: supplyMethod },
        client,
      );
      revisionId = set.revision_id;
      requirementLines = requirementLines.concat(set.lines);
    }
  } catch (err: unknown) {
    if (err instanceof AppError) {
      // Code review 2026-09-01: closure intentionally proceeds when variance can't be computed
      // (a BOM that moved under the order is not a reason to trap a finished order), but the
      // failure was previously silent. Logged so a degraded variance report is visible to ops
      // rather than only discoverable by reading computed: false off the event payload.
      console.error('consumption variance computation degraded at closure', {
        production_order_id: order.production_order_id,
        error_code: err.errorCode,
      });
      return {
        computed: false,
        unavailable_reason: err.errorCode,
        basis_quantity: basisQuantity,
        revision_id: null,
        tolerance_percent: tolerancePercent,
        lines: [],
        breached_line_count: 0,
      };
    }
    throw err;
  }

  if (revisionId === null) {
    // An order with a released revision always resolves one; this is unreachable in practice and is
    // reported rather than thrown so closure is never blocked by the report.
    return {
      computed: false,
      unavailable_reason: 'MATERIAL_REQUIREMENT_SET_UNRESOLVED',
      basis_quantity: basisQuantity,
      revision_id: null,
      tolerance_percent: tolerancePercent,
      lines: [],
      breached_line_count: 0,
    };
  }

  const requirementByLine = new Map<string, MaterialRequirementLine>();
  for (const line of requirementLines) requirementByLine.set(line.bom_line_id, line);
  const actualByLine = new Map<string, ActualConsumptionRow>();
  for (const row of actuals) actualByLine.set(row.bom_line_id, row);

  // The union of both sides: a required line never consumed is a 100 percent under-consumption, and
  // a line consumed that the pinned revision no longer requires is consumption against a zero
  // expectation. Reporting only the intersection would hide exactly the two cases worth flagging.
  const bomLineIds = [...new Set([...requirementByLine.keys(), ...actualByLine.keys()])].sort();

  const lines: ProductionConsumptionVarianceRow[] = [];
  for (const bomLineId of bomLineIds) {
    const requirement = requirementByLine.get(bomLineId);
    const actual = actualByLine.get(bomLineId);
    const expectedQuantity = requirement?.required_quantity ?? '0';
    const expectedBaseQuantity = requirement
      ? await requirementWithoutScrap(
          client,
          requirement.required_quantity,
          requirement.scrap_percent,
        )
      : '0';
    const componentItemId = requirement?.component_item_id ?? actual?.component_item_id ?? null;
    const componentSku = requirement?.component_sku ?? actual?.component_sku ?? null;
    if (componentItemId === null || componentSku === null) continue;
    const row = await insertConsumptionVariance(
      {
        variance_id: randomUUID(),
        production_order_id: order.production_order_id,
        bom_line_id: bomLineId,
        component_item_id: componentItemId,
        component_sku: componentSku,
        supply_method: requirement?.supply_method ?? actual!.supply_method,
        basis_quantity: basisQuantity,
        expected_quantity: expectedQuantity,
        expected_base_quantity: expectedBaseQuantity,
        actual_quantity: actual?.actual_quantity ?? '0',
        bom_scrap_percent: requirement?.scrap_percent ?? null,
        tolerance_percent: tolerancePercent,
        revision_id: revisionId,
        source_event_id: sourceEventId,
      },
      client,
    );
    lines.push(row);
  }

  return {
    computed: true,
    unavailable_reason: null,
    basis_quantity: basisQuantity,
    revision_id: revisionId,
    tolerance_percent: tolerancePercent,
    lines,
    breached_line_count: lines.filter((line) => line.tolerance_breached).length,
  };
}
