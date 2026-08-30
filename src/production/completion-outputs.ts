import type { PoolClient } from 'pg';
import { AppError } from '../middleware/error.js';
import { config } from '../config/index.js';
import type { ProductionOrderRow } from '../read/projections/production_order.js';

/**
 * Story 6.3 completion output resolver (FR-MO-07, FR-MO-09). The `src/production/release-gate.ts`
 * and `src/production/material-staging.ts` twin: PURE read-and-compute - no persistence, no event
 * emission, no HTTP work - so the seam runs it inside its own transaction by passing a PoolClient.
 *
 * Delegation, never re-implementation: the co-product and by-product outputs of an order are the
 * `output_class` lines Story 5.5 already models on `bom_line`, read from the revision the order was
 * RELEASED against (Binding Decision 2, the revision-pinning rule this story inherits verbatim from
 * 6.2). This module adds exactly three things: the output-class filter, the expected-yield
 * arithmetic, and the tolerance bounds of FR-MO-09.
 *
 * Every quantity leaves and re-enters as an exact decimal string; all arithmetic settles in
 * PostgreSQL NUMERIC. No value in this path is ever converted to a JS float, because a completion
 * that rounds through a binary float can post a lot whose quantity does not match the stock effect
 * the QC gate then refuses to accept.
 */

export interface CompletionSecondaryOutput {
  bom_line_id: string;
  line_no: number;
  output_class: 'co_product' | 'by_product';
  output_item_id: string;
  output_sku: string;
  expected_yield_percent: string;
  /** primary_quantity * expected_yield_percent / 100, settled in SQL NUMERIC. */
  quantity: string;
  uom: string;
  /**
   * The SPECIFICATION revision this output is inspected against. Story 8.1 keys an inspection plan
   * on (item_id, bom_revision_id) AND refuses a plan whose revision does not belong to the item
   * (INSPECTION_PLAN_SCOPE_MISMATCH), so a co-product cannot be governed by the parent order's
   * revision: it is inspected against its OWN released BOM revision. An output item with no
   * released BOM has no specification to inspect against and fails closed.
   */
  bom_revision_id: string;
}

export interface CompletionPrimaryOutput {
  output_item_id: string;
  output_sku: string;
  quantity: string;
  uom: string;
}

export interface CompletionOutputSet {
  revision_id: string;
  primary: CompletionPrimaryOutput;
  secondary: CompletionSecondaryOutput[];
}

export interface ResolveCompletionOutputsInput {
  order: ProductionOrderRow;
  primary_quantity: string;
  /**
   * IST calendar date used for BOM-line date effectivity. REQUIRED - there is no default (code
   * review 2026-08-31: the comment used to promise one, and passing undefined made every
   * effectivity comparison NULL, so the resolver returned zero co-products with no error).
   * Callers pass SERVER time, never a client-supplied instant.
   */
  business_date: string;
}

function reject(
  code: string,
  message: string,
  details?: Record<string, unknown>,
  status: number = 400,
): never {
  throw new AppError(status, code, message, details);
}

