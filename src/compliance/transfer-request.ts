import type { PoolClient } from 'pg';
import type { EventEnvelope } from '../events/store.js';
import { AppError } from '../middleware/error.js';
import { getLocationById } from '../read/projections/location_register.js';
import { assertQcGateAllows, gateBusinessDateOf } from './quality.js';
import {
  applyStockAllocation,
  applyStockIssue,
  applyStockReceipt,
  applyStockDeallocation,
} from '../read/projections/stock_balance.js';
import type {
  StockAllocationInput,
  StockIssueInput,
  StockReceiptInput,
  StockDeallocationInput,
} from '../read/projections/stock_balance.js';
import {
  insertInTransitRecord,
  decrementInTransit,
  clearInTransitRecord,
  getInTransitByTransferRequest,
} from '../read/projections/in_transit.js';
import {
  insertTransferRequest,
  updateTransferRequestStatus,
  getTransferRequestById,
} from '../read/projections/transfer_request.js';
import type { TransferRequestRow } from '../read/projections/transfer_request.js';
import { config } from '../config/index.js';
import { lockInventoryValuation, monToNum } from '../read/projections/inventory_valuation.js';
import type { AuditEntryPayload } from '../read/projections/audit_log.js';
import { logRejectionAudit } from '../read/projections/audit_log.js';
import { findSiteGstin } from '../read/projections/site_gstin.js';
import {
  findValuationConfig,
  isRule28Basis,
} from '../read/projections/branch_transfer_valuation_config.js';
import type {
  Rule28Basis,
  ValuationConfigRow,
} from '../read/projections/branch_transfer_valuation_config.js';
import {
  getBranchTransferValuation,
  insertBranchTransferValuation,
  overrideBranchTransferValuation,
  getBranchTransferGstDocument,
  insertBranchTransferGstDocument,
  branchTransferHasGstDocument,
  GST_DOCUMENT_KINDS,
} from '../read/projections/branch_transfer_gst.js';
import type {
  BranchTransferValuationRow,
  BranchTransferGstDocumentRow,
  GstDocumentKind,
} from '../read/projections/branch_transfer_gst.js';
import {
  getBranchTransferClassification,
  insertBranchTransferClassification,
} from '../read/projections/branch_transfer_classification.js';
import type { BranchTransferClassificationRow } from '../read/projections/branch_transfer_classification.js';
import { IRN_EXT_REGEX, normalizeIrnExt, isValidIrpAcknowledgedAt } from './irn.js';

/**
 * Bridges a lot_master.lot_id UUID to the lot_number TEXT key stock_balance rows carry.
 *
 * EXPORTED 2026-09-05: the reject handler in src/api/v1/transfer-requests.ts was releasing an
 * allocation with the raw UUID against stock_balance.lot_id, which holds the NUMBER, so the UPDATE
 * matched no rows and every rejected transfer leaked its allocation permanently. Every path that
 * touches stock_balance by lot must go through THIS function.
 */
export async function lotNumberForUuid(
  lotUuid: string,
  sku: string,
  client: PoolClient,
): Promise<string> {
  const result = await client.query(
    `SELECT lot_number FROM lot_master WHERE lot_id = $1 AND sku = $2`,
    [lotUuid, sku],
  );
  if (result.rows.length === 0) {
    throw new AppError(
      404,
      'LOT_NOT_FOUND',
      `No lot exists for lot_id "${lotUuid}" and sku "${sku}"`,
      { lot_id: lotUuid, sku },
    );
  }
  return result.rows[0]!['lot_number'] as string;
}

// ---------------------------------------------------------------------------
// Shape validation helpers
// ---------------------------------------------------------------------------

function isPositiveFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

const MAX_QUANTITY = 1e12;

// ---------------------------------------------------------------------------
// Task 1: TransferRequestCreated shape validation (pre-transaction)
// ---------------------------------------------------------------------------

export function assertTransferRequestShape(envelope: EventEnvelope): void {
  if (envelope.event_type !== 'transfer_request.created') return;

  const p = envelope.payload as Record<string, unknown>;

  if (!isNonEmptyString(p['transfer_request_id'])) {
    throw new AppError(
      400,
      'INVALID_PARAMS',
      'transfer_request_id is required and must be a non-empty string',
    );
  }
  if (!isNonEmptyString(p['sku_id'])) {
    throw new AppError(400, 'INVALID_PARAMS', 'sku_id is required and must be a non-empty string');
  }
  if (!isNonEmptyString(p['from_location_id'])) {
    throw new AppError(
      400,
      'INVALID_PARAMS',
      'from_location_id is required and must be a non-empty string',
    );
  }
  if (!isNonEmptyString(p['to_location_id'])) {
    throw new AppError(
      400,
      'INVALID_PARAMS',
      'to_location_id is required and must be a non-empty string',
    );
  }
  if (!isNonEmptyString(p['business_stream'])) {
    throw new AppError(
      400,
      'INVALID_PARAMS',
      'business_stream is required and must be a non-empty string',
    );
  }

  if (p['from_location_id'] === p['to_location_id']) {
    throw new AppError(
      400,
      'INVALID_LOCATION',
      'from_location_id and to_location_id must be different',
    );
  }

  if (!isPositiveFiniteNumber(p['quantity'])) {
    throw new AppError(400, 'INVALID_PARAMS', 'quantity is required and must be a positive number');
  }
  if (p['quantity'] > MAX_QUANTITY) {
    throw new AppError(
      400,
      'INVALID_PARAMS',
      `quantity exceeds the maximum allowed value of ${MAX_QUANTITY}`,
    );
  }

  if (p['lot_id'] !== undefined && !isNonEmptyString(p['lot_id'])) {
    throw new AppError(400, 'INVALID_PARAMS', 'lot_id must be a non-empty string when supplied');
  }

  if (p['serial_ids'] !== undefined) {
    if (!Array.isArray(p['serial_ids']) || p['serial_ids'].length === 0) {
      throw new AppError(
        400,
        'INVALID_PARAMS',
        'serial_ids must be a non-empty array when supplied',
      );
    }
    for (const s of p['serial_ids']) {
      if (!isNonEmptyString(s)) {
        throw new AppError(400, 'INVALID_PARAMS', 'serial_ids must contain only non-empty strings');
      }
    }
  }

  if (p['notes'] !== undefined && typeof p['notes'] !== 'string') {
    throw new AppError(400, 'INVALID_PARAMS', 'notes must be a string when supplied');
  }

  // Story 11.5 (Task 3.5): the creator may declare a unit value for the non-cost Rule 28 bases;
  // everything the seam derives (basis, taxable value, the two GSTINs) and every *_by attribution
  // field is REFUSED on input, not silently dropped (the 11.2 so_number_ext rule).
  assertNoServerDerivedValuationFields(p);
  if (p['declared_unit_value'] !== undefined && !isPositiveDecimal(p['declared_unit_value'])) {
    throw new AppError(
      400,
      'INVALID_PARAMS',
      'declared_unit_value must be a positive number or numeric string when supplied',
    );
  }
}

// ---------------------------------------------------------------------------
// Story 11.5: Rule 28 valuation helpers (pure)
// ---------------------------------------------------------------------------

const SERVER_DERIVED_VALUATION_FIELDS = [
  'valuation_basis',
  'taxable_value',
  'unit_value',
  'from_gstin_ext',
  'to_gstin_ext',
  'basis_source',
];

function assertNoServerDerivedValuationFields(p: Record<string, unknown>): void {
  for (const key of Object.keys(p)) {
    if (SERVER_DERIVED_VALUATION_FIELDS.includes(key) || /_by$/.test(key)) {
      throw new AppError(
        400,
        'INVALID_PARAMS',
        `${key} is server-derived and must not be supplied`,
        {
          field: key,
        },
      );
    }
  }
}

const DECIMAL_REGEX = /^\d+(\.\d+)?$/;

/** A positive finite number, or a plain positive decimal string (no sign, no exponent). */
export function isPositiveDecimal(value: unknown): value is string | number {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0;
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  return DECIMAL_REGEX.test(trimmed) && Number(trimmed) > 0;
}

// Exact scaled-integer decimal arithmetic. Values are NUMERIC strings; float multiplication of a
// cost by a percentage and a quantity would drift in the last places and the monetary columns
// are compared as strings (cmpMonetary), so the products are formed in BigInt at a fixed scale
// and rounded half-up ONCE, at the end, to the column's scale.
function toScaled(value: string | number, scale: number): bigint {
  const text = typeof value === 'number' ? value.toFixed(scale) : value.trim();
  const negative = text.startsWith('-');
  const unsigned = negative ? text.slice(1) : text;
  const [intPart = '0', fracPart = ''] = unsigned.split('.');
  // Code review P2: the string path used to TRUNCATE (slice to `scale`) while the number path
  // rounded through toFixed, so the same economic value scaled differently depending on whether the
  // JSON carried 12.3456785 or "12.3456785", and a sub-scale string truncated silently to zero.
  // One digit of guard is enough: the contract is "rounded half-up ONCE, at the end", and half-up on
  // the first dropped digit is exactly that (a nonzero tail below it can never pull a 4 up to a 5).
  const padded = fracPart.padEnd(scale + 1, '0');
  const kept = padded.slice(0, scale);
  const roundUp = padded.charCodeAt(scale) >= 53; // '5'
  const scaled = BigInt((intPart === '' ? '0' : intPart) + kept) + (roundUp ? 1n : 0n);
  return negative ? -scaled : scaled;
}

function divideHalfUp(numerator: bigint, denominator: bigint): bigint {
  const twice = numerator * 2n + denominator;
  return twice / (denominator * 2n);
}

function fromScaled(value: bigint, scale: number): string {
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(scale + 1, '0');
  const intPart = digits.slice(0, digits.length - scale);
  const frac = digits.slice(digits.length - scale);
  return `${negative ? '-' : ''}${intPart}${scale > 0 ? '.' + frac : ''}`;
}

// Column-derived magnitude bounds (code review P3/P4). unit_value is NUMERIC(18,6), so it holds at
// most 12 integer digits; taxable_value is NUMERIC(18,2), so at most 16. Without these the applier
// handed Postgres a value it could not store and the caller saw a raw 22003 inside a 500. The unit
// bound is also the exponential-notation guard: a JSON number at or above 1e21 makes toFixed(6)
// return "1e+21", and BigInt("1e+21" + "000000") throws an uncaught SyntaxError inside the applier.
const MAX_UNIT_VALUE_SCALED6 = 10n ** 18n; // exclusive: 1e12 at scale 6
const MAX_TAXABLE_VALUE_SCALED2 = 10n ** 18n; // exclusive: 1e16 at scale 2

