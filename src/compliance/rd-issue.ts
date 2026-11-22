import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { EventEnvelope } from '../events/store.js';
import { AppError } from '../middleware/error.js';
import { alreadyPersisted } from './indent.js';
import { toIstCalendarDate, isValidCalendarDate } from '../lib/business-days.js';
import { applyStockIssue } from '../read/projections/stock_balance.js';
import { applyValuationOutflow } from '../compliance/inventory-valuation.js';
import { assertRdIssueGuards } from './rd-guards.js';
import { getAssetById } from '../read/projections/asset.js';
import {
  getRdRequisitionById,
  getRdRequisitionLineForUpdate,
  incrementRdRequisitionLineIssued,
} from '../read/projections/rd_requisition.js';
import { getRdProjectChecklist } from '../read/projections/rd_project_checklist.js';
import { insertRdIssueCost } from '../read/projections/rd_issue_cost.js';
import {
  insertRdEquipmentCustody,
  rdIssueExists,
} from '../read/projections/rd_equipment_custody.js';
import type { RdRequisitionIssuedPayload } from '../events/schema.js';

/**
 * Story 10.2 (FR-RD-06): the R&D issue seam. Consumable and project-material lines drain stock,
 * relieve valuation, and write an immutable Ind AS 38 costing row whose business_date is derived
 * server-side in IST. Equipment-custody lines drain stock (so the item cannot be double-loaned)
 * but write no cost row and relieve no valuation - the loan keeps its value. The issue seam also
 * refuses any line whose quantity exceeds requested_qty - issued_quantity (RD_REQUISITION_LINE_EXCEEDED)
 * and increments issued_quantity in the SAME transaction.
 */

const RESEARCH_STREAM_TYPES = new Set(['research']);
const RD_ISSUE_EVENT_TYPES = new Set(['rd_requisition.issued']);

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const QTY_REGEX = /^\d{1,9}(\.\d{1,3})?$/;
const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_REGEX.test(value);
}

function reject(
  code: string,
  message: string,
  details?: Record<string, unknown>,
  status: number = 400,
): never {
  throw new AppError(status, code, message, details);
}

export function rdIssueEventType(envelope: EventEnvelope): string | null {
  if (!RESEARCH_STREAM_TYPES.has(envelope.stream_type)) return null;
  if (!RD_ISSUE_EVENT_TYPES.has(envelope.event_type)) return null;
  return envelope.event_type;
}

function assertOccurredAt(occurredAt: unknown): asserts occurredAt is string {
  if (
    !occurredAt ||
    typeof occurredAt !== 'string' ||
    Number.isNaN(new Date(occurredAt).getTime())
  ) {
    reject('INVALID_PARAMS', 'occurred_at is required and must be a valid ISO 8601 date string');
  }
}

export function assertRdIssueShape(envelope: EventEnvelope): void {
  const type = rdIssueEventType(envelope);
  if (!type) return;
  const p = envelope.payload as Record<string, unknown>;
  assertOccurredAt(envelope.metadata.occurred_at);
  if (!isUuid(p['requisition_id'])) reject('INVALID_PARAMS', 'requisition_id must be a UUID');
  if (!isUuid(p['issue_id'])) reject('INVALID_PARAMS', 'issue_id must be a UUID');
  const lines = p['lines'];
  if (!Array.isArray(lines) || lines.length === 0) {
    reject('RD_REQUISITION_LINE_REQUIRED', 'at least one issue line is required');
  }
  for (const raw of lines) {
    const l = raw as Record<string, unknown>;
    if (!l || typeof l !== 'object') reject('INVALID_PARAMS', 'issue line must be an object');
    if (!isUuid(l['requisition_line_id'])) reject('INVALID_PARAMS', 'requisition_line_id must be a UUID');
    if (typeof l['quantity'] !== 'string' || !QTY_REGEX.test(l['quantity']) || Number(l['quantity']) <= 0) {
      reject('INVALID_PARAMS', 'quantity must be a positive decimal string');
    }
    if (!isUuid(l['location_id'])) reject('INVALID_PARAMS', 'location_id must be a UUID');
    if (l['lot_id'] !== undefined && l['lot_id'] !== null && !isUuid(l['lot_id'])) {
      reject('INVALID_PARAMS', 'lot_id must be a UUID when supplied');
    }
    if (l['custodian_user_id'] !== undefined && l['custodian_user_id'] !== null && !isUuid(l['custodian_user_id'])) {
      reject('INVALID_PARAMS', 'custodian_user_id must be a UUID when supplied');
    }
    if (l['expected_return_date'] !== undefined && l['expected_return_date'] !== null) {
      if (typeof l['expected_return_date'] !== 'string' || !DATE_REGEX.test(l['expected_return_date'])) {
        reject('INVALID_PARAMS', 'expected_return_date must be a YYYY-MM-DD date when supplied');
      }
      if (!isValidCalendarDate(l['expected_return_date'])) {
        reject('INVALID_PARAMS', 'expected_return_date must be a real calendar date when supplied');
      }
    }
    if (
      l['condition_codes'] !== undefined &&
      l['condition_codes'] !== null &&
      (!Array.isArray(l['condition_codes']) ||
        l['condition_codes'].some((c) => typeof c !== 'string' || c.trim() === ''))
    ) {
      reject('INVALID_PARAMS', 'condition_codes must be an array of non-empty strings when supplied');
    }
    if (l['asset_id'] !== undefined && l['asset_id'] !== null && !isUuid(l['asset_id'])) {
      reject('INVALID_PARAMS', 'asset_id must be a UUID when supplied');
    }
  }
}

