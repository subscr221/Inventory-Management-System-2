import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { EventEnvelope } from '../events/store.js';
import { AppError } from '../middleware/error.js';
import { alreadyPersisted } from './indent.js';
import { applyStockReceipt } from '../read/projections/stock_balance.js';
import {
  applyValuationReturn,
  asValuationOutflow,
  type ValuationOutflow,
} from './inventory-valuation.js';
import {
  decrementRdWipOpenQuantity,
  getRdWipPostingById,
  insertRdWipPosting,
} from '../read/projections/rd_project_wip_ledger.js';
import { getLocationCode } from '../read/projections/rd_prototype.js';
import { getRdRequisitionById, getRdRequisitionLines } from '../read/projections/rd_requisition.js';

const TYPES = new Set(['rd_material.returned']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function reject(
  code: string,
  message: string,
  details?: Record<string, unknown>,
  status = 400,
): never {
  throw new AppError(status, code, message, details);
}
export function rdWipEventType(envelope: EventEnvelope): string | null {
  return envelope.stream_type === 'research' && TYPES.has(envelope.event_type)
    ? envelope.event_type
    : null;
}

export async function postProjectWipForIssue(
  input: {
    issue_cost_id: string;
    rd_issue_id: string;
    requisition_id: string;
    requisition_line_id: string;
    project_code: string;
    sku: string;
    quantity: string;
    valuation: ValuationOutflow;
    occurred_at: string;
  },
  client: PoolClient,
  eventId: string,
): Promise<void> {
  const postingValue = await client.query('SELECT round($1::numeric, 4)::text AS value', [
    input.valuation.value,
  ]);
  await insertRdWipPosting(
    {
      posting_id: randomUUID(),
      project_code: input.project_code,
      posting_type: 'issue',
      issue_cost_id: input.issue_cost_id,
      rd_issue_id: input.rd_issue_id,
      requisition_id: input.requisition_id,
      requisition_line_id: input.requisition_line_id,
      sku: input.sku,
      quantity: input.quantity,
      open_quantity: input.quantity,
      unit_cost: input.valuation.unit_cost,
      posting_value: postingValue.rows[0]!['value'] as string,
      reason_code: null,
      source_posting_id: null,
      source_event_id: eventId,
      occurred_at: input.occurred_at,
    },
    client,
  );
}

export function assertRdReturnShape(envelope: EventEnvelope): void {
  if (!rdWipEventType(envelope)) return;
  const p = envelope.payload as Record<string, unknown>;
  for (const field of ['posting_id', 'location_id', 'lot_id'])
    if (typeof p[field] !== 'string' || !UUID.test(p[field] as string))
      reject('INVALID_PARAMS', `${field} must be a UUID`);
  for (const field of ['project_code', 'lot_id', 'reason_code'])
    if (typeof p[field] !== 'string' || !(p[field] as string).trim())
      reject('INVALID_PARAMS', `${field} is required`);
  if (
    typeof p['quantity'] !== 'string' ||
    !/^\d{1,9}(\.\d{1,6})?$/.test(p['quantity']) ||
    Number(p['quantity']) <= 0
  )
    reject('INVALID_PARAMS', 'quantity must be a positive decimal string');
}

export async function applyRdReturnProjection(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
): Promise<void> {
  if (!rdWipEventType(envelope) || (await alreadyPersisted(envelope, client))) return;
  const p = envelope.payload as Record<string, unknown>;
  const source = await getRdWipPostingById(p['posting_id'] as string, client, true);
  if (
    !source ||
    source.posting_type !== 'issue' ||
    source.project_code !== p['project_code'] ||
    source.open_quantity === null
  )
    reject(
      'RD_RETURN_EXCEEDS_OPEN',
      'Return source must be an open issue posting in the project',
      { posting_id: p['posting_id'] },
      409,
    );
  const requisitionLines = await getRdRequisitionLines(source.requisition_id, client);
  const requisitionLine = requisitionLines.find(
    (line) => line.requisition_line_id === source.requisition_line_id,
  );
  if (!requisitionLine || requisitionLine.issue_type !== 'project_material')
    reject(
      'RD_RETURN_EXCEEDS_OPEN',
      'Returns are only allowed for project-material issue postings',
      { posting_id: source.posting_id },
      409,
    );
  const values = await client.query(
    'SELECT $1::numeric > $2::numeric AS exceeds, ($2::numeric - $1::numeric)::text AS returned_before',
    [p['quantity'], source.open_quantity],
  );
  if (values.rows[0]!['exceeds'])
    reject(
      'RD_RETURN_EXCEEDS_OPEN',
      'Return quantity exceeds the source posting open quantity',
      { posting_id: source.posting_id, open_quantity: source.open_quantity },
      409,
    );
  const req = await getRdRequisitionById(source.requisition_id, client);
  if (!req)
    reject(
      'RD_REQUISITION_NOT_FOUND',
      'Source requisition not found',
      { requisition_id: source.requisition_id },
      404,
    );
  const returnLot = await client.query(
    'SELECT sku FROM lot_master WHERE lot_id::text = $1 LIMIT 1',
    [p['lot_id']],
  );
  if (!returnLot.rows[0] || returnLot.rows[0]['sku'] !== source.sku)
    reject(
      'LOT_NOT_FOUND',
      'Return lot does not match the project-material SKU',
      { lot_id: p['lot_id'], sku: source.sku },
      404,
    );
  const locationCode = await getLocationCode(p['location_id'] as string, client);
  if (!locationCode)
    reject(
      'LOCATION_NOT_FOUND',
      'Return location not found',
      { location_id: p['location_id'] },
      404,
    );
  await applyStockReceipt(
    {
      sku: source.sku,
      location_id: p['location_id'] as string,
      location_code: locationCode,
      lot_id: p['lot_id'] as string,
      stock_class: 'owned',
      quantity: p['quantity'] as string,
    },
    client,
  );
  const eventResult = await client.query(
    "SELECT payload->'issued_lines' AS lines FROM domain_events WHERE event_type = 'rd_requisition.issued' AND payload->>'issue_id' = $1 LIMIT 1",
    [source.rd_issue_id],
  );
  const lines = (eventResult.rows[0]?.['lines'] ?? []) as Array<Record<string, unknown>>;
  const issueLine = lines.find(
    (line) => line['requisition_line_id'] === source.requisition_line_id,
  );
  const issue = asValuationOutflow(issueLine?.['valuation']);
  if (!issue)
    reject(
      'RD_RETURN_EXCEEDS_OPEN',
      'Issue valuation detail is unavailable for this posting',
      { posting_id: source.posting_id },
      409,
    );
  const returnedBefore = values.rows[0]!['returned_before'] as string;
  const valuation = await applyValuationReturn(
    { sku: source.sku, quantity: p['quantity'] as string, issue, returned_before: returnedBefore },
    client,
    eventId,
  );
  const amount = await client.query('SELECT round($1::numeric, 4)::text AS value', [
    valuation.value,
  ]);
  const postingId = randomUUID();
  await insertRdWipPosting(
    {
      posting_id: postingId,
      project_code: source.project_code,
      posting_type: 'return',
      issue_cost_id: source.issue_cost_id,
      rd_issue_id: source.rd_issue_id,
      requisition_id: source.requisition_id,
      requisition_line_id: source.requisition_line_id,
      sku: source.sku,
      quantity: p['quantity'] as string,
      open_quantity: null,
      unit_cost: source.unit_cost,
      posting_value: `-${amount.rows[0]!['value'] as string}`,
      reason_code: p['reason_code'] as string,
      source_posting_id: source.posting_id,
      source_event_id: eventId,
      occurred_at: envelope.metadata.occurred_at,
    },
    client,
  );
  await decrementRdWipOpenQuantity(source.posting_id, p['quantity'] as string, client);
  (envelope.payload as Record<string, unknown>)['return_posting_id'] = postingId;
  (envelope.payload as Record<string, unknown>)['valuation'] = valuation;
}