export interface Rule28Input {
  basis: Rule28Basis;
  quantity: string | number;
  declaredUnitValue: string | number | null;
  runningAverageCost: string | null;
  costPlusPercent: string | null;
}

/**
 * Task 3.3: the Rule 28 unit and taxable value. cost_plus (Rules 30/31) is the SKU running-average
 * cost times cost_plus_percent / 100 (valuation is SKU-grain; there is no per-lot or per-location
 * cost anywhere); a missing or zero cost is 409 VALUATION_COST_UNAVAILABLE. The other three bases
 * take the declared unit value and refuse its absence with 400 DECLARED_VALUE_REQUIRED. unit_value
 * is kept at 6 dp; taxable_value is rounded half-up to 2 dp once, at the end.
 */
export function computeRule28Value(input: Rule28Input): {
  unit_value: string;
  taxable_value: string;
} {
  let unitScaled6: bigint;
  if (input.basis === 'cost_plus') {
    const cost = input.runningAverageCost;
    if (cost === null || !DECIMAL_REGEX.test(cost.trim()) || monToNum(cost) <= 0) {
      throw new AppError(
        409,
        'VALUATION_COST_UNAVAILABLE',
        'cost_plus valuation needs a positive running-average cost for the SKU and none is available',
        { running_average_cost: cost },
      );
    }
    const percent = input.costPlusPercent ?? '110';
    // cost (scale 6) * percent (scale 3) / 100 -> scale 6, half-up.
    const product = toScaled(cost, 6) * toScaled(percent, 3);
    unitScaled6 = divideHalfUp(product, 100n * 1000n);
  } else {
    if (input.declaredUnitValue === null || !isPositiveDecimal(input.declaredUnitValue)) {
      throw new AppError(
        400,
        'DECLARED_VALUE_REQUIRED',
        `A declared_unit_value is required for the ${input.basis} basis`,
        { valuation_basis: input.basis },
      );
    }
    // P3: BEFORE toScaled - a number at or above 1e21 stringifies exponentially and would make
    // BigInt() throw a bare SyntaxError (an unhandled 500) rather than refuse.
    assertDeclaredUnitValueBounded(input.declaredUnitValue);
    unitScaled6 = toScaled(input.declaredUnitValue, 6);
  }
  // P4: the cost_plus product is bounded here instead (a percentage can push a storable cost out of
  // the column). P5: the DB now requires unit_value > 0, so a value that rounds away at 6 dp is a
  // typed refusal here rather than a constraint violation on the INSERT.
  if (unitScaled6 <= 0n) {
    throw new AppError(
      400,
      'INVALID_PARAMS',
      'The computed unit value rounds to zero at six decimal places and cannot be filed',
      { valuation_basis: input.basis },
    );
  }
  if (unitScaled6 >= MAX_UNIT_VALUE_SCALED6) {
    throw new AppError(
      400,
      'INVALID_PARAMS',
      'The computed unit value exceeds the maximum storable unit value (12 integer digits)',
      { valuation_basis: input.basis },
    );
  }
  // unit (scale 6) * quantity (scale 6) -> scale 12, rounded half-up to scale 2.
  const taxableScaled12 = unitScaled6 * toScaled(input.quantity, 6);
  const taxableScaled2 = divideHalfUp(taxableScaled12, 10n ** 10n);
  if (taxableScaled2 <= 0n) {
    throw new AppError(
      400,
      'INVALID_PARAMS',
      'The computed taxable value rounds to zero at two decimal places and cannot be filed',
      { valuation_basis: input.basis },
    );
  }
  if (taxableScaled2 >= MAX_TAXABLE_VALUE_SCALED2) {
    throw new AppError(
      400,
      'INVALID_PARAMS',
      'The computed taxable value exceeds the maximum storable taxable value (16 integer digits)',
      { valuation_basis: input.basis },
    );
  }
  return { unit_value: fromScaled(unitScaled6, 6), taxable_value: fromScaled(taxableScaled2, 2) };
}

/**
 * P3/P4: the declared unit value must be storable in NUMERIC(18,6) before any BigInt arithmetic
 * touches it. Compared as a NUMBER because that is the only representation an exponential JSON
 * literal has; a decimal STRING is compared on its integer-digit count, which is exact at any size.
 */
function assertDeclaredUnitValueBounded(value: string | number): void {
  const tooLarge =
    typeof value === 'number'
      ? !(value < 1e12)
      : (value.trim().split('.')[0] ?? '').replace(/^0+/, '').length > 12;
  if (tooLarge) {
    throw new AppError(
      400,
      'INVALID_PARAMS',
      'declared_unit_value exceeds the maximum storable unit value (12 integer digits)',
    );
  }
}

// ---------------------------------------------------------------------------
// Story 11.5: classification by GSTIN resolution (Binding Decision 1)
// ---------------------------------------------------------------------------

export type BranchTransferClassification =
  | { supply_class: 'intra_site'; from_site_id: string; to_site_id: string }
  | { supply_class: 'intra_gstin'; from_site_id: string; to_site_id: string; gstin_ext: string }
  | {
      supply_class: 'inter_gstin';
      from_site_id: string;
      to_site_id: string;
      from_gstin_ext: string;
      to_gstin_ext: string;
    };

/**
 * Task 3.2: a transfer within one site is intra_site. A cross-site transfer resolves BOTH sites
 * through site_gstin on the IST business date: same GSTIN is intra_gstin, different is inter_gstin
 * (this story's supply), and a missing registration on either side is refused 409
 * SITE_GSTIN_MISSING naming the site (fail closed, the Story 8.6 default-enforce rule).
 */
export async function classifyBranchTransfer(
  fromLocationId: string,
  toLocationId: string,
  businessDate: string,
  client?: PoolClient,
): Promise<BranchTransferClassification> {
  const fromLocation = await getLocationById(fromLocationId, client);
  const toLocation = await getLocationById(toLocationId, client);
  if (!fromLocation || !toLocation) {
    throw new AppError(400, 'LOCATION_NOT_FOUND', 'Transfer location does not exist', {
      from_location_id: fromLocationId,
      to_location_id: toLocationId,
    });
  }
  const fromSiteId = fromLocation.site_id;
  const toSiteId = toLocation.site_id;
  // P16: compared case-insensitively, exactly as assertPayloadSiteBound compares site ids. A
  // location_register row whose site_id differs only in hexadecimal case would otherwise classify
  // an intra-site move as a cross-site supply and demand statutory documents for it.
  if (fromSiteId.toLowerCase() === toSiteId.toLowerCase()) {
    return { supply_class: 'intra_site', from_site_id: fromSiteId, to_site_id: toSiteId };
  }
  const fromGstin = await findSiteGstin(fromSiteId, businessDate, client);
  if (!fromGstin) throw siteGstinMissing(fromSiteId, businessDate);
  const toGstin = await findSiteGstin(toSiteId, businessDate, client);
  if (!toGstin) throw siteGstinMissing(toSiteId, businessDate);
  if (fromGstin.gstin_ext === toGstin.gstin_ext) {
    return {
      supply_class: 'intra_gstin',
      from_site_id: fromSiteId,
      to_site_id: toSiteId,
      gstin_ext: fromGstin.gstin_ext,
    };
  }
  return {
    supply_class: 'inter_gstin',
    from_site_id: fromSiteId,
    to_site_id: toSiteId,
    from_gstin_ext: fromGstin.gstin_ext,
    to_gstin_ext: toGstin.gstin_ext,
  };
}

function siteGstinMissing(siteId: string, businessDate: string): AppError {
  return new AppError(
    409,
    'SITE_GSTIN_MISSING',
    `Site ${siteId} has no GSTIN registration effective on ${businessDate}; a cross-site transfer cannot be classified`,
    { site_id: siteId, business_date: businessDate },
  );
}

/** The pair configuration effective on the date, or 409 VALUATION_CONFIG_MISSING. */
async function requireValuationConfig(
  fromGstin: string,
  toGstin: string,
  businessDate: string,
  client: PoolClient,
): Promise<ValuationConfigRow> {
  const valuationConfig = await findValuationConfig(fromGstin, toGstin, businessDate, client);
  if (!valuationConfig) {
    throw new AppError(
      409,
      'VALUATION_CONFIG_MISSING',
      `No branch transfer valuation configuration is effective for ${fromGstin} to ${toGstin} on ${businessDate}`,
      { from_gstin_ext: fromGstin, to_gstin_ext: toGstin, business_date: businessDate },
    );
  }
  return valuationConfig;
}

function assertBasisEligible(basis: Rule28Basis, valuationConfig: ValuationConfigRow): void {
  if (basis === 'invoice_value_full_itc' && !valuationConfig.recipient_full_itc_eligible) {
    throw new AppError(
      409,
      'BASIS_NOT_ELIGIBLE',
      'invoice_value_full_itc (the Rule 28 second proviso) is only available where the recipient GSTIN is configured as eligible for full input tax credit',
      {
        valuation_basis: basis,
        to_gstin_ext: valuationConfig.to_gstin_ext,
        valuation_config_id: valuationConfig.config_id,
      },
    );
  }
}

/**
 * Code review D3-P: the two hand-declared Rule 28 bases (open market value, like kind and quality)
 * put a HUMAN's figure on a statutory document, so valuing a transfer on one of them is a GST
 * officer action, not an ordinary creator's.
 *
 * Code review E1-P: D3-P as first written refused the CREATE outright, which made both bases
 * unreachable - the REST create route's CREATE_ROLES does not carry gst_officer, and adding it was
 * rejected on segregation-of-duties grounds (the Story 9.9 design: the person who states the taxable
 * value must not originate the movement being valued). The ruling is that such a transfer is created
 * UNVALUED - stamped inter_gstin with no branch_transfer_valuation row - and the officer values it
 * afterwards through transfer_request.valuation_overridden. The ship gate already blocks that state
 * with `not_valued`, so it fails closed. The 403 survives only for a non-officer who EXPLICITLY
 * supplies a declared_unit_value: a warehouse role must never state a market value.
 *
 * The idiom is the applier-side twin of the events door's assertBranchTransferGstFunctionAccess
 * (src/api/v1/events.ts): privilege AND site scope come from the SAME assignment. It is copied from
 * assertActiveSiteOperator in src/compliance/cross-dock.ts, which is the established way an applier
 * asks this question of the transaction client - the role is a QUERY PARAMETER, never a literal
 * branched on in code (FR-DOA-01 / the no-hardcoded-role-in-workflow lint rule).
 */