async function applyIssued(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
): Promise<void> {
  if (await alreadyPersisted(envelope, client)) return;
  const p = envelope.payload as unknown as RdRequisitionIssuedPayload;
  const occurredAt = envelope.metadata.occurred_at;
  const businessDate = toIstCalendarDate(new Date(occurredAt));

  if (await rdIssueExists(p.issue_id, client)) return;

  const req = await getRdRequisitionById(p.requisition_id, client, true);
  if (!req) {
    reject('RD_REQUISITION_NOT_FOUND', 'Requisition not found', { requisition_id: p.requisition_id }, 404);
  }
  if (req.status !== 'approved') {
    reject('RD_REQUISITION_NOT_APPROVED', 'Requisition is not approved', {
      requisition_id: p.requisition_id,
      status: req.status,
    }, 409);
  }

  const project = await client.query(
    `SELECT phase, status,
            (capitalization_effective_date AT TIME ZONE 'Asia/Kolkata')::date::text AS effective_ist
     FROM rd_project WHERE project_code = $1`,
    [req.project_code],
  );
  if (project.rows.length === 0 || project.rows[0]!['status'] !== 'active') {
    reject('PROJECT_CODE_REQUIRED', 'An R&D material transaction needs an active project code', {
      project_code: req.project_code,
    }, 409);
  }
  const phase = project.rows[0]!['phase'] as string;
  const effectiveIst = (project.rows[0]!['effective_ist'] as string | null) ?? null;

  const checklist = await getRdProjectChecklist(req.project_code, client);
  const allMet = checklist.length === 6 && checklist.every((c) => c.met);

  const issued: Array<Record<string, unknown>> = [];
  for (const line of p.lines) {
    const rl = await getRdRequisitionLineForUpdate(line.requisition_line_id, client);
    if (!rl || rl.requisition_id !== p.requisition_id) {
      reject('RD_REQUISITION_LINE_NOT_FOUND', 'Requisition line not found for this requisition', {
        requisition_line_id: line.requisition_line_id,
        requisition_id: p.requisition_id,
      }, 409);
    }

    const exceeded = await client.query(
      `SELECT $1::numeric > ($2::numeric - $3::numeric) AS exceeded`,
      [line.quantity, rl.requested_qty, rl.issued_quantity],
    );
    if (exceeded.rows[0]!['exceeded'] === true) {
      reject('RD_REQUISITION_LINE_EXCEEDED', 'Issue quantity exceeds the remaining unissued quantity', {
        requisition_line_id: rl.requisition_line_id,
        requested_qty: rl.requested_qty,
        issued_quantity: rl.issued_quantity,
        issue_quantity: line.quantity,
      }, 409);
    }

    await assertRdIssueGuards(
      client,
      { location_id: line.location_id, lot_id: line.lot_id ?? null, sku: rl.sku },
      req.business_stream,
      req.project_code,
    );

    if (rl.issue_type === 'equipment_custody') {
      if (!isUuid(line.custodian_user_id)) {
        reject('INVALID_PARAMS', 'custodian_user_id is required for an equipment-custody issue');
      }
      if (typeof line.expected_return_date !== 'string' || !DATE_REGEX.test(line.expected_return_date)) {
        reject('INVALID_PARAMS', 'expected_return_date is required for an equipment-custody issue');
      }
      if (!isValidCalendarDate(line.expected_return_date)) {
        reject('INVALID_PARAMS', 'expected_return_date must be a real calendar date');
      }
      const todayIst = toIstCalendarDate(new Date());
      if (line.expected_return_date <= todayIst) {
        reject('INVALID_PARAMS', 'expected_return_date must be in the future');
      }
      if (!Array.isArray(line.condition_codes) || line.condition_codes.length === 0) {
        reject('INVALID_PARAMS', 'condition_codes is required for an equipment-custody issue');
      }
      if (line.asset_id) {
        const asset = await getAssetById(line.asset_id, client);
        if (!asset) {
          reject('INVALID_PARAMS', 'asset_id does not exist in the asset register');
        }
      }

      await applyStockIssue(
        { sku: rl.sku, location_id: line.location_id, lot_id: line.lot_id ?? null, quantity: line.quantity, occurred_at: occurredAt },
        client,
      );
      const custody = {
        custody_id: randomUUID(),
        issue_id: p.issue_id,
        requisition_id: p.requisition_id,
        requisition_line_id: rl.requisition_line_id,
        project_code: req.project_code,
        custodian_user_id: line.custodian_user_id!,
        asset_id: line.asset_id ?? null,
        sku: rl.sku,
        quantity: line.quantity,
        expected_return_date: line.expected_return_date,
        condition_codes: line.condition_codes as string[],
        status: 'on_loan' as const,
        source_event_id: eventId,
      };
      await insertRdEquipmentCustody(custody, client);
      issued.push({
        requisition_line_id: rl.requisition_line_id,
        issue_type: 'equipment_custody',
        quantity: line.quantity,
        custody,
      });
    } else {
      await applyStockIssue(
        { sku: rl.sku, location_id: line.location_id, lot_id: line.lot_id ?? null, quantity: line.quantity, occurred_at: occurredAt },
        client,
      );
      const relieved = await applyValuationOutflow({ sku: rl.sku, quantity: line.quantity }, client);

      let capitalization: 'expensed' | 'capitalized' = 'expensed';
      let blockedReason: string | null = null;
      if (phase === 'development') {
        if (!allMet) {
          capitalization = 'expensed';
          blockedReason = 'CAPITALIZATION_CRITERIA_NOT_MET';
        } else if (effectiveIst !== null && businessDate >= effectiveIst) {
          capitalization = 'capitalized';
        } else {
          capitalization = 'expensed';
        }
      }

      await insertRdIssueCost(
        {
          issue_cost_id: randomUUID(),
          issue_id: p.issue_id,
          requisition_id: p.requisition_id,
          requisition_line_id: rl.requisition_line_id,
          project_code: req.project_code,
          issue_type: rl.issue_type,
          phase,
          capitalization,
          capitalization_blocked_reason: blockedReason,
          checklist_reference: capitalization === 'capitalized' ? req.project_code : null,
          cost_amount: relieved.value,
          unit_cost: relieved.unit_cost,
          business_date: businessDate,
          source_event_id: eventId,
        },
        client,
      );
      issued.push({
        requisition_line_id: rl.requisition_line_id,
        issue_type: rl.issue_type,
        quantity: line.quantity,
        capitalization,
        capitalization_blocked_reason: blockedReason,
        cost_amount: relieved.value,
        business_date: businessDate,
      });
    }

    const incremented = await incrementRdRequisitionLineIssued(rl.requisition_line_id, line.quantity, client);
    if (!incremented) {
      reject('RD_REQUISITION_LINE_EXCEEDED', 'Issue quantity exceeds the remaining unissued quantity', {
        requisition_line_id: rl.requisition_line_id,
      }, 409);
    }
  }

  (envelope.payload as Record<string, unknown>)['issued_lines'] = issued;
}

export async function applyRdIssueProjection(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
): Promise<void> {
  const type = rdIssueEventType(envelope);
  if (!type) return;
  await applyIssued(envelope, client, eventId);
}
