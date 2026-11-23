import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request as httpRequest, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createAppRouter, createAppServer } from '../../src/server.js';
import { getAdminPool, getPool, closeAdminPool, closePool } from '../../src/config/db.js';
import { persistEvent } from '../../src/events/store.js';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const run = randomUUID().slice(0, 8);
const SCIM = { Authorization: `Bearer ${process.env.SCIM_BEARER_TOKEN ?? ''}` };
type Body = Record<string, unknown>;
type Role = { role: string; module: string; functionScope: 'read' | 'write'; locationId: string };
type Response = { status: number; body: Body };
function request(
  port: number,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return new Promise((resolveRequest, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        headers: {
          'Content-Type': 'application/json',
          ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
          ...headers,
        },
      },
      (res: IncomingMessage) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (text += chunk));
        res.on('end', () => {
          let parsed: Body = {};
          try {
            if (text) parsed = JSON.parse(text) as Body;
          } catch {
            parsed = { text };
          }
          resolveRequest({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}
const writer = (role: string): Role => ({
  role,
  module: 'engineering',
  functionScope: 'write',
  locationId: '*',
});
async function provision(port: number, email: string, roles: Role[]): Promise<string> {
  const r = await request(
    port,
    'POST',
    '/api/v1/scim/v2/Users',
    { externalId: email, email, displayName: email, roles },
    SCIM,
  );
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body['userId'] as string;
}
async function token(port: number, email: string): Promise<Record<string, string>> {
  const r = await request(port, 'POST', '/api/v1/auth/dev-token', { sub: email });
  assert.ok(r.body['token']);
  return { Authorization: `Bearer ${r.body['token'] as string}` };
}

describe('Story 10.3 project WIP, builds, prototypes, dispositions and returns', () => {
  let server: Server;
  let port: number;
  let headers: Record<string, string>;
  let headHeaders: Record<string, string>;
  let userId: string;
  let headUserId: string;
  const project = `P103-${run}`.toUpperCase();
  const sku = `RD103-${run}`;
  const site = randomUUID();
  const bin = randomUUID();
  let lotId: string;
  before(async () => {
    const admin = getAdminPool();
    const projections = [
      'users',
      'audit_log',
      'doa_registry',
      'business_stream_config',
      'location',
      'instrument_calibration',
      'notification',
      'item_master',
      'location_register',
      'stock_balance',
      'lot_master',
      'rd_project',
      'rd_reclassification',
      'serial_master',
      'lot_trace',
      'inventory_valuation',
      'asset',
      'rd_requisition',
      'rd_requisition_line',
      'rd_project_checklist',
      'rd_issue_cost',
      'rd_equipment_custody',
      'rd_build_record',
      'rd_as_built_line',
      'rd_project_wip_ledger',
      'rd_prototype',
      'rd_disposition',
      'rd_disposition_line',
      'rd_scrap_pending',
      'pick_task',
      'packing_record',
      'dispatch_document',
      'qc_inspection_task',
    ];
    for (const file of [
      '../../events/domain_events.sql',
      ...projections.map((p) => `../../read/projections/${p}.sql`),
    ])
      await admin.query(readFileSync(resolve(__dirname, file), 'utf8'));
    for (const t of ['audit_log', 'audit_log_tamper_attempt_log', 'audit_log_archive'])
      await admin.query(`ALTER TABLE ${t} DISABLE TRIGGER ALL`);
    try {
      await admin.query(
        'TRUNCATE rd_scrap_pending, rd_disposition_line, rd_disposition, rd_prototype, rd_project_wip_ledger, rd_equipment_custody, rd_issue_cost, rd_project_checklist, rd_requisition_line, rd_requisition, rd_reclassification, rd_project, rd_as_built_line, rd_build_record, packing_record, dispatch_document, qc_inspection_task, dispatch_order_status, lot_trace, serial_master, lot_master, stock_balance, inventory_valuation, asset, item_master, location_register, notification_escalations, notification_escalation_defs, notification_deliveries, notification_dispatch_attempts, notification_dispatch_log, notifications, doa_vacation_delegations, doa_registry_entries, transaction_tagging_rules, audit_log_tamper_attempt_log, audit_log_archive, audit_log, user_role_assignments, users, domain_events CASCADE',
      );
    } finally {
      for (const t of ['audit_log', 'audit_log_tamper_attempt_log', 'audit_log_archive'])
        await admin.query(`ALTER TABLE ${t} ENABLE TRIGGER ALL`);
    }
    server = createAppServer(createAppRouter());
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once('error', rejectListen);
      server.listen(0, () => {
        server.off('error', rejectListen);
        port = (server.address() as AddressInfo).port;
        resolveListen();
      });
    });
    const pool = getPool();
    await pool.query(
      "INSERT INTO location_register (location_id,location_code,level,parent_location_id,site_id,zone_type,temperature_class,status) VALUES ($1,$2,'site',NULL,$1,'general','ambient','active')",
      [site, `SITE-${run}`],
    );
    await pool.query(
      "INSERT INTO location_register (location_id,location_code,level,parent_location_id,site_id,zone_type,temperature_class,status,location_type) VALUES ($1,$2,'bin',$3,$3,'general','ambient','active','rd_store')",
      [bin, `BIN-${run}`, site],
    );
    await pool.query(
      "INSERT INTO item_master (sku,uom,lot_controlled,serial_controlled,valuation_method,business_stream,status) VALUES ($1,'EA',true,false,'weighted_average','production','active')",
      [sku],
    );
    const email = `story103-${run}@example.com`;
    userId = await provision(port, email, [writer(`rd_user_${run}`)]);
    headers = await token(port, email);
    headUserId = await provision(port, `head103-${run}@example.com`, [writer(`rd_head_${run}`)]);
    headHeaders = await token(port, `head103-${run}@example.com`);
    const doa = await provision(port, `doa103-${run}@example.com`, [
      {
        role: `compliance_admin_${run}`,
        module: 'compliance',
        functionScope: 'write',
        locationId: '*',
      },
    ]);
    const doaHeaders = await token(port, `doa103-${run}@example.com`);
    const band = await request(
      port,
      'POST',
      '/api/v1/doa/entries',
      {
        transaction_type: 'rd_budget_breach',
        role: `rd_head_${run}`,
        value_min: null,
        value_max: null,
      },
      doaHeaders,
    );
    assert.equal(band.status, 201, JSON.stringify(band.body));
    void doa;
    const p = await request(
      port,
      'POST',
      '/api/v1/rd-projects',
      { project_code: project, owner_user_id: userId, phase: 'research', budget_amount: 1000 },
      headers,
    );
    assert.equal(p.status, 201, JSON.stringify(p.body));
    lotId = randomUUID();
    await pool.query(
      'INSERT INTO lot_master (lot_id,sku,lot_number,rd_designated) VALUES ($1,$2,$3,true)',
      [lotId, sku, `LOT-${run}`],
    );
  });
  after(async () => {
    await new Promise<void>((resolveClose) => server?.close(() => resolveClose()));
    await closePool();
    await closeAdminPool();
  });

  async function registerPrototype(serial: string, projectCode = project): Promise<string> {
    const pool = getPool();
    const buildId = randomUUID();
    await pool.query(
      "INSERT INTO rd_build_record (build_id,bom_id,revision_id,build_ref,status,built_quantity,built_uom,outcome,recorded_by,recorded_at,source_event_id,project_code) VALUES ($1,$2,$3,$4,'recorded',1,'EA','success',$5,now(),$6,$7)",
      [buildId, randomUUID(), randomUUID(), `B-${serial}`, userId, randomUUID(), projectCode],
    );
    const done = await request(
      port,
      'POST',
      `/api/v1/rd-builds/${buildId}/complete`,
      {
        sku,
        serial_number: serial,
        lot_id: lotId,
        location_id: bin,
        idempotency_key: `proto-${serial}`,
      },
      headers,
    );
    assert.equal(done.status, 200, JSON.stringify(done.body));
    return ((done.body['prototype'] ?? {}) as Body)['prototype_id'] as string;
  }

  it('records a project build, registers prototype serial identity without stock or valuation, and refuses duplicate serial', async () => {
    const pool = getPool();
    const lot = `LOT-${run}`;
    const item = (await pool.query('SELECT item_id FROM item_master WHERE sku=$1', [sku])).rows[0]![
      'item_id'
    ] as string;
    const bom = randomUUID();
    const revision = randomUUID();
    await pool.query(
      "INSERT INTO bom (bom_id,parent_item_id,parent_sku,parent_uom,business_stream,bom_type,status,current_revision_id,created_by,origin,remediation_flag,created_at,updated_at,source_event_id) VALUES ($1,$2,$3,'EA','research','rnd','draft',$4,$5,'native',false,now(),now(),$6)",
      [bom, item, sku, revision, userId, randomUUID()],
    );
    await pool.query(
      "INSERT INTO bom_line (bom_line_id,bom_id,revision_id,line_no,component_item_id,component_sku,is_placeholder,output_class,quantity_per,line_uom,uom_conversion_factor,base_quantity_per,is_phantom,supply_method,effective_from,blocking_release,amended_at,source_event_id) VALUES ($1,$2,$3,1,$4,$5,false,'component',1,'EA',1,1,false,'directed_issue',CURRENT_DATE,false,now(),$6)",
      [randomUUID(), bom, revision, item, sku, randomUUID()],
    );
    await pool.query(
      "INSERT INTO bom_revision (revision_id,bom_id,revision_code,revision_status,drafted_by,drafted_at,source_event_id) VALUES ($1,$2,'A','draft',$3,now(),$4)",
      [revision, bom, userId, randomUUID()],
    );
    const recorded = await request(
      port,
      'POST',
      `/api/v1/boms/${bom}/builds`,
      {
        build_ref: `B-${run}`,
        project_code: project,
        built_quantity: '1',
        built_uom: 'EA',
        outcome: 'success',
        as_built_lines: [{ component_item_id: item, quantity_used: '1', line_uom: 'EA' }],
      },
      headers,
    );
    assert.equal(recorded.status, 201, JSON.stringify(recorded.body));
    const buildId = recorded.body['build_id'] as string;
    const done = await request(
      port,
      'POST',
      `/api/v1/rd-builds/${buildId}/complete`,
      {
        sku,
        serial_number: `SER-${run}`,
        lot_id: lot,
        location_id: bin,
        idempotency_key: `proto-${run}`,
      },
      headers,
    );
    assert.equal(done.status, 200, JSON.stringify(done.body));
    const prototype = (done.body['prototype'] ?? {}) as Body;
    const prototypeId = prototype['prototype_id'] as string;
    assert.equal(
      (
        await pool.query('SELECT count(*)::int AS n FROM rd_prototype WHERE prototype_id=$1', [
          prototypeId,
        ])
      ).rows[0]!['n'],
      1,
    );
    const prototypeRow = (
      await pool.query('SELECT lot_id, stock_class FROM rd_prototype WHERE prototype_id=$1', [
        prototypeId,
      ])
    ).rows[0]!;
    assert.equal(prototypeRow['lot_id'], lotId);
    assert.equal(prototypeRow['stock_class'], 'prototype');
    assert.equal(
      (
        await pool.query(
          'SELECT count(*)::int AS n FROM serial_master WHERE sku=$1 AND serial_number=$2',
          [sku, `SER-${run}`],
        )
      ).rows[0]!['n'],
      1,
    );
    assert.equal(
      (await pool.query('SELECT count(*)::int AS n FROM stock_balance WHERE sku=$1', [sku]))
        .rows[0]!['n'],
      0,
    );
    assert.equal(
      (await pool.query('SELECT count(*)::int AS n FROM inventory_valuation WHERE sku=$1', [sku]))
        .rows[0]!['n'],
      0,
    );
    assert.equal(
      (
        await pool.query(
          'SELECT count(*)::int AS n FROM domain_events WHERE event_type = $1 AND idempotency_key = $2',
          ['rd_build.completed', `proto-${run}`],
        )
      ).rows[0]!['n'],
      1,
    );
    const replay = await request(
      port,
      'POST',
      `/api/v1/rd-builds/${buildId}/complete`,
      {
        sku,
        serial_number: `SER-${run}`,
        lot_id: lot,
        location_id: bin,
        idempotency_key: `proto-${run}`,
      },
      headers,
    );
    assert.equal(replay.status, 200);
    const duplicate = await request(
      port,
      'POST',
      `/api/v1/rd-builds/${buildId}/complete`,
      { sku, serial_number: `SER-${run}`, lot_id: lot, location_id: bin },
      headers,
    );
    assert.equal(duplicate.body['error_code'], 'DUPLICATE_SERIAL');
    const absent = await request(
      port,
      'GET',
      `/api/v1/rd-prototypes/${randomUUID()}`,
      undefined,
      headers,
    );
    assert.equal(absent.status, 404);
  });

  it('rejects failed builds and enforces disposition approval and no-line rules', async () => {
    const pool = getPool();
    const failed = randomUUID();
    await pool.query(
      "INSERT INTO rd_build_record (build_id,bom_id,revision_id,build_ref,status,built_quantity,built_uom,outcome,recorded_by,recorded_at,source_event_id,project_code) VALUES ($1,$2,$2,$3,'recorded',1,'EA','failed',$4,now(),$5,$6)",
      [failed, randomUUID(), `FAIL-${run}`, userId, randomUUID(), project],
    );
    const rejected = await request(
      port,
      'POST',
      `/api/v1/rd-builds/${failed}/complete`,
      { sku, serial_number: `FAIL-${run}`, lot_id: `LOT-${run}`, location_id: bin },
      headers,
    );
    assert.equal(rejected.body['error_code'], 'RD_BUILD_NOT_COMPLETED');
    const proto = (
      await getPool().query('SELECT prototype_id FROM rd_prototype WHERE sku=$1 LIMIT 1', [sku])
    ).rows[0]!['prototype_id'] as string;
    const noLines = await request(
      port,
      'POST',
      `/api/v1/rd-prototypes/${proto}/dispositions`,
      { disposition_type: 'scrap' },
      headers,
    );
    assert.equal(noLines.body['error_code'], 'RD_DISPOSITION_LINE_REQUIRED');
    const requestDisposition = await request(
      port,
      'POST',
      `/api/v1/rd-prototypes/${proto}/dispositions`,
      {
        disposition_type: 'scrap',
        lines: [{ line_no: 1, component_sku: sku, quantity: '1', condition_code: 'damaged' }],
      },
      headers,
    );
    assert.equal(requestDisposition.status, 201, JSON.stringify(requestDisposition.body));
    const dispositionId = requestDisposition.body['disposition_id'] as string;
    assert.ok(dispositionId);
    const early = await request(
      port,
      'POST',
      `/api/v1/rd-dispositions/${dispositionId}/execute`,
      {},
      headers,
    );
    assert.equal(early.body['error_code'], 'RD_DISPOSITION_NOT_APPROVED');
    const projectWip = await request(
      port,
      'GET',
      `/api/v1/rd-projects/${project}/wip`,
      undefined,
      headers,
    );
    assert.equal(projectWip.status, 200);
    const builds = await request(
      port,
      'GET',
      `/api/v1/rd-projects/${project}/builds`,
      undefined,
      headers,
    );
    assert.equal(builds.status, 200);
    const buildRows = builds.body['builds'] as Body[];
    const failedRow = buildRows.find((row) => row['build_id'] === failed);
    assert.ok(failedRow, 'failed build must appear in project build history');
    assert.equal(failedRow!['outcome'], 'failed');
    assert.ok(Array.isArray(failedRow!['as_built_lines']));
  });

  it('AC1/AC7: project-material issue posts WIP and a return reverses it by cost', async () => {
    const pool = getPool();
    const wipSku = `RDWIP-${run}`;
    const wipLot = randomUUID();
    const wipProject = `WIP-${run}`.toUpperCase();
    await pool.query(
      "INSERT INTO item_master (sku,uom,lot_controlled,serial_controlled,valuation_method,business_stream,status) VALUES ($1,'EA',true,false,'fifo','production','active')",
      [wipSku],
    );
    await pool.query(
      'INSERT INTO lot_master (lot_id,sku,lot_number,rd_designated) VALUES ($1,$2,$3,true)',
      [wipLot, wipSku, `WLOT-${run}`],
    );
    await persistEvent({
      stream_type: 'inventory',
      stream_id: randomUUID(),
      event_type: 'stock.received',
      payload: {
        business_stream: 'production',
        sku: wipSku,
        target_location_id: bin,
        quantity: 10,
        unit_cost: 5,
        lot_id: wipLot,
        stock_class: 'owned',
      },
      metadata: {
        correlation_id: randomUUID(),
        actor: { user_id: userId, role: `rd_user_${run}`, location_id: site },
        occurred_at: new Date().toISOString(),
      },
    });
    const created = await request(
      port,
      'POST',
      '/api/v1/rd-projects',
      { project_code: wipProject, owner_user_id: userId, phase: 'research', budget_amount: 1000 },
      headers,
    );
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const raised = await request(
      port,
      'POST',
      '/api/v1/rd-requisitions',
      {
        project_code: wipProject,
        lines: [
          {
            sku: wipSku,
            requested_qty: '2',
            uom: 'EA',
            unit_cost_estimate: '5',
            issue_type: 'project_material',
          },
        ],
      },
      headers,
    );
    assert.equal(raised.status, 201, JSON.stringify(raised.body));
    const requisitionId = raised.body['requisition_id'] as string;
    const requisitionLine = (raised.body['lines'] as Body[])[0]!;
    const issued = await request(
      port,
      'POST',
      `/api/v1/rd-requisitions/${requisitionId}/issue`,
      {
        lines: [
          {
            requisition_line_id: requisitionLine['requisition_line_id'],
            quantity: '2',
            location_id: bin,
            lot_id: wipLot,
          },
        ],
      },
      headers,
    );
    assert.equal(issued.status, 201, JSON.stringify(issued.body));
    const wipAfterIssue = await request(
      port,
      'GET',
      `/api/v1/rd-projects/${wipProject}/wip`,
      undefined,
      headers,
    );
    assert.equal(wipAfterIssue.status, 200);
    const wipView = wipAfterIssue.body['wip'] as Body;
    assert.equal(Number(wipView['quantity']), 2);
    assert.equal(Number(wipView['value']), 10);
    const issuePosting = (
      await pool.query(
        "SELECT * FROM rd_project_wip_ledger WHERE project_code=$1 AND posting_type='issue'",
        [wipProject],
      )
    ).rows[0]!;
    const returned = await request(
      port,
      'POST',
      `/api/v1/rd-projects/${wipProject}/returns`,
      {
        posting_id: issuePosting['posting_id'],
        quantity: '1',
        location_id: bin,
        lot_id: wipLot,
        reason_code: 'unused-project-material',
        idempotency_key: `ret-${run}`,
      },
      headers,
    );
    assert.equal(returned.status, 201, JSON.stringify(returned.body));
    const afterReturn = await request(
      port,
      'GET',
      `/api/v1/rd-projects/${wipProject}/wip`,
      undefined,
      headers,
    );
    const wipReturned = afterReturn.body['wip'] as Body;
    assert.equal(Number(wipReturned['quantity']), 1);
    assert.equal(Number(wipReturned['value']), 5);
    const returnPosting = (
      await pool.query(
        "SELECT * FROM rd_project_wip_ledger WHERE project_code=$1 AND posting_type='return'",
        [wipProject],
      )
    ).rows[0]!;
    assert.equal(returnPosting['source_posting_id'], issuePosting['posting_id']);
    assert.ok(returnPosting['reason_code']);
    assert.equal(Number(returnPosting['posting_value']), -5);
    const openAfter = await pool.query(
      'SELECT open_quantity FROM rd_project_wip_ledger WHERE posting_id=$1',
      [issuePosting['posting_id']],
    );
    assert.equal(Number(openAfter.rows[0]!['open_quantity']), 1);
    const stockAfter = await pool.query(
      'SELECT COALESCE(SUM(on_hand),0)::float8 AS q FROM stock_balance WHERE sku=$1 AND location_id=$2',
      [wipSku, bin],
    );
    assert.equal(Number(stockAfter.rows[0]!['q']), 9);
    const replay = await request(
      port,
      'POST',
      `/api/v1/rd-projects/${wipProject}/returns`,
      {
        posting_id: issuePosting['posting_id'],
        quantity: '1',
        location_id: bin,
        lot_id: wipLot,
        reason_code: 'unused-project-material',
        idempotency_key: `ret-${run}`,
      },
      headers,
    );
    assert.equal(replay.status, 201);
    const afterReplay = await request(
      port,
      'GET',
      `/api/v1/rd-projects/${wipProject}/wip`,
      undefined,
      headers,
    );
    assert.equal(Number((afterReplay.body['wip'] as Body)['quantity']), 1);
    const overReturn = await request(
      port,
      'POST',
      `/api/v1/rd-projects/${wipProject}/returns`,
      {
        posting_id: issuePosting['posting_id'],
        quantity: '2',
        location_id: bin,
        lot_id: wipLot,
        reason_code: 'unused-project-material',
      },
      headers,
    );
    assert.equal(overReturn.body['error_code'], 'RD_RETURN_EXCEEDS_OPEN');
    const returnOfReturn = await request(
      port,
      'POST',
      `/api/v1/rd-projects/${wipProject}/returns`,
      {
        posting_id: returnPosting['posting_id'],
        quantity: '1',
        location_id: bin,
        lot_id: wipLot,
        reason_code: 'unused-project-material',
      },
      headers,
    );
    assert.equal(returnOfReturn.body['error_code'], 'RD_RETURN_EXCEEDS_OPEN');
    const consumableRaised = await request(
      port,
      'POST',
      '/api/v1/rd-requisitions',
      {
        project_code: wipProject,
        lines: [
          {
            sku: wipSku,
            requested_qty: '1',
            uom: 'EA',
            unit_cost_estimate: '5',
            issue_type: 'consumable',
          },
        ],
      },
      headers,
    );
    assert.equal(consumableRaised.status, 201, JSON.stringify(consumableRaised.body));
    const consumableLine = (consumableRaised.body['lines'] as Body[])[0]!;
    const consumableIssued = await request(
      port,
      'POST',
      `/api/v1/rd-requisitions/${consumableRaised.body['requisition_id'] as string}/issue`,
      {
        lines: [
          {
            requisition_line_id: consumableLine['requisition_line_id'],
            quantity: '1',
            location_id: bin,
            lot_id: wipLot,
          },
        ],
      },
      headers,
    );
    assert.equal(consumableIssued.status, 201, JSON.stringify(consumableIssued.body));
    const issuePostings = await pool.query(
      "SELECT count(*)::int AS n FROM rd_project_wip_ledger WHERE project_code=$1 AND posting_type='issue'",
      [wipProject],
    );
    assert.equal(issuePostings.rows[0]!['n'], 1);
    const wipAfterConsumable = await request(
      port,
      'GET',
      `/api/v1/rd-projects/${wipProject}/wip`,
      undefined,
      headers,
    );
    assert.equal(Number((wipAfterConsumable.body['wip'] as Body)['quantity']), 1);
  });

  it('AC4: a registered prototype lot blocks document generation and final dispatch with NON_SALEABLE_CLASS', async () => {
    const pool = getPool();
    const dispatchOrderId = randomUUID();
    await pool.query(
      'INSERT INTO dispatch_order_status (dispatch_order_id, picked_by, packed_at, packed_by) VALUES ($1, $2, now(), $2)',
      [dispatchOrderId, userId],
    );
    await pool.query(
      "INSERT INTO packing_record (packing_record_id, dispatch_order_id, sku, packed_qty, lot_id, carton_count, status, packed_by) VALUES ($1,$2,$3,1,$4,1,'packed',$5)",
      [randomUUID(), dispatchOrderId, sku, lotId, userId],
    );
    const metadata = {
      correlation_id: randomUUID(),
      actor: { user_id: userId, role: 'dispatch_clerk', location_id: site },
      occurred_at: new Date().toISOString(),
    };
    await assert.rejects(
      async () => {
        await persistEvent({
          stream_type: 'warehouse',
          stream_id: dispatchOrderId,
          event_type: 'dispatch.shipping_documents_generated',
          payload: { dispatch_order_id: dispatchOrderId, document_types: ['bol'] },
          metadata,
        } as never);
      },
      (error: unknown) => (error as { errorCode?: string }).errorCode === 'NON_SALEABLE_CLASS',
    );
    await pool.query(
      "INSERT INTO dispatch_document (document_id, dispatch_order_id, document_type, document_content, generated_by) VALUES ($1,$2,'bol','{}',$3)",
      [randomUUID(), dispatchOrderId, userId],
    );
    await assert.rejects(
      async () => {
        await persistEvent({
          stream_type: 'warehouse',
          stream_id: dispatchOrderId,
          event_type: 'dispatch.dispatched',
          payload: { dispatch_order_id: dispatchOrderId },
          metadata,
        } as never);
      },
      (error: unknown) => (error as { errorCode?: string }).errorCode === 'NON_SALEABLE_CLASS',
    );
  });

  it('AC5/AC6: dispositions require R&D-head approval and execute teardown, scrap, retain and transfer', async () => {
    const pool = getPool();
    const approve = (dispositionId: string, tokenHeaders: Record<string, string>) =>
      request(port, 'POST', `/api/v1/rd-dispositions/${dispositionId}/approve`, {}, tokenHeaders);
    const execute = (dispositionId: string, body: Body = {}) =>
      request(port, 'POST', `/api/v1/rd-dispositions/${dispositionId}/execute`, body, headers);
    const dispositionRow = async (dispositionId: string) =>
      (await pool.query('SELECT * FROM rd_disposition WHERE disposition_id=$1', [dispositionId]))
        .rows[0]!;

    const teardownProto = await registerPrototype(`SER-TEAR-${run}`);
    const teardownRequest = await request(
      port,
      'POST',
      `/api/v1/rd-prototypes/${teardownProto}/dispositions`,
      {
        disposition_type: 'teardown',
        lines: [{ line_no: 1, component_sku: sku, quantity: '1', condition_code: 'good' }],
      },
      headers,
    );
    assert.equal(teardownRequest.status, 201, JSON.stringify(teardownRequest.body));
    const teardownId = teardownRequest.body['disposition_id'] as string;
    const teardownPending = await dispositionRow(teardownId);
    assert.equal(teardownPending['status'], 'approval_required');
    assert.equal(teardownPending['approver_actor_id'], headUserId);
    const selfApproval = await approve(teardownId, headers);
    assert.equal(selfApproval.body['error_code'], 'APPROVAL_UNRESOLVED');
    const secondOpen = await request(
      port,
      'POST',
      `/api/v1/rd-prototypes/${teardownProto}/dispositions`,
      {
        disposition_type: 'scrap',
        lines: [{ line_no: 1, component_sku: sku, quantity: '1', condition_code: 'good' }],
      },
      headers,
    );
    assert.equal(secondOpen.body['error_code'], 'RD_DISPOSITION_ALREADY_DECIDED');
    const teardownApproved = await approve(teardownId, headHeaders);
    assert.equal(teardownApproved.status, 200, JSON.stringify(teardownApproved.body));
    assert.equal((await dispositionRow(teardownId))['status'], 'approved');
    const teardownExecuted = await execute(teardownId);
    assert.equal(teardownExecuted.status, 200, JSON.stringify(teardownExecuted.body));
    const teardownScrap = (
      await pool.query('SELECT * FROM rd_scrap_pending WHERE disposition_id=$1', [teardownId])
    ).rows[0]!;
    assert.equal(Number(teardownScrap['quantity']), 1);
    assert.equal(teardownScrap['condition_code'], 'good');
    assert.equal(teardownScrap['source_prototype_ref'], teardownProto);
    assert.equal(
      (await pool.query('SELECT status FROM rd_prototype WHERE prototype_id=$1', [teardownProto]))
        .rows[0]!['status'],
      'disposed',
    );
    const history = await request(
      port,
      'GET',
      `/api/v1/rd-projects/${project}/wip`,
      undefined,
      headers,
    );
    assert.ok(
      (history.body['scrap_pending'] as Body[]).some(
        (row) => row['prototype_id'] === teardownProto,
      ),
      'scrap-pending rows must be visible in the project material history',
    );

    const scrapProto = await registerPrototype(`SER-SCRAP-${run}`);
    const scrapRequest = await request(
      port,
      'POST',
      `/api/v1/rd-prototypes/${scrapProto}/dispositions`,
      {
        disposition_type: 'scrap',
        lines: [{ line_no: 1, component_sku: sku, quantity: '2', condition_code: 'damaged' }],
      },
      headers,
    );
    assert.equal(scrapRequest.status, 201, JSON.stringify(scrapRequest.body));
    const scrapId = scrapRequest.body['disposition_id'] as string;
    assert.equal((await approve(scrapId, headHeaders)).status, 200);
    assert.equal((await execute(scrapId)).status, 200);
    const scrapPending = (
      await pool.query('SELECT * FROM rd_scrap_pending WHERE disposition_id=$1', [scrapId])
    ).rows[0]!;
    assert.equal(Number(scrapPending['quantity']), 2);
    assert.equal(scrapPending['condition_code'], 'damaged');
    assert.equal(scrapPending['source_prototype_ref'], scrapProto);

    const retainProto = await registerPrototype(`SER-RETAIN-${run}`);
    const asset = {
      asset_id: randomUUID(),
      asset_tag: `TAG-${run}`,
      asset_name: 'Prototype retained asset',
      criticality_class: 'medium',
    };
    const retainRequest = await request(
      port,
      'POST',
      `/api/v1/rd-prototypes/${retainProto}/dispositions`,
      { disposition_type: 'retain-as-asset', asset },
      headers,
    );
    assert.equal(retainRequest.status, 201, JSON.stringify(retainRequest.body));
    const retainId = retainRequest.body['disposition_id'] as string;
    assert.equal((await approve(retainId, headHeaders)).status, 200);
    assert.equal((await execute(retainId, { asset })).status, 200);
    const retained = (await dispositionRow(retainId)) as Body;
    assert.equal(retained['asset_id'], asset.asset_id);
    assert.equal(
      (await pool.query('SELECT count(*)::int AS n FROM asset WHERE asset_id=$1', [asset.asset_id]))
        .rows[0]!['n'],
      1,
    );

    const transferProto = await registerPrototype(`SER-TRANSFER-${run}`);
    const productionReference = `PR-${run}`;
    const transferRequest = await request(
      port,
      'POST',
      `/api/v1/rd-prototypes/${transferProto}/dispositions`,
      { disposition_type: 'transfer-to-production', production_reference: productionReference },
      headers,
    );
    assert.equal(transferRequest.status, 201, JSON.stringify(transferRequest.body));
    const transferId = transferRequest.body['disposition_id'] as string;
    assert.equal((await approve(transferId, headHeaders)).status, 200);
    assert.equal(
      (await execute(transferId, { production_reference: productionReference })).status,
      200,
    );
    assert.equal((await dispositionRow(transferId))['production_reference'], productionReference);
  });
});