const DECLARED_BASIS_OFFICER_ROLES = ['gst_officer'] as const;
const OFFICER_ONLY_BASES: ReadonlySet<Rule28Basis> = new Set<Rule28Basis>([
  'open_market_value',
  'like_kind_quality',
]);

async function actorHoldsGstOfficerAssignment(
  userId: string,
  siteId: string,
  client: PoolClient,
): Promise<boolean> {
  const result = await client.query(
    `SELECT 1 FROM users u JOIN user_role_assignments ura ON ura.user_id = u.user_id
      WHERE u.user_id = $1 AND u.active = true AND ura.role = ANY($2::text[])
        AND ura.function_scope = 'write' AND ura.module IN ('inventory', '*')
        AND (ura.location_id = '*' OR ura.location_id = $3::text) LIMIT 1`,
    [userId, [...DECLARED_BASIS_OFFICER_ROLES], siteId],
  );
  return result.rows.length > 0;
}

function declaredBasisNotPermitted(basis: Rule28Basis, siteId: string): AppError {
  return new AppError(
    403,
    'VALUATION_BASIS_NOT_PERMITTED',
    `The ${basis} basis takes a hand-declared unit value; only a GST officer assigned to the source site may state it`,
    {
      valuation_basis: basis,
      site_id: siteId,
      required_roles: [...DECLARED_BASIS_OFFICER_ROLES],
    },
  );
}

/** Values a quantity of a SKU on a basis, reading the locked running-average cost only for cost_plus. */
async function valueOnBasis(
  basis: Rule28Basis,
  sku: string,
  quantity: string | number,
  declaredUnitValue: string | number | null,
  costPlusPercent: string,
  client: PoolClient,
): Promise<{ unit_value: string; taxable_value: string; running_cost_used: boolean }> {
  let runningAverageCost: string | null = null;
  if (basis === 'cost_plus') {
    // Locked so a concurrent receipt cannot move the cost under the calculation.
    const valuation = await lockInventoryValuation(sku, client);
    runningAverageCost = valuation.running_average_cost;
  }
  const value = computeRule28Value({
    basis,
    quantity,
    declaredUnitValue,
    runningAverageCost,
    costPlusPercent,
  });
  return { ...value, running_cost_used: basis === 'cost_plus' };
}

/**
 * Code review P13: the mirror of DECLARED_VALUE_REQUIRED. A declared_unit_value that the resolved
 * basis will never read (cost_plus) - or that no valuation will read at all, because the transfer
 * is not an inter-GSTIN supply (`basis` null) - is refused rather than accepted, dropped, and
 * answered with a 201 that implies the creator's figure was filed.
 */
function assertDeclaredValueApplicable(
  declaredUnitValue: string | number | null,
  basis: Rule28Basis | null,
): void {
  if (declaredUnitValue === null) return;
  if (basis !== null && basis !== 'cost_plus') return;
  throw new AppError(
    400,
    'INVALID_PARAMS',
    basis === null
      ? 'declared_unit_value does not apply: this transfer is not an inter-GSTIN supply and carries no Rule 28 valuation'
      : 'declared_unit_value does not apply to the cost_plus basis, which is derived from the running average cost',
    { valuation_basis: basis },
  );
}

// ---------------------------------------------------------------------------
// Task 1: TransferRequestCreated projection (inside transaction)
// ---------------------------------------------------------------------------

export async function applyTransferRequestProjection(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId?: string,
): Promise<void> {
  if (envelope.event_type !== 'transfer_request.created') return;

  const p = envelope.payload as Record<string, unknown>;
  const transferRequestId = p['transfer_request_id'] as string;
  const skuId = p['sku_id'] as string;
  const quantity = p['quantity'] as number;
  const fromLocationId = p['from_location_id'] as string;
  const toLocationId = p['to_location_id'] as string;
  const lotId = (p['lot_id'] as string | undefined) ?? null;
  const serialIds = (p['serial_ids'] as string[] | undefined) ?? null;
  const businessStream = p['business_stream'] as string;
  const notes = (p['notes'] as string | undefined) ?? null;
  const approverActorId = (p['approver_actor_id'] as string | undefined) ?? null;

  // Idempotency guard: skip if this transfer_request_id already exists
  const existing = await client.query(
    `SELECT transfer_request_id FROM transfer_request WHERE transfer_request_id = $1`,
    [transferRequestId],
  );
  if (existing.rows.length > 0) return;

  // Validate locations
  const fromLocation = await getLocationById(fromLocationId, client);
  if (!fromLocation || fromLocation.status !== 'active') {
    throw new AppError(
      400,
      'LOCATION_NOT_FOUND',
      'from_location_id does not exist or is not active',
      {
        from_location_id: fromLocationId,
      },
    );
  }

  const toLocation = await getLocationById(toLocationId, client);
  if (!toLocation || toLocation.status !== 'active') {
    throw new AppError(
      400,
      'LOCATION_NOT_FOUND',
      'to_location_id does not exist or is not active',
      {
        to_location_id: toLocationId,
      },
    );
  }

  // Validate lot
  if (lotId) {
    const lotResult = await client.query(`SELECT lot_id, sku FROM lot_master WHERE lot_id = $1`, [
      lotId,
    ]);
    if (lotResult.rows.length === 0) {
      throw new AppError(400, 'LOT_NOT_FOUND', `Lot "${lotId}" not found`, { lot_id: lotId });
    }
    if (lotResult.rows[0].sku !== skuId) {
      throw new AppError(
        400,
        'LOT_SKU_MISMATCH',
        `Lot "${lotId}" does not belong to SKU "${skuId}"`,
        {
          lot_id: lotId,
          sku_id: skuId,
        },
      );
    }
  }

  // Validate serials. Existence is checked regardless of whether a lot was supplied (a lot-less
  // serial request must still reference real serials - Story 2.5 review); lot ownership is only
  // enforced when a lot is present.
  if (serialIds && serialIds.length > 0) {
    const serialResult = await client.query(
      `SELECT serial_number, lot_id FROM serial_master WHERE serial_number = ANY($1)`,
      [serialIds],
    );
    if (serialResult.rows.length !== serialIds.length) {
      const foundSet = new Set(
        serialResult.rows.map((s: { serial_number: string }) => s.serial_number),
      );
      const missing = serialIds.filter((s: string) => !foundSet.has(s));
      throw new AppError(
        400,
        'SERIAL_NOT_FOUND',
        `Serial numbers not found: ${missing.join(', ')}`,
        {
          serial_ids: missing,
        },
      );
    }
    if (lotId) {
      for (const s of serialResult.rows) {
        if (s.lot_id !== lotId) {
          throw new AppError(
            400,
            'SERIAL_NOT_AVAILABLE',
            `Serial "${s.serial_number}" does not belong to lot "${lotId}"`,
            {
              serial_number: s.serial_number,
              lot_id: lotId,
            },
          );
        }
      }
    }
  }

  // Story 8.1 (Task 6): the QC gate on the named lot. A transfer is the one internal movement a
  // conditionally released lot may take, and only to the location its deviation names; qc_hold
  // always blocks. Lot lock, gate lock, then the ledger helper takes the stock rows.
  let lotNumber: string | null = null;
  if (lotId !== null) {
    lotNumber = await lotNumberForUuid(lotId, skuId, client);
    await assertQcGateAllows({
      lot_id: lotId,
      sku: skuId,
      operation: 'transfer',
      scope_ref: toLocationId,
      business_date: gateBusinessDateOf(envelope),
      client,
    });
  }

  // Allocate at the from-location (decrements available = on_hand - allocated)
  // This reserves the quantity for the transfer without decreasing on_hand yet
  const allocationInput: StockAllocationInput = {
    sku: skuId,
    location_id: fromLocationId,
    lot_id: lotNumber,
    quantity,
    qc_gate_cleared: lotId !== null,
  };
  await applyStockAllocation(allocationInput, client);

  // Insert the transfer request row
  await insertTransferRequest(
    {
      transfer_request_id: transferRequestId,
      sku_id: skuId,
      quantity,
      from_location_id: fromLocationId,
      to_location_id: toLocationId,
      lot_id: lotId,
      serial_ids: serialIds,
      business_stream: businessStream,
      notes,
      // Persist the status the API computed (pending_approval when approval is required,
      // pending_shipment otherwise). Hardcoding it stranded no-approval transfers (Story 2.5 review).
      status: (p['status'] as string) ?? 'pending_approval',
      approver_actor_id: approverActorId,
      correlation_id: envelope.metadata.correlation_id as string,
    },
    client,
  );

  // Story 11.5 (Task 3.4): classify by GSTIN resolution and, for an inter-GSTIN supply, value it
  // on the pair's configured default basis. The refusals fire HERE, inside the applier, so both
  // doors meet them; the route's pre-checks are a courtesy. intra_site / intra_gstin still insert
  // no VALUATION row and leave every Story 2.5 behaviour untouched (AC 5).
  const businessDate = gateBusinessDateOf(envelope);
  const classification = await classifyBranchTransfer(
    fromLocationId,
    toLocationId,
    businessDate,
    client,
  );
  const declaredUnitValue = (p['declared_unit_value'] as string | number | undefined) ?? null;
  const sourceEventId = eventId ?? envelope.event_id;
  if (!sourceEventId) {
    throw new AppError(
      500,
      'EVENT_ID_MISSING',
      'source_event_id could not be resolved for valuation',
    );
  }

  // Code review D1-P: EVERY transfer is stamped with the class it was created under, all three
  // classes, BEFORE the intra early exit. site_gstin is dated and mutable, so the ship gate must
  // read this stamp and never re-derive the class: two sites re-registered under one GSTIN between
  // create and ship would otherwise reclassify a genuinely inter-GSTIN supply as intra_gstin and
  // wave it out of the door with no tax invoice, no IRN and no e-way bill. The GSTIN columns record
  // the registrations the class was decided on - both NULL for intra_site, and the ONE shared
  // registration written to BOTH columns for intra_gstin (the table's CHECK).
  await insertBranchTransferClassification(
    {
      transfer_request_id: transferRequestId,
      supply_class: classification.supply_class,
      from_site_id: classification.from_site_id,
      to_site_id: classification.to_site_id,
      from_gstin_ext:
        classification.supply_class === 'intra_site'
          ? null
          : classification.supply_class === 'intra_gstin'
            ? classification.gstin_ext
            : classification.from_gstin_ext,
      to_gstin_ext:
        classification.supply_class === 'intra_site'
          ? null
          : classification.supply_class === 'intra_gstin'
            ? classification.gstin_ext
            : classification.to_gstin_ext,
      business_date: businessDate,
      source_event_id: sourceEventId,
    },
    client,
  );

  if (classification.supply_class !== 'inter_gstin') {
    // Code review P13: a declared_unit_value on a transfer that is not a valued inter-GSTIN supply
    // is never read and never stored, and the caller used to get a 201 as though it had been filed.
    assertDeclaredValueApplicable(declaredUnitValue, null);
    return;
  }

  const valuationConfig = await requireValuationConfig(
    classification.from_gstin_ext,
    classification.to_gstin_ext,
    businessDate,
    client,
  );
  // Defensive: the CHECK already forbids an ineligible second-proviso default.
  assertBasisEligible(valuationConfig.default_basis, valuationConfig);
  // D3-P / E1-P: the hand-declared bases are a GST officer capability. A non-officer creating a
  // transfer whose pair defaults to one of them creates it UNVALUED (stamped above, no valuation
  // row) and the officer values it later through transfer_request.valuation_overridden; the ship
  // gate blocks the unvalued state with `not_valued`, so nothing moves in the meantime. Only an
  // explicitly declared value from a non-officer is a refusal.
  if (OFFICER_ONLY_BASES.has(valuationConfig.default_basis)) {
    const isOfficer = await actorHoldsGstOfficerAssignment(
      envelope.metadata.actor.user_id,
      classification.from_site_id,
      client,
    );
    if (!isOfficer) {
      if (declaredUnitValue !== null) {
        throw declaredBasisNotPermitted(valuationConfig.default_basis, classification.from_site_id);
      }
      return;
    }
  }
  // P13: cost_plus derives its unit value from the running cost, so a declared value on it is
  // silently discarded input, not a valuation instruction.
  assertDeclaredValueApplicable(declaredUnitValue, valuationConfig.default_basis);
  const valued = await valueOnBasis(
    valuationConfig.default_basis,
    skuId,
    quantity,
    declaredUnitValue,
    valuationConfig.cost_plus_percent,
    client,
  );
  await insertBranchTransferValuation(
    {
      transfer_request_id: transferRequestId,
      from_site_id: classification.from_site_id,
      to_site_id: classification.to_site_id,
      from_gstin_ext: classification.from_gstin_ext,
      to_gstin_ext: classification.to_gstin_ext,
      business_date: businessDate,
      valuation_config_id: valuationConfig.config_id,
      valuation_basis: valuationConfig.default_basis,
      // D3-P: a figure the CREATOR supplied is `declared`; only a value the seam derived from the
      // running cost is `config_default`. Stamping a human's number as system-derived misrepresents
      // the provenance of a filed statutory figure.
      basis_source: valued.running_cost_used ? 'config_default' : 'declared',
      cost_plus_percent: valued.running_cost_used ? valuationConfig.cost_plus_percent : null,
      declared_unit_value:
        valued.running_cost_used || declaredUnitValue === null ? null : String(declaredUnitValue),
      unit_value: valued.unit_value,
      taxable_value: valued.taxable_value,
      valued_at: new Date().toISOString(),
      source_event_id: sourceEventId,
    },
    client,
  );
}

