import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request as httpRequest, type Server, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAppRouter, createAppServer } from '../../src/server.js';
import { closePool, getPool, getAdminPool, closeAdminPool } from '../../src/config/db.js';

/**
 * Story 3.14: the stores inbox arrivals read, the bootstrap inspection bay, the Stores nav row and
 * the additive GRN inspect-on-opening fields.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCIM_HEADERS = { Authorization: `Bearer ${process.env['SCIM_BEARER_TOKEN'] ?? ''}` };

interface HttpResult {
  status: number;
  body: Record<string, unknown>;
}

function makeRequest(
  port: number,
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<HttpResult> {
  return new Promise((resolvePromise, reject) => {
    const data = body ? JSON.stringify(body) : undefined;
    const req = httpRequest(
      {
        hostname: 'localhost',
        port,
        path,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
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
    req.setTimeout(10000, () => req.destroy(new Error(`Request timed out: ${method} ${path}`)));
    if (data) req.write(data);
    req.end();
  });
}

async function provisionUser(
  port: number,
  externalId: string,
  roles: Array<{
    role: string;
    module: string;
    functionScope: 'read' | 'write';
    locationId: string;
  }>,
): Promise<string> {
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
  assert.ok(res.status >= 200 && res.status < 300, JSON.stringify(res.body));
  return { Authorization: `Bearer ${res.body['token'] as string}` };
}

describe('Story 3.14 Stores Inbox and Acceptance', () => {
  let server: Server;
  let port: number;
  let siteAId: string;
  let siteBId: string;
  let storeHeaders: Record<string, string>;
  let storeUserId: string;
  let viewerHeaders: Record<string, string>;

  const PO_REF = 'PO-3-14-1';
  const TOKEN_OPEN = randomUUID();
  const TOKEN_ACCEPTED = randomUUID();
  const GRN_ID = randomUUID();
  const GRN_LINE_ID = randomUUID();

  before(async () => {
    const adminPool = getAdminPool();
    for (const file of [
      '../../events/domain_events.sql',
      '../../read/projections/users.sql',
      '../../read/projections/audit_log.sql',
      '../../read/projections/doa_registry.sql',
      '../../read/projections/business_stream_config.sql',
      '../../read/projections/location.sql',
      '../../read/projections/instrument_calibration.sql',
      '../../read/projections/statutory_examination.sql',
      '../../read/projections/item_master.sql',
      '../../read/projections/location_register.sql',
      '../../read/projections/erp_purchase_order.sql',
      '../../read/projections/gate_event.sql',
      '../../read/projections/weighbridge_event.sql',
      '../../read/projections/grn.sql',
      '../../read/projections/grn_line.sql',
      '../../read/projections/grn_line_condition.sql',
      '../../read/projections/grn_line_inspect.sql',
    ]) {
      await adminPool.query(readFileSync(resolve(__dirname, file), 'utf-8'));
    }
    await adminPool.query('ALTER TABLE audit_log DISABLE TRIGGER ALL');
    await adminPool.query('ALTER TABLE audit_log_tamper_attempt_log DISABLE TRIGGER ALL');
    await adminPool.query('ALTER TABLE audit_log_archive DISABLE TRIGGER ALL');
    try {
      await adminPool.query(
        'TRUNCATE grn_line, grn, weighbridge_event, gate_event, statutory_examination, erp_purchase_order_line, erp_purchase_order, item_master, location_register, instrument_calibration_statuses, location_current, location_asserted_facts, location_expected_facts, transaction_tagging_rules, doa_vacation_delegations, doa_registry_entries, audit_log_tamper_attempt_log, audit_log_archive, audit_log, user_role_assignments, users, domain_events CASCADE',
      );
    } finally {
      await adminPool.query('ALTER TABLE audit_log ENABLE TRIGGER ALL');
      await adminPool.query('ALTER TABLE audit_log_tamper_attempt_log ENABLE TRIGGER ALL');
      await adminPool.query('ALTER TABLE audit_log_archive ENABLE TRIGGER ALL');
    }

    siteAId = randomUUID();
    await getPool().query(
      `INSERT INTO location_register (location_id, location_code, level, parent_location_id, site_id, zone_type, temperature_class, quarantine, status)
       VALUES ($1, 'site-A', 'site', NULL, $1, 'general', 'ambient', false, 'active')`,
      [siteAId],
    );
    siteBId = randomUUID();
    await getPool().query(
      `INSERT INTO location_register (location_id, location_code, level, parent_location_id, site_id, zone_type, temperature_class, quarantine, status)
       VALUES ($1, 'site-B', 'site', NULL, $1, 'general', 'ambient', false, 'active')`,
      [siteBId],
    );
    // The inspection bay the bootstrap advertises.
    await getPool().query(
      `INSERT INTO location_register (location_id, location_code, level, parent_location_id, site_id, zone_type, temperature_class, quarantine, status)
       VALUES ($1, 'IB-01', 'zone', $2, $2, 'staging', 'ambient', false, 'active')`,
      [randomUUID(), siteAId],
    );
    await getPool().query(
      `INSERT INTO item_master (sku, uom, lot_controlled, serial_controlled, hazmat, quarantine_required, bis_licence_required, valuation_method, business_stream, status)
       VALUES ('SKU-3-14', 'EA', false, false, false, false, false, 'weighted_average', 'production', 'active')`,
    );
    await getPool().query(
      `INSERT INTO erp_purchase_order (po_number_ext, supplier_ref_ext, currency, expected_delivery_date, status, source_system, last_synced_at)
       VALUES ($1, 'SUP-3-14', 'INR', '2026-11-01', 'open', 'ERP', now())`,
      [PO_REF],
    );
    await getPool().query(
      `INSERT INTO erp_purchase_order_line (po_number_ext, line_no, sku, ordered_qty, open_qty, unit_price, over_receipt_tolerance_pct, under_receipt_tolerance_pct, source_system, last_synced_at)
       VALUES ($1, 1, 'SKU-3-14', 100, 90, 1, 10, 0, 'ERP', now())`,
      [PO_REF],
    );

    server = createAppServer(createAppRouter());
    await new Promise<void>((resolvePromise, reject) => {
      server.once('error', reject);
      server.listen(0, () => {
        server.off('error', reject);
        port = (server.address() as AddressInfo).port;
        resolvePromise();
      });
    });

    storeUserId = await provisionUser(port, 'store-3-14@example.com', [
      { role: 'store_assistant', module: 'receiving', functionScope: 'write', locationId: siteAId },
    ]);
    storeHeaders = await authFor(port, 'store-3-14@example.com');
    await provisionUser(port, 'viewer-3-14@example.com', [
      { role: 'stock_viewer', module: 'inventory', functionScope: 'read', locationId: siteAId },
    ]);
    viewerHeaders = await authFor(port, 'viewer-3-14@example.com');

    // Two open arrivals at site A: one matched and weighed (oldest), one unmatched. One arrival at
    // site B that must never appear in site A's list. One accepted arrival already carrying a GRN.
    const openGate = randomUUID();
    const unmatchedGate = randomUUID();
    const acceptedGate = randomUUID();
    const siteBGate = randomUUID();
    const insertGate = async (args: {
      id: string;
      siteId: string;
      siteCode: string;
      challan: string;
      binding: 'matched' | 'unmatched';
      token: string;
      minutes: number;
    }) =>
      getPool().query(
        `INSERT INTO gate_event
           (gate_event_id, site_id, site_code_ext, po_ref_ext, binding_status, vehicle_reg_ext,
            challan_number_ext, challan_photo_ref, gate_id, gate_officer_id, correlation_id,
            supplier_ref_ext, entered_at, business_date, status, source_event_id)
         VALUES ($1, $2, $3, $4, $5, 'KA01AB1234', $6, 'photo-gate', 'GATE-01', $7, $8,
                 'SUP-3-14', now() - ($9 || ' minutes')::interval, CURRENT_DATE, 'open', $10)`,
        [
          args.id,
          args.siteId,
          args.siteCode,
          args.binding === 'matched' ? PO_REF : null,
          args.binding,
          args.challan,
          storeUserId,
          args.token,
          String(args.minutes),
          randomUUID(),
        ],
      );

    await insertGate({
      id: unmatchedGate,
      siteId: siteAId,
      siteCode: 'site-A',
      challan: 'CH-UNMATCHED',
      binding: 'unmatched',
      token: randomUUID(),
      minutes: 5,
    });
    await insertGate({
      id: openGate,
      siteId: siteAId,
      siteCode: 'site-A',
      challan: 'CH-OPEN',
      binding: 'matched',
      token: TOKEN_OPEN,
      minutes: 10,
    });
    await insertGate({
      id: acceptedGate,
      siteId: siteAId,
      siteCode: 'site-A',
      challan: 'CH-ACCEPTED',
      binding: 'matched',
      token: TOKEN_ACCEPTED,
      minutes: 20,
    });
    await insertGate({
      id: siteBGate,
      siteId: siteBId,
      siteCode: 'site-B',
      challan: 'CH-B',
      binding: 'matched',
      token: randomUUID(),
      minutes: 30,
    });

    await getPool().query(
      `INSERT INTO weighbridge_event
         (weighbridge_event_id, correlation_id, gate_event_id, site_id, site_code_ext, po_ref_ext,
          line_no, tare_kg, gross_kg, net_kg, status, device_id, capture_method, weighed_by,
          business_date, source_event_id)
       VALUES ($1, $2, $3, $4, 'site-A', $5, 1, 100, 200, 100, 'accepted', 'WB-1', 'MANUAL',
               $6, CURRENT_DATE, $1)`,
      [randomUUID(), TOKEN_OPEN, openGate, siteAId, PO_REF, storeUserId],
    );
    await getPool().query(
      `INSERT INTO grn (grn_id, correlation_id, po_ref_ext, source_document, site_id, site_code_ext,
                        status, received_by, business_date, source_event_id, created_at)
       VALUES ($1, $2, $3, 'PO', $4, 'site-A', 'posted', $5, CURRENT_DATE, $1, now())`,
      [GRN_ID, TOKEN_ACCEPTED, PO_REF, siteAId, storeUserId],
    );
    await getPool().query(
      `INSERT INTO grn_line
         (grn_line_id, grn_id, po_ref_ext, line_no, sku, received_qty, uom,
          weighbridge_correlation_id, status, source_event_id, line_condition,
          inspect_on_opening, inspect_note, inspect_photo_ref, material_photo_ref)
       VALUES ($1, $2, $3, 1, 'SKU-3-14', 10, 'EA', $4, 'posted', $1, 'GOOD',
               'observed', 'dent on the side', 'photo-inspect', 'photo-material')`,
      [GRN_LINE_ID, GRN_ID, PO_REF, TOKEN_ACCEPTED],
    );
  });

  after(async () => {
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    await closePool();
    await closeAdminPool();
  });

  it('AC1/AC2: bootstrap carries the Stores entry and the inspection bay', async () => {
    const res = await makeRequest(port, 'GET', '/api/v1/edge/bootstrap', undefined, storeHeaders);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.ok((res.body['navigation'] as string[]).includes('Stores'));
    assert.equal(res.body['inspection_bay_code'], 'IB-01');
  });

  it('AC1: a caller without receiving write is not sent the Stores entry', async () => {
    const res = await makeRequest(port, 'GET', '/api/v1/edge/bootstrap', undefined, viewerHeaders);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.ok(!(res.body['navigation'] as string[]).includes('Stores'));
  });

  it('AC2: arrivals are scoped to the site, oldest first, with weighment and GRN joins', async () => {
    const res = await makeRequest(
      port,
      'GET',
      '/api/v1/receiving/arrivals?site=site-A',
      undefined,
      storeHeaders,
    );
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    const arrivals = res.body['arrivals'] as Array<Record<string, unknown>>;
    assert.deepEqual(
      arrivals.map((row) => row['challan_number_ext']),
      ['CH-ACCEPTED', 'CH-OPEN', 'CH-UNMATCHED'],
    );
    const open = arrivals.find((row) => row['challan_number_ext'] === 'CH-OPEN')!;
    assert.equal(open['has_accepted_weighment'], true);
    assert.equal(open['grn_id'], null);
    assert.equal(open['binding_token'], TOKEN_OPEN);
    assert.equal((open['po_summary'] as Record<string, unknown>)['po_ref_ext'], PO_REF);
    const accepted = arrivals.find((row) => row['challan_number_ext'] === 'CH-ACCEPTED')!;
    assert.equal(accepted['grn_id'], GRN_ID);
    const unmatched = arrivals.find((row) => row['challan_number_ext'] === 'CH-UNMATCHED')!;
    assert.equal(unmatched['binding_status'], 'unmatched');
    assert.equal(unmatched['has_accepted_weighment'], false);
  });

  it("AC2: a store assistant cannot read another site's arrivals", async () => {
    const res = await makeRequest(
      port,
      'GET',
      '/api/v1/receiving/arrivals?site=site-B',
      undefined,
      storeHeaders,
    );
    assert.strictEqual(res.status, 403, JSON.stringify(res.body));
    assert.equal(res.body['error_code'], 'LOCATION_ACCESS_DENIED');
  });

  it('AC2: site is required', async () => {
    const res = await makeRequest(
      port,
      'GET',
      '/api/v1/receiving/arrivals',
      undefined,
      storeHeaders,
    );
    assert.strictEqual(res.status, 400, JSON.stringify(res.body));
  });

  it('AC8: GET /grns/:id returns the inspect-on-opening fields per line', async () => {
    const res = await makeRequest(port, 'GET', `/api/v1/grns/${GRN_ID}`, undefined, storeHeaders);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    const line = (res.body['lines'] as Array<Record<string, unknown>>)[0]!;
    assert.equal(line['inspect_on_opening'], 'observed');
    assert.equal(line['inspect_note'], 'dent on the side');
    assert.equal(line['inspect_photo_ref'], 'photo-inspect');
    assert.equal(line['material_photo_ref'], 'photo-material');
  });

  it('AC8: inspect evidence without the toggle is refused', async () => {
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/grn-lines',
      {
        grn_id: randomUUID(),
        grn_line_id: randomUUID(),
        source_document: 'PO',
        po_ref_ext: PO_REF,
        line_no: 1,
        sku: 'SKU-3-14',
        received_qty: '1',
        uom: 'EA',
        correlation_id: TOKEN_OPEN,
        target_location_code: 'IB-01',
        inspect_note: 'not allowed without the toggle',
      },
      storeHeaders,
    );
    assert.strictEqual(res.status, 400, JSON.stringify(res.body));
    assert.equal(res.body['error_code'], 'RECEIVING_INSPECT_INVALID');
  });
});