export async function resolveCompletionOutputs(
  input: ResolveCompletionOutputsInput,
  client: PoolClient,
): Promise<CompletionOutputSet> {
  const { order } = input;

  if (typeof input.business_date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(input.business_date)) {
    reject(
      'PRODUCTION_COMPLETION_DERIVATION_MISMATCH',
      'business_date is required to resolve BOM line effectivity',
      {
        production_order_id: order.production_order_id,
        business_date: input.business_date ?? null,
      },
      409,
    );
  }

  // Fail closed: an order with no pinned revision never passed the 6.1 release gate, and there is
  // nothing to resolve the co-product lines against.
  if (!order.released_revision_id) {
    reject(
      'BOM_REVISION_DRIFT',
      'The order carries no released BOM revision; it cannot be completed',
      { production_order_id: order.production_order_id, bom_id: order.bom_id },
      409,
    );
  }

  // Binding Decision 2, revision pinning - the SAME test src/production/material-staging.ts makes
  // (code review 2026-08-31). The original form here loaded the PINNED revision and checked it
  // belonged to the order's BOM, which is a self-comparison: it can never fail on drift, so
  // BOM_REVISION_DRIFT was present in name only and an ECO that moved bom.current_revision_id
  // after release was invisible to the completion path.
  const revision = await client.query(
    `SELECT br.revision_id, br.bom_id, b.current_revision_id
       FROM bom_revision br
       JOIN bom b ON b.bom_id = br.bom_id
      WHERE br.revision_id = $1`,
    [order.released_revision_id],
  );
  if (revision.rows.length === 0 || revision.rows[0]!['bom_id'] !== order.bom_id) {
    reject(
      'BOM_REVISION_DRIFT',
      'The order released revision does not resolve against the order BOM',
      {
        production_order_id: order.production_order_id,
        bom_id: order.bom_id,
        released_revision_id: order.released_revision_id,
      },
      409,
    );
  }
  if (revision.rows[0]!['current_revision_id'] !== order.released_revision_id) {
    reject(
      'BOM_REVISION_DRIFT',
      'The BOM revision has changed since the order was released; re-release or cancel the order before completing it',
      {
        production_order_id: order.production_order_id,
        bom_id: order.bom_id,
        released_revision_id: order.released_revision_id,
        current_revision_id: revision.rows[0]!['current_revision_id'],
      },
      409,
    );
  }

  const primaryItem = await client.query(
    `SELECT item_id, sku, uom FROM item_master WHERE item_id = $1`,
    [order.output_item_id],
  );
  if (primaryItem.rows.length === 0) {
    reject(
      'PRODUCTION_COMPLETION_DERIVATION_MISMATCH',
      'The order output item does not resolve in the item master',
      { production_order_id: order.production_order_id, output_item_id: order.output_item_id },
      409,
    );
  }

  // The co-product and by-product lines of the PINNED revision, effective on the business date.
  // expected_yield_percent is NOT NULL on these classes by database CHECK, so the multiplication
  // below can never silently produce a null quantity.
  const lines = await client.query(
    `SELECT bl.bom_line_id, bl.line_no, bl.output_class, bl.component_item_id, bl.component_sku,
            bl.expected_yield_percent::text AS expected_yield_percent,
            ($2::numeric * bl.expected_yield_percent / 100)::numeric(18,6)::text AS quantity,
            (($2::numeric * bl.expected_yield_percent / 100)::numeric(18,6) <= 0) AS non_positive,
            im.uom AS uom, im.item_id AS resolved_item_id,
            -- bom_id DESC is the tiebreaker (code review 2026-08-31): created_at defaults to the
            -- transaction timestamp, so two BOMs released together tie and an untiebroken LIMIT 1
            -- let the specification a co-product is inspected against differ between two identical
            -- completions of the same order.
            (SELECT b.current_revision_id FROM bom b
              WHERE b.parent_item_id = bl.component_item_id
                AND b.status = 'released' AND b.bom_type = 'production'
                AND b.current_revision_id IS NOT NULL
              ORDER BY b.created_at DESC, b.bom_id DESC LIMIT 1) AS output_revision_id
       FROM bom_line bl
       LEFT JOIN item_master im ON im.item_id = bl.component_item_id
      WHERE bl.revision_id = $1
        AND bl.output_class IN ('co_product','by_product')
        AND (bl.effective_from IS NULL OR bl.effective_from <= $3::date)
        AND (bl.effective_to IS NULL OR bl.effective_to >= $3::date)
      ORDER BY bl.line_no ASC, bl.bom_line_id ASC`,
    [order.released_revision_id, input.primary_quantity, input.business_date],
  );

  const secondary: CompletionSecondaryOutput[] = [];
  for (const row of lines.rows) {
    // Fail closed on an unresolvable secondary output: posting a lot with no uom would hand the QC
    // gate a declaration it must then reject, after the lot and its stock already exist.
    if (row['resolved_item_id'] === null || row['resolved_item_id'] === undefined) {
      reject(
        'PRODUCTION_COMPLETION_DERIVATION_MISMATCH',
        'A co-product or by-product line names an item that does not resolve in the item master',
        {
          production_order_id: order.production_order_id,
          bom_line_id: row['bom_line_id'],
          component_item_id: row['component_item_id'],
        },
        409,
      );
    }
    // Settled in SQL, not by string equality against two hard-coded literals (code review
    // 2026-08-31). expected_yield_percent carries no positivity CHECK, so a NEGATIVE yield produced
    // a quantity like '-0.000123' that passed the old string test, reached the insert and aborted
    // the whole completion on chk_production_completion_quantity_positive as a 500 - after the
    // primary lot and its stock had already been posted in the same transaction.
    if (row['non_positive'] === true) {
      const isZero = String(row['quantity']).replace('-', '').replace(/0|\./g, '') === '';
      if (!isZero) {
        reject(
          'PRODUCTION_COMPLETION_DERIVATION_MISMATCH',
          'A co-product or by-product line carries a negative expected yield',
          {
            production_order_id: order.production_order_id,
            bom_line_id: row['bom_line_id'],
            expected_yield_percent: row['expected_yield_percent'],
          },
          409,
        );
      }
      // A yield that rounds to zero cannot become a lot: there is no stock effect to post and the
      // QC gate would refuse a zero-quantity hand-off. Its absence from the payload is the record.
      continue;
    }
    // Fail closed on a co-product or by-product with no released specification of its own: the QC
    // gate would refuse the hand-off AFTER the lot and its stock already exist, so refuse before
    // anything is created and name the missing specification.
    if (row['output_revision_id'] === null || row['output_revision_id'] === undefined) {
      reject(
        'OUTPUT_SPECIFICATION_UNRESOLVED',
        'A co-product or by-product output has no released BOM revision to be inspected against',
        {
          production_order_id: order.production_order_id,
          bom_line_id: row['bom_line_id'],
          output_item_id: row['component_item_id'],
          output_class: row['output_class'],
        },
        409,
      );
    }
    // A secondary output that names the order's OWN output item would post stock of the primary
    // item under output_class co_product, which getCompletedPrimaryQuantity excludes - so the
    // quantity would never count toward the FR-MO-09 ceiling or floor (code review 2026-08-31).
    if (row['component_item_id'] === order.output_item_id) {
      reject(
        'PRODUCTION_COMPLETION_DERIVATION_MISMATCH',
        'A co-product or by-product line names the order output item; its yield would escape the completion tolerance',
        {
          production_order_id: order.production_order_id,
          bom_line_id: row['bom_line_id'],
          output_item_id: order.output_item_id,
        },
        409,
      );
    }
    // Two lines naming one item would mint two lots and two QC tasks for one physical output -
    // the shape the Story 6.2 backflush finding warned about (Previous Story Intelligence).
    if (secondary.some((existing) => existing.output_item_id === row['component_item_id'])) {
      reject(
        'PRODUCTION_COMPLETION_DERIVATION_MISMATCH',
        'Two co-product or by-product lines name the same output item',
        {
          production_order_id: order.production_order_id,
          bom_line_id: row['bom_line_id'],
          output_item_id: row['component_item_id'],
        },
        409,
      );
    }
    secondary.push({
      bom_line_id: row['bom_line_id'] as string,
      line_no: Number(row['line_no']),
      output_class: row['output_class'] as 'co_product' | 'by_product',
      output_item_id: row['component_item_id'] as string,
      output_sku: row['component_sku'] as string,
      expected_yield_percent: String(row['expected_yield_percent']),
      quantity: String(row['quantity']),
      uom: row['uom'] as string,
      bom_revision_id: row['output_revision_id'] as string,
    });
  }

  return {
    revision_id: order.released_revision_id,
    primary: {
      output_item_id: order.output_item_id,
      output_sku: order.output_sku,
      quantity: input.primary_quantity,
      uom: order.order_uom,
    },
    secondary,
  };
}