// ---------------------------------------------------------------------------
// Task 5: TransferShipCreated shape validation (pre-transaction)
// ---------------------------------------------------------------------------

export function assertTransferShipShape(envelope: EventEnvelope): void {
  if (envelope.event_type !== 'transfer_ship.created') return;

  const p = envelope.payload as Record<string, unknown>;

  if (!isNonEmptyString(p['transfer_request_id'])) {
    throw new AppError(
      400,
      'INVALID_PARAMS',
      'transfer_request_id is required and must be a non-empty string',
    );
  }
  if (!isNonEmptyString(p['lot_id'])) {
    throw new AppError(400, 'INVALID_PARAMS', 'lot_id is required and must be a non-empty string');
  }
  if (!isPositiveFiniteNumber(p['shipped_quantity'])) {
    throw new AppError(
      400,
      'INVALID_PARAMS',
      'shipped_quantity is required and must be a positive number',
    );
  }
  if (p['shipped_quantity'] > MAX_QUANTITY) {
    throw new AppError(
      400,
      'INVALID_PARAMS',
      `shipped_quantity exceeds the maximum allowed value of ${MAX_QUANTITY}`,
    );
  }
  if (p['serial_ids'] !== undefined) {
    if (!Array.isArray(p['serial_ids']) || p['serial_ids'].length === 0) {
      throw new AppError(
        400,
        'INVALID_PARAMS',
        'serial_ids must be a non-empty array when supplied',
      );
    }
    for (const s of p['serial_ids']) {
      if (!isNonEmptyString(s)) {
        throw new AppError(400, 'INVALID_PARAMS', 'serial_ids must contain only non-empty strings');
      }
    }
  }
  if (!isNonEmptyString(p['correlation_id'])) {
    throw new AppError(
      400,
      'INVALID_PARAMS',
      'correlation_id is required and must be a non-empty string',
    );
  }
}

// ---------------------------------------------------------------------------
// Task 5: TransferShipCreated projection (inside transaction)
// ---------------------------------------------------------------------------

/**
 * Code review P17: the AC 4 self-audit must never convert a statutory refusal into an opaque 500.
 * The audit row is written on a fresh connection, so its failure mode (pool exhaustion, a dead
 * connection) is INDEPENDENT of the refusal it records; awaiting it uncontained meant an audit
 * outage turned a 409 the caller can act on into a 500 they cannot distinguish from a broken
 * server. The refusal is the caller-facing contract and always wins; the audit write is best effort
 * and its failure is surfaced on the server's own error stream.
 */
async function auditRefusal(
  auditCtx: Omit<AuditEntryPayload, 'event_id' | 'error_code' | 'details'> | undefined,
  errorCode: string,
  refusal: AppError,
): Promise<void> {
  if (!auditCtx) return;
  try {
    await logRejectionAudit({
      ...auditCtx,
      event_id: null,
      http_status: refusal.statusCode,
      error_code: errorCode,
      details: refusal.details,
    });
  } catch (err) {
    console.error(`[transfer-request] rejection audit failed for ${errorCode}:`, err);
  }
}

