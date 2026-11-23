import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { EventEnvelope } from '../events/store.js';
import { AppError } from '../middleware/error.js';
import { alreadyPersisted } from './indent.js';
import { assertProjectCodeActive } from './rd-guards.js';
import { resolveHeadApproverInTransaction } from './rd-requisition.js';
import { getRdPrototypeById, setRdPrototypeDisposed } from '../read/projections/rd_prototype.js';
import {
  getRdDispositionById,
  insertRdDisposition,
  decideRdDisposition,
  executeRdDisposition,
  insertRdDispositionLine,
  insertRdScrapPending,
  listRdDispositionLines,
} from '../read/projections/rd_disposition.js';
import { insertAsset } from '../read/projections/asset.js';
import type { AssetRow } from '../read/projections/asset.js';

const TYPES = new Set([
  'rd_disposition.requested',
  'rd_disposition.approved',
  'rd_disposition.rejected',
  'rd_disposition.executed',
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function reject(
  code: string,
  message: string,
  details?: Record<string, unknown>,
  status = 400,
): never {
  throw new AppError(status, code, message, details);
}
export function rdDispositionEventType(envelope: EventEnvelope): string | null {
  return envelope.stream_type === 'research' && TYPES.has(envelope.event_type)
    ? envelope.event_type
    : null;
}

export function assertRdDispositionShape(envelope: EventEnvelope): void {
  const type = rdDispositionEventType(envelope);
  if (!type) return;
  const p = envelope.payload as Record<string, unknown>;
  if (!UUID.test(String(p['disposition_id'] ?? '')))
    reject('INVALID_PARAMS', 'disposition_id must be a UUID');
  if (type === 'rd_disposition.requested') {
    if (!UUID.test(String(p['prototype_id'] ?? '')))
      reject('INVALID_PARAMS', 'prototype_id must be a UUID');
    if (
      !['retain-as-asset', 'transfer-to-production', 'teardown', 'scrap'].includes(
        String(p['disposition_type']),
      )
    )
      reject('INVALID_PARAMS', 'disposition_type is invalid');
    if (
      (p['disposition_type'] === 'teardown' || p['disposition_type'] === 'scrap') &&
      (!Array.isArray(p['lines']) || p['lines'].length === 0)
    )
      reject('RD_DISPOSITION_LINE_REQUIRED', 'teardown and scrap require at least one line');
    for (const raw of (p['lines'] as Array<Record<string, unknown>> | undefined) ?? []) {
      if (
        !UUID.test(String(raw['line_id'] ?? '')) ||
        typeof raw['line_no'] !== 'number' ||
        raw['line_no'] < 1 ||
        typeof raw['component_sku'] !== 'string' ||
        typeof raw['condition_code'] !== 'string' ||
        !/^\d+(\.\d{1,6})?$/.test(String(raw['quantity'] ?? '')) ||
        Number(raw['quantity']) <= 0
      )
        reject('INVALID_PARAMS', 'disposition line is invalid');
    }
  }
  if (type === 'rd_disposition.rejected' && !(p['rejection_reason'] as string | undefined)?.trim())
    reject('INVALID_PARAMS', 'rejection_reason is required');
}

async function applyRequested(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
): Promise<void> {
  if (await alreadyPersisted(envelope, client)) return;
  const p = envelope.payload as Record<string, unknown>;
  const prototypeId = p['prototype_id'] as string;
  const prototype = await getRdPrototypeById(prototypeId, client, true);
  if (!prototype)
    reject('RD_PROTOTYPE_NOT_FOUND', 'Prototype not found', { prototype_id: prototypeId }, 404);
  if (prototype.status !== 'registered')
    reject(
      'RD_PROTOTYPE_ALREADY_DISPOSED',
      'Prototype has already been disposed',
      { prototype_id: prototypeId },
      409,
    );
  const open = await client.query(
    "SELECT 1 FROM rd_disposition WHERE prototype_id = $1 AND status IN ('approval_required','approved') LIMIT 1",
    [prototypeId],
  );
  if (open.rows.length)
    reject(
      'RD_DISPOSITION_ALREADY_DECIDED',
      'Prototype already has an open disposition',
      { prototype_id: prototypeId },
      409,
    );
  const project = await client.query(
    'SELECT status FROM rd_project WHERE project_code = $1 FOR UPDATE',
    [prototype.project_code],
  );
  assertProjectCodeActive(
    prototype.project_code,
    (project.rows[0] as { status: string } | undefined) ?? null,
  );
  const head = await resolveHeadApproverInTransaction(client, envelope.metadata.actor.user_id);
  if (envelope.metadata.actor.user_id === head.approverActorId)
    reject(
      'APPROVAL_UNRESOLVED',
      'Requester cannot approve their own disposition',
      { prototype_id: prototypeId },
      409,
    );
  const dispositionId = p['disposition_id'] as string;
  const rows = (p['lines'] as Array<Record<string, unknown>> | undefined) ?? [];
  if (p['disposition_type'] === 'retain-as-asset') {
    const asset = p['asset'] as Record<string, unknown> | undefined;
    if (
      !asset ||
      !UUID.test(String(asset['asset_id'] ?? '')) ||
      typeof asset['asset_tag'] !== 'string' ||
      typeof asset['asset_name'] !== 'string' ||
      !['critical', 'high', 'medium', 'low'].includes(String(asset['criticality_class']))
    )
      reject('INVALID_PARAMS', 'Valid asset details are required for retain-as-asset');
  }
  if (
    p['disposition_type'] === 'transfer-to-production' &&
    (typeof p['production_reference'] !== 'string' || !p['production_reference'].trim())
  )
    reject('INVALID_PARAMS', 'production_reference is required for transfer-to-production');
  await insertRdDisposition(
    {
      disposition_id: dispositionId,
      prototype_id: prototypeId,
      project_code: prototype.project_code,
      disposition_type: p['disposition_type'] as
        'retain-as-asset' | 'transfer-to-production' | 'teardown' | 'scrap',
      status: 'approval_required',
      requester_actor_id: envelope.metadata.actor.user_id,
      approver_actor_id: head.approverActorId,
      doa_entry_id: head.doaEntryId,
      approved_at: null,
      approved_by: null,
      rejected_at: null,
      rejected_by: null,
      rejection_reason: null,
      executed_at: null,
      executed_by: null,
      asset_id: null,
      production_reference: null,
      source_event_id: eventId,
    },
    client,
  );
  for (const line of rows)
    await insertRdDispositionLine(
      {
        line_id: line['line_id'] as string,
        disposition_id: dispositionId,
        line_no: line['line_no'] as number,
        component_sku: line['component_sku'] as string,
        quantity: String(line['quantity']),
        condition_code: line['condition_code'] as string,
        source_event_id: eventId,
      },
      client,
    );
  const lines = rows.map((line) => ({
    ...line,
    disposition_id: dispositionId,
    source_event_id: eventId,
  }));
  (envelope.payload as Record<string, unknown>)['project_code'] = prototype.project_code;
  (envelope.payload as Record<string, unknown>)['requester_actor_id'] =
    envelope.metadata.actor.user_id;
  (envelope.payload as Record<string, unknown>)['approver_actor_id'] = head.approverActorId;
  (envelope.payload as Record<string, unknown>)['doa_entry_id'] = head.doaEntryId;
  (envelope.payload as Record<string, unknown>)['lines'] = lines;
}

async function applyDecision(envelope: EventEnvelope, client: PoolClient): Promise<void> {
  if (await alreadyPersisted(envelope, client)) return;
  const p = envelope.payload as Record<string, unknown>;
  const id = p['disposition_id'] as string;
  const d = await getRdDispositionById(id, client, true);
  if (!d) reject('RD_DISPOSITION_NOT_FOUND', 'Disposition not found', { disposition_id: id }, 404);
  if (d.status !== 'approval_required')
    reject(
      'RD_DISPOSITION_ALREADY_DECIDED',
      'Disposition has already been decided',
      { disposition_id: id, status: d.status },
      409,
    );
  if (
    envelope.metadata.actor.user_id === d.requester_actor_id ||
    envelope.metadata.actor.user_id !== d.approver_actor_id
  )
    reject(
      'APPROVAL_UNRESOLVED',
      'Only the resolved R&D head may decide, and requester self-approval is forbidden',
      { disposition_id: id },
      403,
    );
  const approved = envelope.event_type === 'rd_disposition.approved';
  await decideRdDisposition(
    id,
    approved ? 'approved' : 'rejected',
    envelope.metadata.actor.user_id,
    (p['rejection_reason'] as string | null) ?? null,
    envelope.metadata.occurred_at,
    client,
  );
}

async function applyExecuted(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
): Promise<void> {
  if (await alreadyPersisted(envelope, client)) return;
  const p = envelope.payload as Record<string, unknown>;
  const id = p['disposition_id'] as string;
  const d = await getRdDispositionById(id, client, true);
  if (!d) reject('RD_DISPOSITION_NOT_FOUND', 'Disposition not found', { disposition_id: id }, 404);
  if (d.status !== 'approved')
    reject(
      'RD_DISPOSITION_NOT_APPROVED',
      'Disposition must be approved before execution',
      { disposition_id: id, status: d.status },
      409,
    );
  const prototype = await getRdPrototypeById(d.prototype_id, client, true);
  if (!prototype || prototype.status !== 'registered')
    reject(
      'RD_PROTOTYPE_ALREADY_DISPOSED',
      'Prototype has already been disposed',
      { prototype_id: d.prototype_id },
      409,
    );
  let assetId: string | null = null;
  let productionReference: string | null = null;
  if (d.disposition_type === 'retain-as-asset') {
    const request = (envelope.payload as Record<string, unknown>)['asset'] as
      Record<string, unknown> | undefined;
    if (!request) reject('INVALID_PARAMS', 'Asset fields are required for retain-as-asset');
    assetId = request['asset_id'] as string;
    await insertAsset(
      {
        asset_id: assetId,
        asset_tag: request['asset_tag'] as string,
        asset_name: request['asset_name'] as string,
        criticality_class: request['criticality_class'] as AssetRow['criticality_class'],
        serial_number: prototype.serial_number,
        manufacturer: (request['manufacturer'] as string | null) ?? null,
        model: (request['model'] as string | null) ?? null,
        fixed_asset_ref: (request['fixed_asset_ref'] as string | null) ?? null,
        created_by: envelope.metadata.actor.user_id,
        created_at: envelope.metadata.occurred_at,
        updated_at: envelope.metadata.occurred_at,
      },
      client,
    );
  }
  if (d.disposition_type === 'transfer-to-production') {
    productionReference = (envelope.payload as Record<string, unknown>)['production_reference'] as
      string | null;
    if (!productionReference)
      reject('INVALID_PARAMS', 'production_reference is required for transfer-to-production');
  }
  if (d.disposition_type === 'teardown' || d.disposition_type === 'scrap') {
    const lines = await listRdDispositionLines(id, client);
    for (const line of lines)
      await insertRdScrapPending(
        {
          scrap_pending_id: randomUUID(),
          disposition_id: id,
          disposition_line_id: line.line_id,
          prototype_id: d.prototype_id,
          project_code: d.project_code,
          sku: line.component_sku,
          quantity: line.quantity,
          condition_code: line.condition_code,
          source_prototype_ref: prototype.prototype_id,
          status: 'pending',
          source_event_id: eventId,
        },
        client,
      );
  }
  await executeRdDisposition(
    id,
    envelope.metadata.actor.user_id,
    assetId,
    productionReference,
    envelope.metadata.occurred_at,
    client,
  );
  await setRdPrototypeDisposed(prototype.prototype_id, client);
  (envelope.payload as Record<string, unknown>)['asset_id'] = assetId;
  (envelope.payload as Record<string, unknown>)['production_reference'] = productionReference;
}

export async function applyRdDispositionProjection(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
): Promise<void> {
  if (await alreadyPersisted(envelope, client)) return;
  switch (rdDispositionEventType(envelope)) {
    case 'rd_disposition.requested':
      await applyRequested(envelope, client, eventId);
      break;
    case 'rd_disposition.approved':
    case 'rd_disposition.rejected':
      await applyDecision(envelope, client);
      break;
    case 'rd_disposition.executed':
      await applyExecuted(envelope, client, eventId);
      break;
  }
}