export interface CompletionToleranceVerdict {
  /** order_quantity * (1 + tolerance/100), exact decimal string. */
  ceiling: string;
  /** order_quantity * (1 - tolerance/100), exact decimal string. */
  floor: string;
  /** Cumulative primary quantity INCLUDING the quantity under test. */
  cumulative: string;
  /** True when the cumulative quantity would exceed the ceiling. */
  over: boolean;
  /** True when the cumulative quantity is below the floor. */
  short: boolean;
  tolerance_percent: string;
}

/**
 * The FR-MO-09 bounds. Both are measured against the CUMULATIVE primary quantity, never against a
 * single event: five small over-completions must not be able to walk past the ceiling one at a
 * time. Every comparison settles in SQL NUMERIC.
 */
export async function resolveCompletionTolerance(
  input: { order_quantity: string; prior_completed: string; additional: string },
  client: PoolClient,
): Promise<CompletionToleranceVerdict> {
  const tolerance = config.production.completionTolerancePercent;
  // The booleans compare the SAME rounded values the caller is told about (code review
  // 2026-08-31). Comparing the unrounded expressions while reporting rounded ones meant a
  // completion at exactly the ceiling a previous 403 had quoted could be rejected again.
  const result = await client.query(
    `WITH bounds AS (
       SELECT ($1::numeric * (1 + $4::numeric / 100))::numeric(18,6) AS ceiling,
              ($1::numeric * (1 - $4::numeric / 100))::numeric(18,6) AS floor,
              ($2::numeric + $3::numeric)::numeric(18,6) AS cumulative
     )
     SELECT ceiling::text AS ceiling,
            floor::text AS floor,
            cumulative::text AS cumulative,
            (cumulative > ceiling) AS over,
            (cumulative < floor) AS short
       FROM bounds`,
    [input.order_quantity, input.prior_completed, input.additional, tolerance],
  );
  const row = result.rows[0]!;
  return {
    ceiling: String(row['ceiling']),
    floor: String(row['floor']),
    cumulative: String(row['cumulative']),
    over: row['over'] === true,
    short: row['short'] === true,
    tolerance_percent: tolerance,
  };
}