export async function applyTransferShipProjection(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId?: string,
  auditCtx?: Omit<AuditEntryPayload, 'event_id' | 'error_code' | 'details'>,
): Promise<void> {
  if (envelope.event_type !== 'transfer_ship.created') return;

  const p = envelope.payload as Record<string, unknown>;
  const transferRequestId = p['transfer_request_id'] as string;
  const lotId = p['lot_id'] as string;
  const shippedQuantity = p['shipped_quantity'] as number;
  const correlationId = p['correlation_id'] as string;
  const shipSerialIds = (p['serial_ids'] as string[] | undefined) ?? null;

  // Lock the transfer request row FIRST so concurrent ships serialize (Story 2.5 review). The
  // in_transit unique constraint on transfer_request_id is the ultimate backstop, but taking the
  // row lock up front turns a double-ship into a clean status check rather than a constraint error.
  const reqRow = await getTransferRequestById(transferRequestId, client, true);
  if (!reqRow) {
    throw new AppError(404, 'NOT_FOUND', `Transfer request "${transferRequestId}" not found`);
  }

  // Idempotency guard: a ship already recorded for this transfer is a no-op.
  const existingInTransit = await client.query(
    `SELECT transfer_request_id FROM in_transit WHERE transfer_request_id = $1`,
    [transferRequestId],
  );
  if (existingInTransit.rows.length > 0) return;

  // AC4: Must be approved or pending_shipment
  if (reqRow.status !== 'approved' && reqRow.status !== 'pending_shipment') {
    throw new AppError(
      403,
      'APPROVAL_REQUIRED',
      'Transfer request must be approved before shipping',
      {
        current_status: reqRow.status,
      },
    );
  }

  // Story 11.5 (Task 6.2, AC 4): an inter-GSTIN supply does not move until its GST documents are
  // recorded. Runs AFTER the status check and the replay short-circuit, BEFORE the QC gate and any
  // stock issue, so nothing moves. The applier self-audits (the 11.2 pattern): the rejection row is
  // written on a fresh connection BEFORE the throw so it survives the event rollback on both doors.
  const gstGate = await dispatchGateGstDocuments(reqRow, client);
  if (gstGate.blocked) {
    const refusal = new AppError(
      409,
      'GST_DOCUMENTS_REQUIRED',
      `Transfer request "${transferRequestId}" is an inter-GSTIN supply and cannot ship until its GST documents are recorded`,
      {
        transfer_request_id: transferRequestId,
        reasons: gstGate.reasons,
        taxable_value: gstGate.taxable_value,
        threshold: gstGate.threshold,
      },
    );
    await auditRefusal(auditCtx, 'GST_DOCUMENTS_REQUIRED', refusal);
    throw refusal;
  }

  // Code review D2-P: an inter-GSTIN supply that has been valued may ship the valued quantity and
  // NOTHING else. A SHORT ship used to pass the greater-than bar below and leave the filed taxable
  // value, the tax invoice and the e-way-bill decision all describing a consignment that never
  // moved; re-valuing is not an option, because the e-invoice is already filed with a minted IRN and
  // our record would then contradict a statutory document. The only lawful route is to cancel the
  // tax invoice and re-raise it, which is what the refusal says.
  if (gstGate.valued_quantity !== null && shippedQuantity !== gstGate.valued_quantity) {
    const refusal = new AppError(
      409,
      'SHIP_QUANTITY_MISMATCH',
      `Transfer request "${transferRequestId}" was valued and invoiced for ${gstGate.valued_quantity}; shipping ${shippedQuantity} would contradict the filed tax invoice. Cancel the tax invoice and re-raise it for the quantity being shipped.`,
      {
        transfer_request_id: transferRequestId,
        valued_quantity: gstGate.valued_quantity,
        shipped_quantity: shippedQuantity,
      },
    );
    await auditRefusal(auditCtx, 'SHIP_QUANTITY_MISMATCH', refusal);
    throw refusal;
  }

  // AC5: Quantity check
  if (shippedQuantity > reqRow.quantity) {
    throw new AppError(
      400,
      'QUANTITY_EXCEEDS_APPROVED',
      `Shipped quantity ${shippedQuantity} exceeds approved quantity ${reqRow.quantity}`,
      { approved_quantity: reqRow.quantity, requested_quantity: shippedQuantity },
    );
  }

  // Lot matching (ship side)
  if (reqRow.lot_id && reqRow.lot_id !== lotId) {
    throw new AppError(
      400,
      'LOT_MISMATCH',
      `Ship lot_id "${lotId}" does not match request lot_id "${reqRow.lot_id}"`,
      {
        request_lot_id: reqRow.lot_id,
        ship_lot_id: lotId,
      },
    );
  }

  // Serial traceability: shipped serials must be a subset of the request's serials (Story 2.5 review).
  if (shipSerialIds && reqRow.serial_ids) {
    const requestSet = new Set(reqRow.serial_ids);
    const stray = shipSerialIds.filter((s) => !requestSet.has(s));
    if (stray.length > 0) {
      throw new AppError(
        400,
        'SERIAL_MISMATCH',
        `Shipped serials are not part of the request: ${stray.join(', ')}`,
        {
          stray_serials: stray,
        },
      );
    }
  }

  // Source-side stock operations run at the grain the stock was ALLOCATED at - the request's
  // original lot (null for a lot-less request), NOT the shipped lot (Story 2.5 review). The shipped
  // lot is recorded on the in-transit tracking row below and used for receive lot-matching; it is
  // traceability metadata, not the source stock grain. Issuing at the ship lot when the request was
  // lot-less left the allocation stranded and the stock unfindable (INSUFFICIENT_STOCK).
  const sourceLotUuid = reqRow.lot_id;
  let sourceLotNumber: string | null = null;
  if (sourceLotUuid !== null) {
    sourceLotNumber = await lotNumberForUuid(sourceLotUuid, reqRow.sku_id, client);
  }

  // Story 8.1 (Task 6): the QC gate is re-run at ship time against the request's destination, so a
  // deviation that expired or a gate that changed since the request cannot be shipped through.
  if (sourceLotUuid !== null) {
    await assertQcGateAllows({
      lot_id: sourceLotUuid,
      sku: reqRow.sku_id,
      operation: 'transfer',
      scope_ref: reqRow.to_location_id,
      business_date: gateBusinessDateOf(envelope),
      client,
    });
  }

  // Issue stock from source (decreases on_hand)
  const issueInput: StockIssueInput = {
    sku: reqRow.sku_id,
    location_id: reqRow.from_location_id,
    lot_id: sourceLotNumber,
    quantity: shippedQuantity,
    qc_gate_cleared: sourceLotUuid !== null,
  };
  await applyStockIssue(issueInput, client);

  // Release the allocation (allocated decreases, available = on_hand - allocated stays consistent)
  const deallocInput: StockDeallocationInput = {
    sku: reqRow.sku_id,
    location_id: reqRow.from_location_id,
    lot_id: sourceLotNumber,
    quantity: shippedQuantity,
  };
  await applyStockDeallocation(deallocInput, client);

  // Increment in_transit at the source location. Direct SQL update since this is a column-level
  // operation. applyStockIssue above guarantees the lot-grain balance row exists; assert the row
  // was matched so a silent balance/tracking divergence cannot occur (Story 2.5 review).
  const inTransitUpdate = await client.query(
    `UPDATE stock_balance
     SET in_transit = in_transit + $1, updated_at = now()
     WHERE sku = $2 AND location_id = $3 AND stock_class = 'owned' AND ($4::text IS NULL OR lot_id = $4)`,
    [shippedQuantity, reqRow.sku_id, reqRow.from_location_id, sourceLotNumber],
  );
  if (inTransitUpdate.rowCount === 0) {
    throw new AppError(
      500,
      'STOCK_BALANCE_MISSING',
      'No stock_balance row to record in-transit quantity against',
      {
        sku: reqRow.sku_id,
        location_id: reqRow.from_location_id,
        lot_id: sourceLotNumber,
      },
    );
  }

  // Record the in-transit row for tracking and querying. ship_event_id is a UUID column, so the
  // real event id must be threaded in (store.ts computes it); the previous 'unknown' fallback threw
  // a UUID syntax error and 500'd every real ship (Story 2.5 review).
  const resolvedEventId = eventId ?? envelope.event_id;
  if (!resolvedEventId) {
    throw new AppError(
      500,
      'EVENT_ID_MISSING',
      'ship_event_id could not be resolved for in-transit record',
    );
  }
  await insertInTransitRecord(
    {
      sku_id: reqRow.sku_id,
      location_from: reqRow.from_location_id,
      location_to: reqRow.to_location_id,
      lot_id: lotId,
      quantity: shippedQuantity,
      transfer_request_id: transferRequestId,
      correlation_id: correlationId,
      ship_event_id: resolvedEventId,
    },
    client,
  );

  // Update status to shipped
  await updateTransferRequestStatus(transferRequestId, 'shipped', client);
}

// ---------------------------------------------------------------------------
// Task 6: TransferReceiveCreated shape validation (pre-transaction)
// ---------------------------------------------------------------------------

export function assertTransferReceiveShape(envelope: EventEnvelope): void {
  if (envelope.event_type !== 'transfer_receive.created') return;

  const p = envelope.payload as Record<string, unknown>;

  if (!isNonEmptyString(p['transfer_request_id'])) {
    throw new AppError(
      400,
      'INVALID_PARAMS',
      'transfer_request_id is required and must be a non-empty string',
    );
  }
  if (!isNonEmptyString(p['lot_id'])) {
    throw new AppError(400, 'INVALID_PARAMS', 'lot_id is required and must be a non-empty string');
  }
  if (!isPositiveFiniteNumber(p['received_quantity'])) {
    throw new AppError(
      400,
      'INVALID_PARAMS',
      'received_quantity is required and must be a positive number',
    );
  }
  if (p['received_quantity'] > MAX_QUANTITY) {
    throw new AppError(
      400,
      'INVALID_PARAMS',
      `received_quantity exceeds the maximum allowed value of ${MAX_QUANTITY}`,
    );
  }
  if (p['serial_ids'] !== undefined) {
    if (!Array.isArray(p['serial_ids']) || p['serial_ids'].length === 0) {
      throw new AppError(
        400,
        'INVALID_PARAMS',
        'serial_ids must be a non-empty array when supplied',
      );
    }
    for (const s of p['serial_ids']) {
      if (!isNonEmptyString(s)) {
        throw new AppError(400, 'INVALID_PARAMS', 'serial_ids must contain only non-empty strings');
      }
    }
  }
  if (!isNonEmptyString(p['received_at_location_id'])) {
    throw new AppError(
      400,
      'INVALID_PARAMS',
      'received_at_location_id is required and must be a non-empty string',
    );
  }
  if (!isNonEmptyString(p['correlation_id'])) {
    throw new AppError(
      400,
      'INVALID_PARAMS',
      'correlation_id is required and must be a non-empty string',
    );
  }
}

// ---------------------------------------------------------------------------
// Task 6: TransferReceiveCreated projection (inside transaction)
// ---------------------------------------------------------------------------

export async function applyTransferReceiveProjection(
  envelope: EventEnvelope,
  client: PoolClient,
): Promise<void> {
  if (envelope.event_type !== 'transfer_receive.created') return;

  const p = envelope.payload as Record<string, unknown>;
  const transferRequestId = p['transfer_request_id'] as string;
  const lotId = p['lot_id'] as string;
  const receivedQuantity = p['received_quantity'] as number;
  const receiveLocationId = p['received_at_location_id'] as string;
  const receiveSerialIds = (p['serial_ids'] as string[] | undefined) ?? null;

  // Lock the transfer request row so concurrent receives serialize (Story 2.5 review).
  const reqRow = await getTransferRequestById(transferRequestId, client, true);
  if (!reqRow) {
    throw new AppError(404, 'NOT_FOUND', `Transfer request "${transferRequestId}" not found`);
  }

  // Must be shipped (or already partially received) to accept a receipt.
  if (reqRow.status !== 'shipped' && reqRow.status !== 'partially_received') {
    throw new AppError(
      400,
      'INVALID_STATE',
      `Transfer request must be in "shipped" or "partially_received" status, current: "${reqRow.status}"`,
    );
  }

  // Validate receive location
  const receiveLocation = await getLocationById(receiveLocationId, client);
  if (!receiveLocation || receiveLocation.status !== 'active') {
    throw new AppError(
      400,
      'LOCATION_NOT_FOUND',
      'Receive location does not exist or is not active',
      {
        location_id: receiveLocationId,
      },
    );
  }

  // The in-transit tracking row carries the lot actually shipped, which is the authority for
  // receive lot-matching (a lot-less request is shipped under a concrete lot - Story 2.5 review).
  const inTransitRow = await getInTransitByTransferRequest(transferRequestId, client);
  const shippedLotUuid = inTransitRow?.lot_id ?? reqRow.lot_id;

  // AC6: Lot matching (receive side) - against the shipped lot, not the (possibly null) request lot.
  if (lotId !== shippedLotUuid) {
    throw new AppError(
      400,
      'LOT_MISMATCH',
      `Receive lot_id "${lotId}" does not match shipped lot_id "${shippedLotUuid}"`,
      { ship_lot_id: shippedLotUuid, receive_lot_id: lotId },
    );
  }

  // Convert shipped lot UUID to lot_number for stock operations
  let shippedLotNumber: string | null = null;
  if (shippedLotUuid !== null) {
    shippedLotNumber = await lotNumberForUuid(shippedLotUuid, reqRow.sku_id, client);
  }

  // Receive location must match the approved destination
  if (receiveLocationId !== reqRow.to_location_id) {
    throw new AppError(
      400,
      'INVALID_LOCATION',
      `Receive location does not match the approved destination location`,
      { expected_location_id: reqRow.to_location_id, received_location_id: receiveLocationId },
    );
  }

  // Serial traceability: received serials must be a subset of the request's serials (Story 2.5 review).
  if (receiveSerialIds && reqRow.serial_ids) {
    const requestSet = new Set(reqRow.serial_ids);
    const stray = receiveSerialIds.filter((s) => !requestSet.has(s));
    if (stray.length > 0) {
      throw new AppError(
        400,
        'SERIAL_MISMATCH',
        `Received serials are not part of the request: ${stray.join(', ')}`,
        {
          stray_serials: stray,
        },
      );
    }
  }

  // Over-receipt guard: cannot receive more than what remains in transit (Story 2.5 review).
  const remainingInTransit = inTransitRow ? inTransitRow.quantity : 0;
  if (receivedQuantity > remainingInTransit) {
    throw new AppError(
      400,
      'QUANTITY_EXCEEDS_APPROVED',
      `Received quantity ${receivedQuantity} exceeds remaining in-transit quantity ${remainingInTransit}`,
      { remaining_in_transit: remainingInTransit, requested_quantity: receivedQuantity },
    );
  }
  const fullyReceived = receivedQuantity >= remainingInTransit;

  // Reverse in-transit (decrement at source, floored at zero)
  await decrementInTransit(transferRequestId, receivedQuantity, client);

  // Decrement in_transit column at source, at the grain it was incremented (the request's original
  // lot, which equals the shipped lot for a lot-controlled request; null for a lot-less one).
  await client.query(
    `UPDATE stock_balance
     SET in_transit = GREATEST(in_transit - $1, 0), updated_at = now()
      WHERE sku = $2 AND location_id = $3 AND stock_class = 'owned' AND ($4::text IS NULL OR lot_id = $4)`,
    [receivedQuantity, reqRow.sku_id, reqRow.from_location_id, shippedLotNumber],
  );

  // Receipt at destination: increment on_hand
  const receiptInput: StockReceiptInput = {
    sku: reqRow.sku_id,
    location_id: receiveLocationId,
    location_code: receiveLocation.location_code,
    lot_id: shippedLotNumber,
    quantity: receivedQuantity,
  };
  await applyStockReceipt(receiptInput, client);

  // Mark received only when the full in-transit quantity has arrived; otherwise keep the transfer
  // receivable in a partially_received state (Story 2.5 review decision). On full receipt the
  // zero-quantity tracking row is removed so it no longer surfaces as in-transit.
  if (fullyReceived) {
    await clearInTransitRecord(transferRequestId, client);
    await updateTransferRequestStatus(transferRequestId, 'received', client);
  } else {
    await updateTransferRequestStatus(transferRequestId, 'partially_received', client);
  }
}

