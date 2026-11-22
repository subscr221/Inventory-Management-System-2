import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request as httpRequest, type Server, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAppRouter, createAppServer } from '../../src/server.js';
import { closePool, closeAdminPool, getAdminPool, getPool } from '../../src/config/db.js';

/**
 * Story 8.10 Receipt-Lot QC Task, QC-Governed Putaway Release, Observation Note and Photo.
 * Real PostgreSQL, the real production router, SCIM provisioning and dev-token auth. A receipt is
 * driven through POST /api/v1/grn-lines into ZONE-QC-HOLD so the receiving seam opens (or refuses to
 * open) the inspection task for real; the receipt-created task is then inspected and dispositioned
 * through the ordinary QC routes.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCIM_HEADERS = { Authorization: 'Bearer test-only-scim-bearer-token-not-for-production-use' };
const run = randomUUID().slice(0, 8);
const DEVICE_ID = `edge-8-10-${run}`;
const SITE_CODE = `SITE-810-${run}`;
const DOCK_CODE = `DOCK-810-${run}`;

interface HttpResult {
  status: number;
  body: Record<string, unknown>;
}
interface Role {
  role: string;
  module: string;
  functionScope: 'read' | 'write';
  locationId: string;
}

function makeRequest(
  port: number,
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<HttpResult> {
  return new Promise((resolvePromise, reject) => {
    const isRaw = Buffer.isBuffer(body);
    const data = isRaw ? (body as Buffer) : body !== undefined ? JSON.stringify(body) : undefined;
    const req = httpRequest(
      {
        hostname: 'localhost',
        port,
        path,
        method,
        headers: {
          ...(isRaw ? {} : { 'Content-Type': 'application/json' }),
          ...(data !== undefined ? { 'Content-Length': Buffer.byteLength(data) } : {}),
          ...headers,
        },
      },
      (res: IncomingMessage) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('error', reject);
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf-8');
          let parsed: Record<string, unknown> = {};
          if (raw) {
            try {
              parsed = JSON.parse(raw) as Record<string, unknown>;
            } catch {
              parsed = { error_code: 'NON_JSON_BODY', raw };
            }
          }
          resolvePromise({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(60000, () => req.destroy(new Error(`Request timed out: ${method} ${path}`)));
    if (data !== undefined) req.write(data);
    req.end();
  });
}

async function provisionUser(port: number, externalId: string, roles: Role[]): Promise<string> {
  const res = await makeRequest(
    port,
    'POST',
    '/api/v1/scim/v2/Users',
    { externalId, email: externalId, displayName: externalId, roles },
    SCIM_HEADERS,
  );
  assert.strictEqual(res.status, 201, `provision ${externalId}: ${JSON.stringify(res.body)}`);
  return (res.body as Record<string, string>)['userId']!;
}

async function authFor(port: number, sub: string): Promise<Record<string, string>> {
  const res = await makeRequest(port, 'POST', '/api/v1/auth/dev-token', { sub });
  assert.ok(res.status >= 200 && res.status < 300, `dev-token ${sub}`);
  return { Authorization: `Bearer ${res.body['token'] as string}` };
}

const JPEG_BYTES = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9,
]);

describe('Story 8.10 receipt-lot QC task, governed putaway release and observation notes', () => {
  let server: Server;
  let port: number;
  let siteId: string;
  let qcHoldZoneId: string;
  let dockId: string;
  let inspectorUserId: string;
  let inspectorHeaders: Record<string, string>;
  let qcHeadHeaders: Record<string, string>;
  let storeHeaders: Record<string, string>;

  interface Plan {
    itemId: string;
    sku: string;
    revisionId: string;
    versionId: string;
    characteristicId: string;
  }
  interface Receipt {
    grnId: string;
    grnLineId: string;
    lotNumber: string | null;
    sku: string;
    taskId: string | null;
    putawayTaskId: string;
    putawayStatus: string;
  }

  async function seedLocation(
    id: string,
    code: string,
    level: string,
    parent: string | null,
    quarantine: boolean,
    zoneType: string,
  ): Promise<void> {
    await getPool().query(
      `INSERT INTO location_register
         (location_id, location_code, level, parent_location_id, site_id, zone_type, temperature_class, quarantine, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'ambient', $7, 'active')`,
      [id, code, level, parent, siteId, zoneType, quarantine],
    );
  }

  async function createItem(
    sku: string,
    opts: { quarantineRequired: boolean; lotControlled?: boolean } = {
      quarantineRequired: true,
    },
  ): Promise<string> {
    const id = randomUUID();
    await getPool().query(
      `INSERT INTO item_master
         (item_id, sku, uom, lot_controlled, serial_controlled, quarantine_required, valuation_method, business_stream, status)
       VALUES ($1, $2, 'EA', $3, false, $4, 'weighted_average', 'production', 'active')`,
      [id, sku, opts.lotControlled ?? true, opts.quarantineRequired],
    );
    return id;
  }

  /** A current released BOM revision plus an approved, effective inspection plan version. */
  async function seedPlan(itemId: string, sku: string): Promise<Plan> {
    const bomId = randomUUID();
    const revisionId = randomUUID();
    const planId = randomUUID();
    const versionId = randomUUID();
    const characteristicId = randomUUID();
    const approvalUserId = randomUUID();
    const doaEntryId = randomUUID();
    const empty = randomUUID();
    await getPool().query(
      `INSERT INTO bom
         (bom_id, parent_item_id, parent_sku, parent_uom, business_stream, bom_type, status,
          current_revision_id, blocking_line_count, created_by, source_event_id)
       VALUES ($1, $2, $3, 'EA', 'production', 'production', 'released', $4, 0, $5, $6)`,
      [bomId, itemId, sku, revisionId, empty, empty],
    );
    await getPool().query(
      `INSERT INTO bom_revision
         (revision_id, bom_id, revision_code, revision_status, drafted_by, released_at, released_by, source_event_id)
       VALUES ($1, $2, 'A', 'released', $3, now(), $3, $4)`,
      [revisionId, bomId, empty, empty],
    );
    await getPool().query(
      `INSERT INTO inspection_plan
         (plan_id, scope, item_id, sku, bom_revision_id, created_by, source_event_id)
       VALUES ($1, 'standard', $2, $3, $4, $5, $6)`,
      [planId, itemId, sku, revisionId, empty, empty],
    );
    await getPool().query(
      `INSERT INTO inspection_plan_version
         (plan_version_id, plan_id, version_no, effective_from, aql, inspection_level, created_by, source_event_id)
       VALUES ($1, $2, 1, '2020-01-01', 1.000, 'II', $3, $4)`,
      [versionId, planId, empty, empty],
    );
    await getPool().query(
      `INSERT INTO inspection_plan_characteristic
         (characteristic_id, plan_version_id, line_no, characteristic_name, characteristic_class,
          test_method_ref, instrument_type, result_kind, lower_limit, upper_limit, limit_uom,
          acceptance_criteria, sample_handling)
       VALUES ($1, $2, 1, 'Surface finish', 'minor', 'SOP-QC-014', NULL, 'attribute', NULL, NULL,
               NULL, 'No visible scratches under 500 lux', 'Visual')`,
      [characteristicId, versionId],
    );
    await getPool().query(
      `INSERT INTO inspection_plan_approval
         (plan_version_id, plan_id, approved_by, resolved_approver_user_id, doa_entry_id,
          governing_role, approved_at, source_event_id)
       VALUES ($1, $2, $3, $3, $4, 'qc_head', now(), $5)`,
      [versionId, planId, approvalUserId, doaEntryId, empty],
    );
    return { itemId, sku, revisionId, versionId, characteristicId };
  }

  /** A BOM whose current revision has the requested status, with no inspection plan rows. */
  async function seedBomWithRevision(
    itemId: string,
    sku: string,
    revisionStatus: 'draft' | 'released',
  ): Promise<{ bomId: string; revisionId: string }> {
    const bomId = randomUUID();
    const revisionId = randomUUID();
    const empty = randomUUID();
    await getPool().query(
      `INSERT INTO bom
         (bom_id, parent_item_id, parent_sku, parent_uom, business_stream, bom_type, status,
          current_revision_id, blocking_line_count, created_by, source_event_id)
       VALUES ($1, $2, $3, 'EA', 'production', 'production', 'released', $4, 0, $5, $6)`,
      [bomId, itemId, sku, revisionId, empty, empty],
    );
    await getPool().query(
      `INSERT INTO bom_revision
         (revision_id, bom_id, revision_code, revision_status, drafted_by, released_at, released_by, source_event_id)
       VALUES ($1, $2, 'A', $3, $4, CASE WHEN $3 = 'released' THEN now() ELSE NULL END, $4, $5)`,
      [revisionId, bomId, revisionStatus, empty, empty],
    );
    return { bomId, revisionId };
  }

  /** A released revision with a plan version that has never been approved. */
  async function seedUnapprovedPlan(itemId: string, sku: string): Promise<{ revisionId: string }> {
    const { revisionId } = await seedBomWithRevision(itemId, sku, 'released');
    const planId = randomUUID();
    const versionId = randomUUID();
    const empty = randomUUID();
    await getPool().query(
      `INSERT INTO inspection_plan
         (plan_id, scope, item_id, sku, bom_revision_id, created_by, source_event_id)
       VALUES ($1, 'standard', $2, $3, $4, $5, $6)`,
      [planId, itemId, sku, revisionId, empty, empty],
    );
    await getPool().query(
      `INSERT INTO inspection_plan_version
         (plan_version_id, plan_id, version_no, effective_from, aql, inspection_level, created_by, source_event_id)
       VALUES ($1, $2, 1, '2020-01-01', 1.000, 'II', $3, $4)`,
      [versionId, planId, empty, empty],
    );
    return { revisionId };
  }

  async function holdNextStep(grnLineId: string): Promise<string | null> {
    const r = await getPool().query(
      `SELECT payload->>'next_step' AS next_step FROM domain_events
        WHERE event_type = 'notification.created' AND payload->>'event_type' = 'qc_hold_placed'
          AND payload->>'object_id' = $1
        ORDER BY created_at DESC LIMIT 1`,
      [grnLineId],
    );
    return (r.rows[0]?.['next_step'] as string | undefined) ?? null;
  }

  async function receiptResponse(
    sku: string,
    quantity: string,
    lotNumber: string | null,
    opts: {
      condition?: string;
      reasonCode?: string;
      reasonDetail?: string;
      reasonNote?: string;
    } = {},
  ): Promise<{ res: HttpResult; grnId: string; grnLineId: string }> {
    const poRef = `P810-${run}-${randomUUID().slice(0, 6)}`;
    await getPool().query(
      `INSERT INTO erp_purchase_order
         (po_number_ext, supplier_ref_ext, currency, expected_delivery_date, status, source_system, last_synced_at)
       VALUES ($1, 'SUP-810', 'INR', '2030-01-01', 'open', 'ERP', now())`,
      [poRef],
    );
    await getPool().query(
      `INSERT INTO erp_purchase_order_line
         (po_number_ext, line_no, sku, ordered_qty, open_qty, unit_price, over_receipt_tolerance_pct,
          under_receipt_tolerance_pct, source_system, last_synced_at)
       VALUES ($1, 1, $2, $3::numeric, $3::numeric, 1, 5, 100, 'ERP', now())`,
      [poRef, sku, quantity],
    );
    const token = randomUUID();
    await getPool().query(
      `INSERT INTO weighbridge_event
         (weighbridge_event_id, correlation_id, gate_event_id, site_id, site_code_ext, po_ref_ext, line_no,
          tare_kg, gross_kg, net_kg, status, device_id, capture_method, weighed_by, business_date, source_event_id)
       VALUES ($1, $2, $3, $4, $5, $6, 1, 1000, 1000 + $7::numeric, $7::numeric, 'accepted', 'WB-1',
               'MANUAL', $8, '2026-07-23', $9)`,
      [
        randomUUID(),
        token,
        randomUUID(),
        siteId,
        SITE_CODE,
        poRef,
        quantity,
        inspectorUserId,
        randomUUID(),
      ],
    );
    const grnId = randomUUID();
    const grnLineId = randomUUID();
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/grn-lines',
      {
        grn_id: grnId,
        grn_line_id: grnLineId,
        correlation_id: token,
        po_ref_ext: poRef,
        line_no: 1,
        source_document: 'PO',
        sku,
        target_location_code: DOCK_CODE,
        received_qty: Number(quantity),
        line_condition: opts.condition ?? 'GOOD',
        ...(lotNumber ? { lot_id: lotNumber, expiry_date: '2030-01-01' } : {}),
        ...(opts.reasonCode
          ? {
              reason_code: opts.reasonCode,
              ...(opts.reasonDetail ? { reason_detail: opts.reasonDetail } : {}),
              ...(opts.reasonCode === 'OTHER'
                ? { reason_note: opts.reasonNote ?? 'Story 8.10 OTHER' }
                : {}),
            }
          : {}),
      },
      storeHeaders,
    );
    return { res, grnId, grnLineId };
  }

  async function receive(
    sku: string,
    quantity: string,
    lotNumber: string | null,
    opts: {
      condition?: string;
      reasonCode?: string;
      reasonDetail?: string;
      reasonNote?: string;
    } = {},
  ): Promise<Receipt> {
    const { res, grnId, grnLineId } = await receiptResponse(sku, quantity, lotNumber, opts);
    assert.strictEqual(res.status, 201, `receipt ${sku}/${lotNumber}: ${JSON.stringify(res.body)}`);
    const putaway = res.body['putaway_task'] as Record<string, unknown>;
    const row = await getPool().query(
      `SELECT task_id FROM qc_inspection_task WHERE source_completion_id = $1`,
      [grnLineId],
    );
    return {
      grnId,
      grnLineId,
      lotNumber,
      sku,
      taskId: (row.rows[0]?.['task_id'] as string | undefined) ?? null,
      putawayTaskId: putaway['putaway_task_id'] as string,
      putawayStatus: putaway['status'] as string,
    };
  }

  async function inspect(receipt: Receipt, plan: Plan): Promise<void> {
    assert.ok(receipt.taskId, 'receipt has no inspection task');
    const sampling = await makeRequest(
      port,
      'POST',
      `/api/v1/qc/tasks/${receipt.taskId}/sampling`,
      {},
      inspectorHeaders,
    );
    assert.strictEqual(sampling.status, 201, JSON.stringify(sampling.body));
    const sampleSize = (sampling.body['sampling'] as Record<string, unknown>)[
      'sample_size'
    ] as number;
    const readings = Array.from({ length: sampleSize }, (_, index) => ({
      sample_unit_no: index + 1,
      attribute_conforms: true,
    }));
    const observations = await makeRequest(
      port,
      'POST',
      `/api/v1/qc/tasks/${receipt.taskId}/observations`,
      { characteristic_id: plan.characteristicId, readings },
      inspectorHeaders,
    );
    assert.strictEqual(observations.status, 201, JSON.stringify(observations.body));
    const completion = await makeRequest(
      port,
      'POST',
      `/api/v1/qc/tasks/${receipt.taskId}/inspection-completion`,
      {},
      inspectorHeaders,
    );
    assert.strictEqual(completion.status, 201, JSON.stringify(completion.body));
  }

  function disposition(
    taskId: string,
    kind: 'accept' | 'reject',
    headers: Record<string, string>,
  ): Promise<HttpResult> {
    return makeRequest(
      port,
      'POST',
      `/api/v1/qc/tasks/${taskId}/disposition`,
      { disposition: kind, justification: `Story 8.10 ${kind}` },
      headers,
    );
  }

  async function putaway(putawayTaskId: string): Promise<Record<string, unknown>> {
    const r = await getPool().query(`SELECT * FROM putaway_task WHERE putaway_task_id = $1`, [
      putawayTaskId,
    ]);
    return r.rows[0] as Record<string, unknown>;
  }

  async function uploadPhoto(headers: Record<string, string>): Promise<string> {
    const attachmentId = randomUUID();
    const res = await makeRequest(port, 'PUT', `/api/v1/attachments/${attachmentId}`, JPEG_BYTES, {
      ...headers,
      'Content-Type': 'image/jpeg',
    });
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    return attachmentId;
  }

  before(async () => {
    const adminPool = getAdminPool();
    for (const file of [
      '../../events/domain_events.sql',
      '../../read/projections/users.sql',
      '../../read/projections/audit_log.sql',
      '../../read/projections/doa_registry.sql',
      '../../read/projections/business_stream_config.sql',
      '../../read/projections/notification.sql',
      '../../read/projections/item_master.sql',
      '../../read/projections/location_register.sql',
      '../../read/projections/stock_balance.sql',
      '../../read/projections/lot_master.sql',
      '../../read/projections/lot_trace.sql',
      '../../read/projections/serial_master.sql',
      '../../read/projections/inventory_valuation.sql',
      '../../read/projections/bom.sql',
      '../../read/projections/bom_revision.sql',
      '../../read/projections/bom_line.sql',
      '../../read/projections/bom_structure.sql',
      '../../read/projections/bom_alternate.sql',
      '../../read/projections/bom_explosion.sql',
      '../../read/projections/bom_explosion_line.sql',
      '../../read/projections/bom_cost_rollup.sql',
      '../../read/projections/bom_cost_rollup_line.sql',
      '../../read/projections/bom_outbound_message.sql',
      '../../read/projections/supplier.sql',
      '../../read/projections/supplier_scorecard_metric.sql',
      '../../read/projections/grn.sql',
      '../../read/projections/grn_line.sql',
      '../../read/projections/grn_line_condition.sql',
      '../../read/projections/gate_event.sql',
      '../../read/projections/weighbridge_event.sql',
      '../../read/projections/erp_purchase_order.sql',
      '../../read/projections/purchase_order.sql',
      '../../read/projections/purchase_order_line.sql',
      '../../read/projections/putaway_task.sql',
      '../../read/projections/putaway_task_qc_release.sql',
      '../../read/projections/inspection_plan.sql',
      '../../read/projections/inspection_plan_version.sql',
      '../../read/projections/inspection_plan_characteristic.sql',
      '../../read/projections/inspection_plan_approval.sql',
      '../../read/projections/qc_inspection_task.sql',
      '../../read/projections/qc_deviation.sql',
      '../../read/projections/qc_lot_disposition.sql',
      '../../read/projections/qc_lot_split.sql',
      '../../read/projections/qc_sampling_plan.sql',
      '../../read/projections/qc_inspection_result.sql',
      '../../read/projections/qc_sampling_switching_state.sql',
      '../../read/projections/qc_ncr.sql',
      '../../read/projections/qc_observation_note.sql',
      '../../read/projections/damage_report.sql',
      '../../read/projections/attachment.sql',
      '../../read/projections/indent.sql',
      '../../read/projections/indent_line.sql',
      '../../read/projections/indent_info_request.sql',
      '../../read/projections/indent_damage_link.sql',
    ]) {
      await adminPool.query(readFileSync(resolve(__dirname, file), 'utf-8'));
    }
    await adminPool.query('ALTER TABLE audit_log DISABLE TRIGGER ALL');
    await adminPool.query('ALTER TABLE audit_log_tamper_attempt_log DISABLE TRIGGER ALL');
    await adminPool.query('ALTER TABLE audit_log_archive DISABLE TRIGGER ALL');
    try {
      await adminPool.query(
        'TRUNCATE qc_observation_note, qc_ncr, qc_lot_split, qc_sampling_switching_state, qc_inspection_result, qc_sampling_plan, qc_lot_disposition, qc_deviation, qc_inspection_task, inspection_plan_approval, inspection_plan_characteristic, inspection_plan_version, inspection_plan, damage_report_action, damage_report, attachment, putaway_task, grn_line, grn, weighbridge_event, gate_event, erp_purchase_order_line, erp_purchase_order, purchase_order_line, purchase_order, supplier_scorecard_metric, supplier, bom_alternate, bom_explosion, bom_explosion_line, bom_cost_rollup_line, bom_cost_rollup, bom_outbound_message, bom_structure, bom_line, bom_revision, bom, inventory_valuation, lot_trace, serial_master, lot_master, stock_balance, item_master, location_register, indent_line, indent, notification_escalations, notification_escalation_defs, notification_deliveries, notification_dispatch_attempts, notification_dispatch_log, notifications, doa_vacation_delegations, doa_registry_entries, audit_log_tamper_attempt_log, audit_log_archive, audit_log, user_role_assignments, users, domain_events CASCADE',
      );
    } finally {
      await adminPool.query('ALTER TABLE audit_log ENABLE TRIGGER ALL');
      await adminPool.query('ALTER TABLE audit_log_tamper_attempt_log ENABLE TRIGGER ALL');
      await adminPool.query('ALTER TABLE audit_log_archive ENABLE TRIGGER ALL');
    }

    siteId = randomUUID();
    qcHoldZoneId = randomUUID();
    dockId = randomUUID();
    await seedLocation(siteId, SITE_CODE, 'site', null, false, 'general');
    await seedLocation(qcHoldZoneId, 'ZONE-QC-HOLD', 'zone', siteId, true, 'quarantine');
    await seedLocation(dockId, DOCK_CODE, 'zone', siteId, false, 'staging');

    server = createAppServer(createAppRouter());
    await new Promise<void>((resolvePromise, reject) => {
      server.once('error', reject);
      server.listen(0, () => {
        server.off('error', reject);
        port = (server.address() as AddressInfo).port;
        resolvePromise();
      });
    });

    inspectorUserId = await provisionUser(port, `qc-810-${run}@example.com`, [
      { role: 'quality_inspector', module: 'qc', functionScope: 'write', locationId: siteId },
      { role: 'quality_inspector', module: 'qc', functionScope: 'read', locationId: siteId },
      { role: 'employee', module: 'employee', functionScope: 'write', locationId: siteId },
    ]);
    inspectorHeaders = await authFor(port, `qc-810-${run}@example.com`);
    await provisionUser(port, `qchead-810-${run}@example.com`, [
      { role: 'qc_head', module: 'qc', functionScope: 'write', locationId: '*' },
      { role: 'qc_head', module: 'qc', functionScope: 'read', locationId: '*' },
      { role: 'employee', module: 'employee', functionScope: 'write', locationId: siteId },
    ]);
    qcHeadHeaders = await authFor(port, `qchead-810-${run}@example.com`);
    await provisionUser(port, `store-810-${run}@example.com`, [
      { role: 'store_assistant', module: 'receiving', functionScope: 'write', locationId: siteId },
      { role: 'store_assistant', module: 'warehouse', functionScope: 'write', locationId: siteId },
      { role: 'store_assistant', module: 'inventory', functionScope: 'write', locationId: siteId },
    ]);
    storeHeaders = await authFor(port, `store-810-${run}@example.com`);
  });

  after(async () => {
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    await closePool();
    await closeAdminPool();
  });

  // -------------------------------------------------------------------------
  // AC 1
  // -------------------------------------------------------------------------

  it('AC1: an approved plan lets the receipt open a real inspection task and the task stays held', async () => {
    const plan = await seedPlan(await createItem(`FG-810-A-${run}`), `FG-810-A-${run}`);
    const receipt = await receive(plan.sku, '10', `LOT-810-A-${run}`);
    assert.strictEqual(receipt.putawayStatus, 'held');
    assert.ok(receipt.taskId, 'no task was opened for the receipt lot');
    const task = await getPool().query(
      `SELECT source_completion_type, source_completion_id, gate_status, task_status, plan_version_id, lot_number, quantity::text AS quantity
         FROM qc_inspection_task WHERE task_id = $1`,
      [receipt.taskId],
    );
    const row = task.rows[0]!;
    assert.strictEqual(row['source_completion_type'], 'goods_receipt');
    assert.strictEqual(row['source_completion_id'], receipt.grnLineId);
    assert.strictEqual(row['gate_status'], 'qc_hold');
    assert.strictEqual(row['plan_version_id'], plan.versionId);
    assert.strictEqual(row['quantity'], '10.000000');

    const taskAgain = await receive(plan.sku, '3', `LOT-810-A2-${run}`);
    assert.strictEqual(taskAgain.putawayStatus, 'held');
    assert.ok(taskAgain.taskId, 'the second lot should still open a task');

    const held = await putaway(receipt.putawayTaskId);
    assert.strictEqual(held['status'], 'held');
    assert.strictEqual(held['hold_reason'], null);
    const stock = await getPool().query(
      `SELECT location_id FROM stock_balance WHERE sku = $1 AND lot_id = $2`,
      [plan.sku, receipt.lotNumber],
    );
    assert.strictEqual(stock.rows[0]!['location_id'], qcHoldZoneId);
  });

  it('AC1: a receipt with no resolvable plan posts, stays held, and names no_inspection_plan', async () => {
    const sku = `FG-810-NOPLAN-${run}`;
    await createItem(sku);
    const receipt = await receive(sku, '5', `LOT-810-NP-${run}`);
    assert.strictEqual(receipt.putawayStatus, 'held');
    assert.strictEqual(receipt.taskId, null);
    const held = await putaway(receipt.putawayTaskId);
    assert.strictEqual(held['status'], 'held');
    assert.strictEqual(held['hold_reason'], 'no_inspection_plan');
    assert.ok(
      String(await holdNextStep(receipt.grnLineId)).includes('no inspection plan'),
      'the qc_hold_placed notification must name the hold reason in human wording',
    );
  });

  it('AC1: a receipt item whose current revision is still a draft records revision_not_released', async () => {
    const sku = `FG-810-DRAFT-${run}`;
    await seedBomWithRevision(await createItem(sku), sku, 'draft');
    const receipt = await receive(sku, '4', `LOT-810-DRAFT-${run}`);
    assert.strictEqual(receipt.taskId, null);
    assert.strictEqual((await putaway(receipt.putawayTaskId))['hold_reason'], 'no_inspection_plan');
    const step = await holdNextStep(receipt.grnLineId);
    assert.ok(step !== null && step.includes('revision_not_released'), step ?? '');
  });

  it('AC1: a released revision with no inspection plan records inspection_plan_not_found', async () => {
    const sku = `FG-810-NOFOUND-${run}`;
    await seedBomWithRevision(await createItem(sku), sku, 'released');
    const receipt = await receive(sku, '4', `LOT-810-NOFOUND-${run}`);
    assert.strictEqual(receipt.taskId, null);
    assert.strictEqual((await putaway(receipt.putawayTaskId))['hold_reason'], 'no_inspection_plan');
    const step = await holdNextStep(receipt.grnLineId);
    assert.ok(step !== null && step.includes('inspection_plan_not_found'), step ?? '');
  });

  it('AC1: an unapproved plan version records inspection_plan_not_approved', async () => {
    const sku = `FG-810-NAP-${run}`;
    await seedUnapprovedPlan(await createItem(sku), sku);
    const receipt = await receive(sku, '4', `LOT-810-NAP-${run}`);
    assert.strictEqual(receipt.taskId, null);
    assert.strictEqual((await putaway(receipt.putawayTaskId))['hold_reason'], 'no_inspection_plan');
    const step = await holdNextStep(receipt.grnLineId);
    assert.ok(step !== null && step.includes('inspection_plan_not_approved'), step ?? '');
  });

  // -------------------------------------------------------------------------
  // AC 5
  // -------------------------------------------------------------------------

  it('AC5: the task view carries the receipt evidence, putaway row and held locations', async () => {
    const plan = await seedPlan(await createItem(`FG-810-V-${run}`), `FG-810-V-${run}`);
    const receipt = await receive(plan.sku, '7', `LOT-810-V-${run}`);
    assert.ok(receipt.taskId);
    const res = await makeRequest(
      port,
      'GET',
      `/api/v1/qc/tasks/${receipt.taskId}`,
      undefined,
      inspectorHeaders,
    );
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    const receiptView = res.body['receipt'] as Record<string, unknown>;
    assert.ok(receiptView, 'detail carries no receipt block');
    assert.strictEqual(receiptView['grn_id'], receipt.grnId);
    assert.strictEqual(Number(receiptView['received_quantity']), 7);
    const putawayView = res.body['putaway'] as Record<string, unknown>;
    assert.strictEqual(putawayView['putaway_task_id'], receipt.putawayTaskId);
    assert.strictEqual(putawayView['status'], 'held');
    const locations = res.body['hold_locations'] as Array<Record<string, unknown>>;
    assert.strictEqual(locations.length, 1);
    assert.strictEqual(locations[0]!['location_id'], qcHoldZoneId);
    assert.strictEqual(Number(locations[0]!['quantity']), 7);
  });

  // -------------------------------------------------------------------------
  // AC 3
  // -------------------------------------------------------------------------

  it('AC3: observation notes persist, come back with the results, and stay append-only', async () => {
    const plan = await seedPlan(await createItem(`FG-810-N-${run}`), `FG-810-N-${run}`);
    const receipt = await receive(plan.sku, '4', `LOT-810-N-${run}`);
    assert.ok(receipt.taskId);
    const photoId = await uploadPhoto(inspectorHeaders);
    const note = `Rehearsal observation ${run} at the QC bench`;
    const created = await makeRequest(
      port,
      'POST',
      `/api/v1/qc/tasks/${receipt.taskId}/notes`,
      { note, attachment_id: photoId, idempotency_key: randomUUID() },
      inspectorHeaders,
    );
    assert.strictEqual(created.status, 201, JSON.stringify(created.body));
    const notes = created.body['notes'] as Array<Record<string, unknown>>;
    assert.strictEqual(notes.length, 1);
    assert.strictEqual(notes[0]!['note'], note);
    assert.strictEqual(notes[0]!['attachment_id'], photoId);
    assert.strictEqual(notes[0]!['recorded_by'], inspectorUserId);

    const read = await makeRequest(
      port,
      'GET',
      `/api/v1/qc/tasks/${receipt.taskId}/results`,
      undefined,
      inspectorHeaders,
    );
    assert.strictEqual(read.status, 200, JSON.stringify(read.body));
    const readNotes = read.body['notes'] as Array<Record<string, unknown>>;
    assert.strictEqual(readNotes[0]!['note_id'], notes[0]!['note_id']);

    // app_user holds INSERT and SELECT only, so a raw correction is refused by the database.
    await assert.rejects(
      getPool().query(`UPDATE qc_observation_note SET note = 'tampered' WHERE note_id = $1`, [
        notes[0]!['note_id'],
      ]),
      /permission denied|42501/i,
    );

    // Another user's claimed photo is refused.
    const foreignPhoto = await uploadPhoto(qcHeadHeaders);
    const foreign = await makeRequest(
      port,
      'POST',
      `/api/v1/qc/tasks/${receipt.taskId}/notes`,
      { note: 'foreign photo', attachment_id: foreignPhoto },
      inspectorHeaders,
    );
    assert.strictEqual(foreign.status, 403, JSON.stringify(foreign.body));
    assert.strictEqual(foreign.body['error_code'], 'QC_NOTE_ATTACHMENT_NOT_OWNED');

    // Unknown task is a 404.
    const missing = await makeRequest(
      port,
      'POST',
      `/api/v1/qc/tasks/${randomUUID()}/notes`,
      { note: 'no task' },
      inspectorHeaders,
    );
    assert.strictEqual(missing.status, 404, JSON.stringify(missing.body));
    assert.strictEqual(missing.body['error_code'], 'QC_TASK_NOT_FOUND');
  });

  // -------------------------------------------------------------------------
  // AC 4
  // -------------------------------------------------------------------------

  it('AC4: an inspector cannot accept, reject or split; the QC head can', async () => {
    const plan = await seedPlan(await createItem(`FG-810-G-${run}`), `FG-810-G-${run}`);
    const receipt = await receive(plan.sku, '10', `LOT-810-G-${run}`);
    assert.ok(receipt.taskId);
    await inspect(receipt, plan);

    for (const kind of ['accept', 'reject'] as const) {
      const res = await disposition(receipt.taskId!, kind, inspectorHeaders);
      assert.strictEqual(res.status, 403, `${kind}: ${JSON.stringify(res.body)}`);
      assert.strictEqual(res.body['error_code'], 'APPROVAL_REQUIRED');
      const details = res.body['details'] as Record<string, unknown>;
      assert.ok(Array.isArray(details['qc_head_roles']));
      assert.deepStrictEqual(details['task_id'], receipt.taskId);
    }

    const splitBody = {
      justification: 'Story 8.10 authority proof',
      splits: [
        { sequence: 1, quantity: '4' },
        { sequence: 2, quantity: '6' },
      ],
    };
    const inspectorSplit = await makeRequest(
      port,
      'POST',
      `/api/v1/qc/tasks/${receipt.taskId}/split`,
      splitBody,
      inspectorHeaders,
    );
    assert.strictEqual(inspectorSplit.status, 403, JSON.stringify(inspectorSplit.body));
    assert.strictEqual(inspectorSplit.body['error_code'], 'APPROVAL_REQUIRED');
    const headSplit = await makeRequest(
      port,
      'POST',
      `/api/v1/qc/tasks/${receipt.taskId}/split`,
      splitBody,
      qcHeadHeaders,
    );
    assert.strictEqual(headSplit.status, 201, JSON.stringify(headSplit.body));
    assert.strictEqual(await putawayCount(receipt.grnLineId, 'held'), 1);
  });

  async function putawayCount(grnLineId: string, status: string): Promise<number> {
    const r = await getPool().query(
      `SELECT count(*)::int AS n FROM putaway_task WHERE grn_line_id = $1 AND status = $2`,
      [grnLineId, status],
    );
    return r.rows[0]!['n'] as number;
  }

  // -------------------------------------------------------------------------
  // AC 2
  // -------------------------------------------------------------------------

  it('AC2: a QC-head accept releases and retargets the held putaway; a reject does not', async () => {
    const plan = await seedPlan(await createItem(`FG-810-R-${run}`), `FG-810-R-${run}`);
    const accepted = await receive(plan.sku, '10', `LOT-810-R1-${run}`);
    assert.ok(accepted.taskId);
    await inspect(accepted, plan);
    const accept = await disposition(accepted.taskId!, 'accept', qcHeadHeaders);
    assert.strictEqual(accept.status, 201, JSON.stringify(accept.body));
    const released = await putaway(accepted.putawayTaskId);
    assert.strictEqual(released['status'], 'ready');
    assert.strictEqual(released['release_reason_code'], 'qc_accept');
    assert.ok(released['released_at'], 'released_at must be stamped');
    assert.strictEqual(released['lot_id'], accepted.lotNumber);
    assert.strictEqual(released['quantity'], '10.000');
    const releaseEvent = await getPool().query(
      `SELECT payload FROM domain_events
        WHERE event_type = 'goods.putaway_released' AND payload->>'putaway_task_id' = $1`,
      [accepted.putawayTaskId],
    );
    assert.strictEqual(releaseEvent.rows.length, 1);
    assert.strictEqual(
      (releaseEvent.rows[0]!['payload'] as Record<string, unknown>)['disposition_id'],
      (accept.body['disposition'] as Record<string, unknown>)['disposition_id'],
    );

    const rejected = await receive(plan.sku, '5', `LOT-810-R2-${run}`);
    assert.ok(rejected.taskId);
    await inspect(rejected, plan);
    const reject = await disposition(rejected.taskId!, 'reject', qcHeadHeaders);
    assert.strictEqual(reject.status, 201, JSON.stringify(reject.body));
    const stillHeld = await putaway(rejected.putawayTaskId);
    assert.strictEqual(stillHeld['status'], 'held');
    assert.strictEqual(stillHeld['released_at'], null);
    assert.strictEqual(await putawayCount(rejected.grnLineId, 'held'), 1);
  });

  it('AC1: a held receipt with no resolvable lot posts and records no_lot', async () => {
    const sku = `FG-810-NOLOT-${run}`;
    await createItem(sku, { quarantineRequired: true, lotControlled: false });
    const receipt = await receive(sku, '2', null);
    assert.strictEqual(receipt.putawayStatus, 'held');
    assert.strictEqual(receipt.taskId, null);
    const held = await putaway(receipt.putawayTaskId);
    assert.strictEqual(held['hold_reason'], 'no_lot');
  });

  it('AC1: a duplicate lot is refused by the stock surface before any QC task is opened', async () => {
    // Story 8.10 D6: the receiving stock view creates the lot and refuses a duplicate with
    // DUPLICATE_LOT before the QC seam runs, so the seam's duplicate_lot hold reason is a defensive
    // backstop for any future caller that reaches it. The receipt never posts and no task exists.
    const plan = await seedPlan(await createItem(`FG-810-DUP-${run}`), `FG-810-DUP-${run}`);
    const first = await receive(plan.sku, '3', `LOT-810-DUP-${run}`);
    assert.ok(first.taskId);
    const duplicate = await receiptResponse(plan.sku, '2', first.lotNumber);
    assert.strictEqual(duplicate.res.status, 400, JSON.stringify(duplicate.res.body));
    assert.strictEqual(duplicate.res.body['error_code'], 'DUPLICATE_LOT');
    const tasks = await getPool().query(
      `SELECT count(*)::int AS n FROM qc_inspection_task WHERE lot_number = $1`,
      [first.lotNumber],
    );
    assert.strictEqual(tasks.rows[0]!['n'], 1);
  });

  it('AC2: an open damage case blocks the QC accept-release', async () => {
    const plan = await seedPlan(await createItem(`FG-810-DMG-${run}`), `FG-810-DMG-${run}`);
    const receipt = await receive(plan.sku, '5', `LOT-810-DMG-${run}`, {
      condition: 'DAMAGED',
      reasonCode: 'DAMAGED',
      reasonDetail: 'TRANSIT_DAMAGE',
    });
    assert.ok(receipt.taskId);
    await inspect(receipt, plan);
    const res = await disposition(receipt.taskId!, 'accept', qcHeadHeaders);
    assert.strictEqual(res.status, 409, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'DAMAGE_CASE_BLOCKS_RELEASE');
    const held = await putaway(receipt.putawayTaskId);
    assert.strictEqual(held['status'], 'held');
    assert.strictEqual(held['released_at'], null);
  });

  it('AC2: accepting a split child retargets the putaway to that child and its quantity', async () => {
    const plan = await seedPlan(await createItem(`FG-810-SPL-${run}`), `FG-810-SPL-${run}`);
    const receipt = await receive(plan.sku, '100', `LOT-810-SPL-${run}`);
    assert.ok(receipt.taskId);
    await inspect(receipt, plan);
    const split = await makeRequest(
      port,
      'POST',
      `/api/v1/qc/tasks/${receipt.taskId}/split`,
      {
        justification: 'Story 8.10 split release proof',
        splits: [
          { sequence: 1, quantity: '80' },
          { sequence: 2, quantity: '20' },
        ],
      },
      qcHeadHeaders,
    );
    assert.strictEqual(split.status, 201, JSON.stringify(split.body));
    const children = await getPool().query(
      `SELECT child_lot_number, child_task_id, quantity::text AS quantity
         FROM qc_lot_split WHERE parent_task_id = $1 ORDER BY sequence`,
      [receipt.taskId],
    );
    assert.strictEqual(children.rows.length, 2);
    const good = children.rows[0]!;
    const bad = children.rows[1]!;
    const accepted = await disposition(good['child_task_id'] as string, 'accept', qcHeadHeaders);
    assert.strictEqual(accepted.status, 201, JSON.stringify(accepted.body));
    const released = await putaway(receipt.putawayTaskId);
    assert.strictEqual(released['status'], 'ready');
    assert.strictEqual(released['lot_id'], good['child_lot_number']);
    assert.strictEqual(String(released['quantity']), '80.000');
    const remaining = await getPool().query(
      `SELECT location_id, on_hand::text AS on_hand FROM stock_balance
        WHERE sku = $1 AND lot_id = $2`,
      [plan.sku, bad['child_lot_number']],
    );
    assert.strictEqual(remaining.rows[0]!['location_id'], qcHoldZoneId);
    assert.strictEqual(Number(remaining.rows[0]!['on_hand']), 20);
  });

  it('AC2/AC6: the receipt QC completion stays central-only on the edge upload route', async () => {
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/edge/events',
      {
        event_id: randomUUID(),
        stream_type: 'qc',
        stream_id: randomUUID(),
        event_type: 'qc.completion_received',
        event_version: 1,
        payload: {
          source_completion_type: 'goods_receipt',
          source_completion_id: randomUUID(),
        },
        metadata: {
          correlation_id: randomUUID(),
          actor: { user_id: inspectorUserId, role: 'qc_inspector', location_id: siteId },
          device_id: DEVICE_ID,
          capture_method: 'MANUAL',
          occurred_at: new Date().toISOString(),
        },
        schema_version: 1,
        idempotency_key: `edge-810-${randomUUID()}`,
      },
      inspectorHeaders,
    );
    assert.strictEqual(res.status, 403, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'CENTRAL_ONLY_OPERATION');
  });

  it('AC3/AC6: the observation note event stays central-only on the edge upload route', async () => {
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/edge/events',
      {
        event_id: randomUUID(),
        stream_type: 'qc',
        stream_id: randomUUID(),
        event_type: 'qc.observation_note_recorded',
        event_version: 1,
        payload: {
          task_id: randomUUID(),
          lot_id: randomUUID(),
          note_id: randomUUID(),
          note: 'edge attempt',
          attachment_id: null,
          recorded_at: new Date().toISOString(),
        },
        metadata: {
          correlation_id: randomUUID(),
          actor: { user_id: inspectorUserId, role: 'qc_inspector', location_id: siteId },
          device_id: DEVICE_ID,
          capture_method: 'MANUAL',
          occurred_at: new Date().toISOString(),
        },
        schema_version: 1,
        idempotency_key: `edge-810-${randomUUID()}`,
      },
      inspectorHeaders,
    );
    assert.strictEqual(res.status, 403, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'CENTRAL_ONLY_OPERATION');
  });

  it('AC5: the gate_status filter accepts every post-hold status and rejects an unknown value', async () => {
    for (const status of ['accepted', 'rejected', 'split', 'qc_hold', 'conditionally_released']) {
      const res = await makeRequest(
        port,
        'GET',
        `/api/v1/qc/tasks?gate_status=${status}&limit=5`,
        undefined,
        inspectorHeaders,
      );
      assert.strictEqual(res.status, 200, `${status}: ${JSON.stringify(res.body)}`);
    }
    const bad = await makeRequest(
      port,
      'GET',
      '/api/v1/qc/tasks?gate_status=nonsense&limit=5',
      undefined,
      inspectorHeaders,
    );
    assert.strictEqual(bad.status, 400, JSON.stringify(bad.body));
    assert.match(
      String(bad.body['message']),
      /qc_hold, conditionally_released, accepted, rejected, split/,
    );
  });
});