// ---------------------------------------------------------------------------
// Composite compliance entry point called from persistEvent
// ---------------------------------------------------------------------------

export async function assertAndApplyTransferRequestCompliance(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId?: string,
  auditCtx?: Omit<AuditEntryPayload, 'event_id' | 'error_code' | 'details'>,
): Promise<void> {
  // Pre-transaction shape validation (throws AppError if invalid)
  assertTransferRequestShape(envelope);
  assertTransferShipShape(envelope);
  assertTransferReceiveShape(envelope);
  assertTransferValuationOverriddenShape(envelope);
  assertTransferGstDocumentRecordedShape(envelope);

  // Inside-transaction projection + DB validation
  await applyTransferRequestProjection(envelope, client, eventId);
  await applyTransferShipProjection(envelope, client, eventId, auditCtx);
  await applyTransferReceiveProjection(envelope, client);
  await applyTransferValuationOverridden(envelope, client, eventId);
  await applyTransferGstDocumentRecorded(envelope, client, eventId);
}

// ---------------------------------------------------------------------------
// Story 11.5 Task 6: the GST document ship gate
// ---------------------------------------------------------------------------

export interface GstDocumentGate {
  blocked: boolean;
  reasons: string[];
  taxable_value: string | null;
  threshold: number;
  /**
   * The quantity the filed documents describe - the request quantity of a VALUED inter-GSTIN
   * supply - or null when no statutory document is in play. The ship applier refuses anything else
   * (SHIP_QUANTITY_MISMATCH, code review D2-P).
   */
  valued_quantity: number | null;
}

/**
 * Task 6.1: the ship-side GST document check. An inter-GSTIN supply needs a tax_invoice row with
 * its IRN and, when the taxable value EXCEEDS the configured threshold (strictly greater), an
 * e_way_bill row. Also the GET's `ship_blockers`, so the officer sees what is outstanding without
 * attempting a ship.
 *
 * Code review D1-P: the class is READ from the branch_transfer_classification stamp written at
 * create; this gate never calls classifyBranchTransfer. Re-deriving it here was fail-OPEN against
 * dated, mutable registration data - two sites re-registered under a single GSTIN between create
 * and ship reclassified a genuinely inter-GSTIN supply as intra_gstin, and the gate waved it out
 * with no tax invoice, no IRN and no e-way bill. An UNSTAMPED transfer is `not_valued` and blocked:
 * the pilot has not gone live, so there are zero in-flight legacy transfers and fail-closed costs
 * nothing. `businessDate` is retained only for the callers' signature; nothing dated is resolved
 * here any more, which is the entire point.
 */
/**
 * Code review D5-P, corrected by ruling F1: true when an e-way bill's validity has run out.
 *
 * The comparison is against SERVER TIME, deliberately, and must stay that way. The first version
 * of this check compared against `metadata.occurred_at`, which reads like the right field - the
 * bill should be valid when the goods actually moved - but `occurred_at` is supplied by the
 * caller and bounded only in the future (store.ts, `Upper bound only: offline uploads are
 * legitimately old`), so any shipper could defeat the whole control by backdating one field. A
 * statutory control keys on a server-observable fact, never on a claim in the payload.
 *
 * The cost is that a genuinely offline ship uploaded after its bill lapsed is refused. That is
 * accepted: the refusal parks the event in the edge queue's needs_attention with this reason
 * attached, which is precisely the compliance exception a movement on an expired bill should
 * raise. Nothing is lost, and goods that moved on a dead bill are not something to bless.
 *
 * An absent instant is NOT treated as expired - the recording shape check already requires a
 * well-formed instant, and failing open here would be a silent widening; a malformed value is a
 * data defect for the recording path to refuse, not a movement to block.
 */
function isEwayBillExpired(validUntil: string | null): boolean {
  if (validUntil === null) return false;
  const expiresAt = Date.parse(validUntil);
  if (Number.isNaN(expiresAt)) return false;
  return expiresAt <= Date.now();
}

export async function dispatchGateGstDocuments(
  reqRow: Pick<
    TransferRequestRow,
    'transfer_request_id' | 'from_location_id' | 'to_location_id' | 'quantity'
  >,
  client?: PoolClient,
): Promise<GstDocumentGate> {
  const threshold = config.gst.ewayBillTaxableValueThresholdInr;
  const classification = await getBranchTransferClassification(reqRow.transfer_request_id, client);
  if (!classification) {
    return {
      blocked: true,
      reasons: ['not_valued'],
      taxable_value: null,
      threshold,
      valued_quantity: null,
    };
  }
  if (classification.supply_class !== 'inter_gstin') {
    return { blocked: false, reasons: [], taxable_value: null, threshold, valued_quantity: null };
  }
  const valuation = await getBranchTransferValuation(reqRow.transfer_request_id, client);
  if (!valuation) {
    return {
      blocked: true,
      reasons: ['not_valued'],
      taxable_value: null,
      threshold,
      valued_quantity: null,
    };
  }
  const reasons: string[] = [];
  const taxInvoice = await getBranchTransferGstDocument(
    reqRow.transfer_request_id,
    'tax_invoice',
    client,
  );
  if (!taxInvoice) {
    reasons.push('tax_invoice_missing');
  } else if (taxInvoice.irn_ext === null || !IRN_EXT_REGEX.test(taxInvoice.irn_ext)) {
    reasons.push('irn_missing');
  }
  if (monToNum(valuation.taxable_value) > threshold) {
    const ewayBill = await getBranchTransferGstDocument(
      reqRow.transfer_request_id,
      'e_way_bill',
      client,
    );
    if (!ewayBill) {
      reasons.push('e_way_bill_missing');
    } else if (isEwayBillExpired(ewayBill.ewb_valid_until)) {
      // Code review D5-P: ewb_valid_until was written, shape-checked once and then never compared
      // to anything, so a bill that expired two years ago satisfied the gate. An e-way bill is
      // valid one day per 200 km, so expiry while a truck waits at the gate is routine, not exotic
      // - and blocking here is the cheap version of a checkpost detention.
      reasons.push('e_way_bill_expired');
    }
  }
  return {
    blocked: reasons.length > 0,
    reasons,
    taxable_value: valuation.taxable_value,
    threshold,
    valued_quantity: reqRow.quantity,
  };
}

// ---------------------------------------------------------------------------
// Story 11.5 Task 4: valuation override by the GST officer
// ---------------------------------------------------------------------------

const VALUATION_LOCKED_STATUSES = new Set([
  'shipped',
  'partially_received',
  'received',
  'rejected',
]);
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const OVERRIDE_ALLOWED_FIELDS = new Set([
  'transfer_request_id',
  'site_id',
  'business_stream',
  'valuation_basis',
  'declared_unit_value',
  'reason_code',
  'cost_centre',
  'project_code',
]);

export function assertTransferValuationOverriddenShape(envelope: EventEnvelope): void {
  if (envelope.event_type !== 'transfer_request.valuation_overridden') return;
  const p = envelope.payload as Record<string, unknown>;
  for (const key of Object.keys(p)) {
    if (!OVERRIDE_ALLOWED_FIELDS.has(key)) {
      throw new AppError(
        400,
        'INVALID_PARAMS',
        `overridden_by and every other field is server-derived and refused on input (unexpected key: ${key})`,
        { field: key },
      );
    }
  }
  if (!isNonEmptyString(p['transfer_request_id']) || !UUID_REGEX.test(p['transfer_request_id'])) {
    throw new AppError(400, 'INVALID_PARAMS', 'transfer_request_id is required and must be a UUID');
  }
  if (!isNonEmptyString(p['site_id']) || !UUID_REGEX.test(p['site_id'])) {
    throw new AppError(400, 'INVALID_PARAMS', 'site_id is required and must be a UUID');
  }
  if (!isNonEmptyString(p['business_stream'])) {
    throw new AppError(400, 'INVALID_PARAMS', 'business_stream is required');
  }
  if (!isRule28Basis(p['valuation_basis'])) {
    throw new AppError(
      400,
      'INVALID_PARAMS',
      'valuation_basis must be one of open_market_value, like_kind_quality, cost_plus, invoice_value_full_itc',
    );
  }
  if (p['declared_unit_value'] !== undefined && !isPositiveDecimal(p['declared_unit_value'])) {
    throw new AppError(
      400,
      'INVALID_PARAMS',
      'declared_unit_value must be a positive number or numeric string when supplied',
    );
  }
  if (typeof p['reason_code'] !== 'string' || p['reason_code'].trim() === '') {
    throw new AppError(400, 'INVALID_PARAMS', 'reason_code is required and must be non-blank');
  }
}

/**
 * Locks the transfer row and returns it with its valuation.
 *
 * Code review P18: the site check runs FIRST. NOT_FOUND and NOT_A_BRANCH_TRANSFER used to be thrown
 * before assertPayloadSiteBound, which made this door an enumeration oracle: a caller holding one
 * site could probe arbitrary transfer ids at other sites and read the answer off the status code.
 * The bound site comes from the create-time classification stamp (present for EVERY transfer since
 * D1-P) and falls back to the valuation row, so a caller who names the wrong site is turned away
 * before learning anything about the transfer itself.
 *
 * Code review E1-P: `allowUnvaluedInterGstin` opens the officer's door on a transfer that E1-P
 * created UNVALUED. It relaxes NOT_A_BRANCH_TRANSFER for - and ONLY for - a transfer whose
 * classification stamp says `inter_gstin` while no valuation row exists yet; an `intra_site` or
 * `intra_gstin` stamp, and an unstamped transfer, still refuse exactly as before.
 */
async function lockBranchTransfer(
  transferRequestId: string,
  payloadSiteId: string,
  client: PoolClient,
  allowUnvaluedInterGstin = false,
): Promise<{
  reqRow: TransferRequestRow;
  valuation: BranchTransferValuationRow | null;
  classification: BranchTransferClassificationRow | null;
}> {
  const reqRow = await getTransferRequestById(transferRequestId, client, true);
  const valuation = await getBranchTransferValuation(transferRequestId, client);
  const classification = await getBranchTransferClassification(transferRequestId, client);
  const boundSiteId = classification?.from_site_id ?? valuation?.from_site_id ?? null;
  if (boundSiteId !== null) assertPayloadSiteBound(payloadSiteId, boundSiteId);
  if (!reqRow) {
    throw new AppError(404, 'NOT_FOUND', `Transfer request "${transferRequestId}" not found`);
  }
  if (!valuation && !(allowUnvaluedInterGstin && classification?.supply_class === 'inter_gstin')) {
    throw new AppError(
      409,
      'NOT_A_BRANCH_TRANSFER',
      `Transfer request "${transferRequestId}" is not a valued inter-GSTIN supply`,
      { transfer_request_id: transferRequestId },
    );
  }
  return { reqRow, valuation, classification };
}

/**
 * Binds the payload site to the transfer's FROM site. The events door authorises the actor
 * against the payload's site_id, so an unbound payload could name a site the actor holds while
 * targeting a transfer at another (the 2026-09-06 cross-site class).
 *
 * P18: the detail names only the site the CALLER supplied. Echoing the transfer's real from_site_id
 * back handed an unauthorised caller the very identifier the refusal exists to withhold.
 */
function assertPayloadSiteBound(payloadSiteId: string, boundSiteId: string): void {
  if (payloadSiteId.toLowerCase() !== boundSiteId.toLowerCase()) {
    throw new AppError(
      400,
      'TRANSFER_SITE_MISMATCH',
      "site_id must be the transfer's source site",
      { site_id: payloadSiteId },
    );
  }
}

/**
 * Task 4.2: re-values a not-yet-documented, not-yet-shipped inter-GSTIN transfer on the officer's
 * basis. Refuses NOT_A_BRANCH_TRANSFER, VALUATION_LOCKED (shipped or beyond, rejected, or ANY GST
 * document recorded) and BASIS_NOT_ELIGIBLE. The actor is metadata.actor.user_id, pinned by both
 * doors. A replay of the same event id is the persistEvent short-circuit; no second layer here.
 *
 * Code review E1-P: this is ALSO the officer's FIRST valuation of a transfer E1-P created unvalued
 * (an inter_gstin stamp with no valuation row, because the pair defaults to a hand-declared basis
 * and the creator is not a GST officer). Same door, same gate, same locks: the only difference is an
 * INSERT instead of an UPDATE. The insert stamps basis_source from the PROVENANCE of the unit value
 * - `config_default` for cost_plus, which is derived from the running average cost, `declared` for a
 * human-supplied figure - never `override`, which the UPDATE below hard-codes. Per the table's CHECK
 * (`basis_source <> 'override'` REQUIRES `overridden_by IS NULL`) the insert leaves overridden_by
 * and override_reason_code NULL: the officer's identity and reason_code live on the event that
 * produced source_event_id, which is the row's only link back to them.
 */
export async function applyTransferValuationOverridden(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId?: string,
): Promise<void> {
  if (envelope.event_type !== 'transfer_request.valuation_overridden') return;
  const p = envelope.payload as Record<string, unknown>;
  const transferRequestId = (p['transfer_request_id'] as string).toLowerCase();
  const basis = p['valuation_basis'] as Rule28Basis;
  const reasonCode = (p['reason_code'] as string).trim();
  const declaredUnitValue = (p['declared_unit_value'] as string | number | undefined) ?? null;

  const { reqRow, valuation, classification } = await lockBranchTransfer(
    transferRequestId,
    p['site_id'] as string,
    client,
    // E1-P: an inter_gstin transfer with no valuation row yet is this door's FIRST valuation.
    true,
  );

  const sourceEventId = eventId ?? envelope.event_id;
  if (!sourceEventId) {
    throw new AppError(
      500,
      'EVENT_ID_MISSING',
      'source_event_id could not be resolved for override',
    );
  }
  // Code review P10: the replay short-circuit the create and document appliers already had. The row
  // is locked, so this comparison is exact: an override whose event id is already stamped on the row
  // has been applied, and replaying it after shipment used to throw VALUATION_LOCKED for an event
  // the system had ALREADY ACCEPTED, stalling the replay on a permanent error. E1-P: it covers the
  // first-valuation path too, since that path stamps the same source_event_id on the row it inserts.
  if (valuation?.source_event_id === sourceEventId) return;

  if (VALUATION_LOCKED_STATUSES.has(reqRow.status)) {
    throw new AppError(
      409,
      'VALUATION_LOCKED',
      `Transfer request "${transferRequestId}" is ${reqRow.status}; its valuation can no longer be overridden`,
      {
        transfer_request_id: transferRequestId,
        current_status: reqRow.status,
        locked_by: 'status',
      },
    );
  }
  if (await branchTransferHasGstDocument(transferRequestId, client)) {
    throw new AppError(
      409,
      'VALUATION_LOCKED',
      `Transfer request "${transferRequestId}" already has a GST document recorded; its valuation is locked`,
      { transfer_request_id: transferRequestId, locked_by: 'gst_document' },
    );
  }

  // E1-P: the GSTIN pair and business date of the valuation being written. On the update path they
  // come from the row itself; on the first-valuation path from the create-time classification stamp,
  // whose GSTIN columns are non-null for an inter_gstin class by the table's own CHECK.
  const pair = valuation ?? classification;
  if (!pair || pair.from_gstin_ext === null || pair.to_gstin_ext === null) {
    throw new AppError(
      409,
      'NOT_A_BRANCH_TRANSFER',
      `Transfer request "${transferRequestId}" is not a valued inter-GSTIN supply`,
      { transfer_request_id: transferRequestId },
    );
  }

  // The pair configuration effective on the transfer's business date governs eligibility and the
  // cost-plus percentage; a pair that has lost its configuration since creation fails closed.
  const valuationConfig = await requireValuationConfig(
    pair.from_gstin_ext,
    pair.to_gstin_ext,
    pair.business_date,
    client,
  );
  assertBasisEligible(basis, valuationConfig);

  const valued = await valueOnBasis(
    basis,
    reqRow.sku_id,
    reqRow.quantity,
    declaredUnitValue,
    valuationConfig.cost_plus_percent,
    client,
  );
  if (!valuation) {
    // E1-P: the officer's FIRST valuation of a transfer created unvalued. An INSERT, not an UPDATE.
    //
    // basis_source describes HOW THE UNIT VALUE WAS DERIVED, never which door the write came
    // through: cost_plus reads the running average cost, so it is `config_default` here exactly as
    // it is on the create path, and only a human-supplied declared_unit_value is `declared`.
    // Stamping the whole of this path `declared` would reintroduce the provenance
    // misrepresentation D3-P exists to remove. `override` stays reserved for the UPDATE below,
    // which hard-codes it.
    //
    // ATTRIBUTION: this row records NO overridden_by and NO override_reason_code. The table's CHECK
    // reserves overridden_by for the override path (`basis_source <> 'override'` REQUIRES
    // `overridden_by IS NULL`, and a NULL overridden_by in turn REQUIRES a NULL
    // override_reason_code), so the officer's identity and the payload's reason_code are carried
    // ONLY by source_event_id and the event envelope it points at. That is the whole of the
    // row-level attribution for a first valuation; do not work around the CHECK to widen it.
    await insertBranchTransferValuation(
      {
        transfer_request_id: transferRequestId,
        from_site_id: pair.from_site_id,
        to_site_id: pair.to_site_id,
        from_gstin_ext: pair.from_gstin_ext,
        to_gstin_ext: pair.to_gstin_ext,
        business_date: pair.business_date,
        valuation_config_id: valuationConfig.config_id,
        valuation_basis: basis,
        basis_source: valued.running_cost_used ? 'config_default' : 'declared',
        cost_plus_percent: valued.running_cost_used ? valuationConfig.cost_plus_percent : null,
        declared_unit_value:
          valued.running_cost_used || declaredUnitValue === null ? null : String(declaredUnitValue),
        unit_value: valued.unit_value,
        taxable_value: valued.taxable_value,
        valued_at: new Date().toISOString(),
        source_event_id: sourceEventId,
      },
      client,
    );
    return;
  }
  await overrideBranchTransferValuation(
    {
      transfer_request_id: transferRequestId,
      // P9: the configuration THIS override re-resolved, not the create-time one. It is re-resolved
      // on the transfer's business date for every basis (it governs eligibility as well as the
      // cost-plus percentage), so leaving the create-time id in place beside the override's own
      // cost_plus_percent made the audit row internally inconsistent.
      valuation_config_id: valuationConfig.config_id,
      valuation_basis: basis,
      cost_plus_percent: valued.running_cost_used ? valuationConfig.cost_plus_percent : null,
      declared_unit_value:
        valued.running_cost_used || declaredUnitValue === null ? null : String(declaredUnitValue),
      unit_value: valued.unit_value,
      taxable_value: valued.taxable_value,
      overridden_by: envelope.metadata.actor.user_id,
      override_reason_code: reasonCode,
      valued_at: new Date().toISOString(),
      source_event_id: sourceEventId,
    },
    client,
  );
}

// ---------------------------------------------------------------------------
// Story 11.5 Task 5: GST document recording
// ---------------------------------------------------------------------------

const DOCUMENT_ALLOWED_FIELDS = new Set([
  'transfer_request_id',
  'site_id',
  'business_stream',
  'document_kind',
  'document_number_ext',
  'irn_ext',
  'irp_acknowledged_at',
  'ewb_valid_until',
  'issued_at',
  'cost_centre',
  'project_code',
]);

// Strict RFC 3339 instant (the isValidIrpAcknowledgedAt shape) WITHOUT the not-in-the-future rule:
// an e-way bill's validity end lies in the future by construction.
const ISO_INSTANT_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

/**
 * P12: instants are compared as INSTANTS, not as text. The stored value is a timestamptz read back
 * in the driver's rendering, so "2026-09-09T10:00:00Z" and the same moment with an offset or a
 * trailing ".000" are the SAME document and must not be reported as a conflict.
 */
function sameInstant(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  const left = Date.parse(a);
  const right = Date.parse(b);
  if (Number.isNaN(left) || Number.isNaN(right)) return a === b;
  return left === right;
}

function isIsoInstant(value: unknown): value is string {
  return (
    typeof value === 'string' && ISO_INSTANT_REGEX.test(value) && !Number.isNaN(Date.parse(value))
  );
}

export function assertTransferGstDocumentRecordedShape(envelope: EventEnvelope): void {
  if (envelope.event_type !== 'transfer_request.gst_document_recorded') return;
  const p = envelope.payload as Record<string, unknown>;
  for (const key of Object.keys(p)) {
    if (!DOCUMENT_ALLOWED_FIELDS.has(key)) {
      throw new AppError(
        400,
        'INVALID_PARAMS',
        `recorded_by and every other field is server-derived and refused on input (unexpected key: ${key})`,
        { field: key },
      );
    }
  }
  if (!isNonEmptyString(p['transfer_request_id']) || !UUID_REGEX.test(p['transfer_request_id'])) {
    throw new AppError(400, 'INVALID_PARAMS', 'transfer_request_id is required and must be a UUID');
  }
  if (!isNonEmptyString(p['site_id']) || !UUID_REGEX.test(p['site_id'])) {
    throw new AppError(400, 'INVALID_PARAMS', 'site_id is required and must be a UUID');
  }
  if (!isNonEmptyString(p['business_stream'])) {
    throw new AppError(400, 'INVALID_PARAMS', 'business_stream is required');
  }
  const kind = p['document_kind'];
  if (typeof kind !== 'string' || !(GST_DOCUMENT_KINDS as readonly string[]).includes(kind)) {
    throw new AppError(400, 'INVALID_PARAMS', 'document_kind must be tax_invoice or e_way_bill');
  }
  if (typeof p['document_number_ext'] !== 'string' || p['document_number_ext'].trim() === '') {
    throw new AppError(
      400,
      'INVALID_PARAMS',
      'document_number_ext is required and must be a non-empty string',
    );
  }
  if (!isIsoInstant(p['issued_at']) || !isValidIrpAcknowledgedAt(p['issued_at'])) {
    throw new AppError(
      400,
      'INVALID_PARAMS',
      'issued_at must be an RFC 3339 instant not in the future',
    );
  }
  if (kind === 'tax_invoice') {
    // Every inter-GSTIN supply is e-invoiceable (the Story 11.2 ruling): the invoice record MUST
    // carry the IRP's 64-character hexadecimal IRN. Reuses the 11.2 validator, never a second regex.
    if (typeof p['irn_ext'] !== 'string' || !IRN_EXT_REGEX.test(p['irn_ext'].trim())) {
      throw new AppError(
        400,
        'INVALID_PARAMS',
        'irn_ext is required for a tax invoice and must be the 64-character hexadecimal IRN issued by the IRP',
      );
    }
    if (
      p['irp_acknowledged_at'] !== undefined &&
      !isValidIrpAcknowledgedAt(p['irp_acknowledged_at'])
    ) {
      throw new AppError(
        400,
        'INVALID_PARAMS',
        'irp_acknowledged_at must be an RFC 3339 instant not in the future',
      );
    }
    if (p['ewb_valid_until'] !== undefined) {
      throw new AppError(400, 'INVALID_PARAMS', 'ewb_valid_until applies to an e_way_bill only');
    }
  } else {
    if (!isIsoInstant(p['ewb_valid_until'])) {
      throw new AppError(
        400,
        'INVALID_PARAMS',
        'ewb_valid_until is required for an e-way bill and must be an RFC 3339 instant',
      );
    }
    if (p['irn_ext'] !== undefined || p['irp_acknowledged_at'] !== undefined) {
      throw new AppError(400, 'INVALID_PARAMS', 'irn_ext applies to a tax_invoice only');
    }
  }
}

/**
 * Task 5.3: records ONE ERP-issued document of a kind against a valued inter-GSTIN transfer, under
 * the transfer row lock. Refuses NOT_A_BRANCH_TRANSFER, GST_DOCUMENT_STATE_INVALID (rejected,
 * shipped or beyond, or not yet approved), and a DIFFERENT document number for an already-recorded
 * kind (409 GST_DOCUMENT_CONFLICT); the SAME number is a no-op. The lock turns a race into a clean
 * 409 rather than a 23505 on the UNIQUE. One applier handles both kinds (the 9.9 / 9.10
 * "parameterise by kind" lesson).
 *
 * Code review Q2: both window refusals below carry the DEDICATED code GST_DOCUMENT_STATE_INVALID,
 * not the generic INVALID_STATE. INVALID_STATE is thrown at thirteen sites - among them
 * applyTransferReceiveProjection, where a receive that overtakes its ship is a TRANSIENT ordering
 * problem an offline device's outbox self-heals on retry. Classifying INVALID_STATE as a permanent
 * error to make these two refusals dead-letter would have dead-lettered those retries instead; the
 * permanence belongs to this code alone.
 */
export async function applyTransferGstDocumentRecorded(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId?: string,
): Promise<BranchTransferGstDocumentRow | null> {
  if (envelope.event_type !== 'transfer_request.gst_document_recorded') return null;
  const p = envelope.payload as Record<string, unknown>;
  const transferRequestId = (p['transfer_request_id'] as string).toLowerCase();
  const kind = p['document_kind'] as GstDocumentKind;
  const documentNumber = (p['document_number_ext'] as string).trim();

  const { reqRow, valuation } = await lockBranchTransfer(
    transferRequestId,
    p['site_id'] as string,
    client,
  );

  // lockBranchTransfer was called WITHOUT allowUnvaluedInterGstin, so it has already refused an
  // unvalued transfer with NOT_A_BRANCH_TRANSFER; this is the narrowing, not a second gate.
  if (!valuation) {
    throw new AppError(
      409,
      'NOT_A_BRANCH_TRANSFER',
      `Transfer request "${transferRequestId}" is not a valued inter-GSTIN supply`,
      { transfer_request_id: transferRequestId },
    );
  }

  if (VALUATION_LOCKED_STATUSES.has(reqRow.status)) {
    throw new AppError(
      400,
      'GST_DOCUMENT_STATE_INVALID',
      `Transfer request is in status "${reqRow.status}"; GST documents are recorded before shipment`,
      { transfer_request_id: transferRequestId, current_status: reqRow.status },
    );
  }
  // Code review P15: and NOT before approval either. A transfer awaiting approval accepted an
  // IRN-bearing tax invoice, so a filed e-invoice could end up against a transfer that was then
  // REJECTED - with the valuation permanently locked by that document and no DELETE grant anywhere
  // to unwind it. The window for recording is approved-or-pending-shipment, and nothing else.
  if (reqRow.status !== 'approved' && reqRow.status !== 'pending_shipment') {
    throw new AppError(
      400,
      'GST_DOCUMENT_STATE_INVALID',
      `Transfer request is in status "${reqRow.status}"; GST documents are recorded once the transfer is approved and before it ships`,
      { transfer_request_id: transferRequestId, current_status: reqRow.status },
    );
  }

  const irnExt = kind === 'tax_invoice' ? normalizeIrnExt(p['irn_ext'] as string) : null;
  const irpAcknowledgedAt =
    kind === 'tax_invoice' ? ((p['irp_acknowledged_at'] as string | undefined) ?? null) : null;
  const ewbValidUntil = kind === 'e_way_bill' ? (p['ewb_valid_until'] as string) : null;
  const issuedAt = p['issued_at'] as string;

  const existing = await getBranchTransferGstDocument(transferRequestId, kind, client);
  if (existing) {
    // Code review P12: the replay match compares the whole filed record, not the document number
    // alone. A second recording carrying the same number with a CORRECTED IRN, issue instant or
    // e-way-bill validity used to be discarded in silence while the API answered success, so the
    // stored document and the filed one drifted apart with no trace.
    const diverged =
      existing.document_number_ext !== documentNumber ||
      existing.irn_ext !== irnExt ||
      !sameInstant(existing.issued_at, issuedAt) ||
      !sameInstant(existing.ewb_valid_until, ewbValidUntil);
    if (!diverged) return existing;
    throw new AppError(
      409,
      'GST_DOCUMENT_CONFLICT',
      `A ${kind} numbered ${existing.document_number_ext} is already recorded for transfer request "${transferRequestId}" and differs from the one being recorded`,
      {
        transfer_request_id: transferRequestId,
        document_kind: kind,
        document_number_ext: documentNumber,
        existing_document_number_ext: existing.document_number_ext,
        irn_ext: irnExt,
        existing_irn_ext: existing.irn_ext,
        issued_at: issuedAt,
        existing_issued_at: existing.issued_at,
        ewb_valid_until: ewbValidUntil,
        existing_ewb_valid_until: existing.ewb_valid_until,
      },
    );
  }

  const sourceEventId = eventId ?? envelope.event_id;
  if (!sourceEventId) {
    throw new AppError(
      500,
      'EVENT_ID_MISSING',
      'source_event_id could not be resolved for document',
    );
  }
  return insertBranchTransferGstDocument(
    {
      transfer_request_id: transferRequestId,
      document_kind: kind,
      document_number_ext: documentNumber,
      irn_ext: irnExt,
      irp_acknowledged_at: irpAcknowledgedAt,
      ewb_valid_until: ewbValidUntil,
      issued_at: issuedAt,
      site_id: valuation.from_site_id,
      recorded_by: envelope.metadata.actor.user_id,
      source_event_id: sourceEventId,
      correlation_id: (envelope.metadata.correlation_id as string | undefined) ?? null,
    },
    client,
  );
}
