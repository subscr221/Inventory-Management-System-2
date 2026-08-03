import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request as httpRequest, type Server, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createAppRouter, createAppServer } from '../../src/server.js';
import { closePool, getPool, getAdminPool, closeAdminPool } from '../../src/config/db.js';
import { runDispatchCycle } from '../../src/notify/dispatch.js';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Story 4.4: purchase order management. Runs against the PRODUCTION router surface
// (createAppRouter) with real auth, RBAC, DOA resolution, and PostgreSQL. Tests run serially
// (npm test uses --test-concurrency=1) and seed their own users/DOA bands/suppliers for isolation.
// Issuing a PO flips its source indent to 'ordered', so every test that issues drafts from a
// FRESH approved indent (createApprovedIndent); draft-only tests share one seeded indent.

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCIM_HEADERS = { Authorization: 'Bearer test-only-scim-bearer-token-not-for-production-use' };
const run = randomUUID().slice(0, 8);

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

async function provisionUser(port: number, externalId: string, roles: Role[]): Promise<string> {
  const res = await makeRequest(
    port,
    'POST',
    '/api/v1/scim/v2/Users',
    { externalId, email: externalId, displayName: externalId, roles },
    SCIM_HEADERS,
  );
  assert.strictEqual(
    res.status,
    201,
    `provision ${externalId} failed: ${JSON.stringify(res.body)}`,
  );
  return (res.body as Record<string, string>)['userId']!;
}

async function authFor(port: number, sub: string): Promise<Record<string, string>> {
  const res = await makeRequest(port, 'POST', '/api/v1/auth/dev-token', { sub });
  assert.ok(
    res.status >= 200 && res.status < 300,
    `dev-token ${sub} failed: ${JSON.stringify(res.body)}`,
  );
  return { Authorization: `Bearer ${res.body['token'] as string}` };
}

describe('Story 4.4 Purchase Order Management Integration Tests', () => {
  let server: Server;
  let port: number;
  const siteA = randomUUID();
  let officerHeaders: Record<string, string>;
  let officerUserId: string;
  let deptHeadHeaders: Record<string, string>;
  let deptHeadUserId: string;
  let financeHeaders: Record<string, string>;
  let financeUserId: string;
  let requesterHeaders: Record<string, string>;
  let supplierId: string;
  let approvedIndentId: string;
  let tier1EntryId: string;
  let tier2EntryId: string;
  let indentSeq = 0;

  function draftBody(
    indentId: string,
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      indent_id: indentId,
      supplier_id: supplierId,
      po_type: 'standard',
      lines: [
        {
          sku: `SKU-44-${run}`,
          item_category: 'raw_materials',
          ordered_qty: 100,
          uom: 'KG',
          unit_price: 500,
        },
      ],
      ...overrides,
    };
  }

  /** Raises a fresh indent (unique SKU avoids the duplicate hold) and approves it. */
  async function createApprovedIndent(): Promise<string> {
    indentSeq += 1;
    const raiseRes = await makeRequest(
      port,
      'POST',
      '/api/v1/indents',
      {
        department_code: 'PROD',
        site_id: siteA,
        business_stream: 'production',
        need_by_date: '2026-12-01',
        urgent: false,
        lines: [
          {
            sku: `SKU-44-IND-${indentSeq}-${run}`,
            item_category: 'raw_materials',
            requested_qty: 100,
            uom: 'KG',
            unit_price_estimate: 500,
          },
        ],
      },
      requesterHeaders,
    );
    assert.strictEqual(raiseRes.status, 201, JSON.stringify(raiseRes.body));
    const indentId = (raiseRes.body['indent'] as Record<string, unknown>)['indent_id'] as string;
    const approveRes = await makeRequest(
      port,
      'POST',
      `/api/v1/indents/${indentId}/approve`,
      {},
      deptHeadHeaders,
    );
    assert.strictEqual(approveRes.status, 200, JSON.stringify(approveRes.body));
    return indentId;
  }

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
      '../../read/projections/notification.sql',
      '../../read/projections/supplier.sql',
      '../../read/projections/indent.sql',
      '../../read/projections/indent_line.sql',
      '../../read/projections/purchase_order.sql',
      '../../read/projections/purchase_order_line.sql',
      '../../read/projections/po_outbound_message.sql',
    ]) {
      await adminPool.query(readFileSync(resolve(__dirname, file), 'utf-8'));
    }
    await adminPool.query('ALTER TABLE audit_log DISABLE TRIGGER ALL');
    await adminPool.query('ALTER TABLE audit_log_tamper_attempt_log DISABLE TRIGGER ALL');
    await adminPool.query('ALTER TABLE audit_log_archive DISABLE TRIGGER ALL');
    try {
      await adminPool.query(
        'TRUNCATE po_outbound_message, purchase_order_line, purchase_order, indent_line, indent, supplier, notification_escalations, notification_escalation_defs, notification_deliveries, notification_dispatch_attempts, notification_dispatch_log, notifications, doa_vacation_delegations, doa_registry_entries, transaction_tagging_rules, audit_log_tamper_attempt_log, audit_log_archive, audit_log, user_role_assignments, users, domain_events CASCADE',
      );
    } finally {
      await adminPool.query('ALTER TABLE audit_log ENABLE TRIGGER ALL');
      await adminPool.query('ALTER TABLE audit_log_tamper_attempt_log ENABLE TRIGGER ALL');
      await adminPool.query('ALTER TABLE audit_log_archive ENABLE TRIGGER ALL');
    }

    server = createAppServer(createAppRouter());
    await new Promise<void>((resolvePromise, reject) => {
      server.once('error', reject);
      server.listen(0, () => {
        server.off('error', reject);
        port = (server.address() as AddressInfo).port;
        resolvePromise();
      });
    });

    officerUserId = await provisionUser(port, `officer-4-4-${run}@example.com`, [
      {
        role: 'procurement_officer_4_4',
        module: 'procurement',
        functionScope: 'write',
        locationId: siteA,
      },
    ]);
    officerHeaders = await authFor(port, `officer-4-4-${run}@example.com`);

    deptHeadUserId = await provisionUser(port, `approver-4-4-${run}@example.com`, [
      {
        role: 'department_head_4_4',
        module: 'procurement',
        functionScope: 'write',
        locationId: '*',
      },
    ]);
    deptHeadHeaders = await authFor(port, `approver-4-4-${run}@example.com`);

    financeUserId = await provisionUser(port, `finance-4-4-${run}@example.com`, [
      {
        role: 'finance_controller_4_4',
        module: 'procurement',
        functionScope: 'write',
        locationId: '*',
      },
    ]);
    financeHeaders = await authFor(port, `finance-4-4-${run}@example.com`);

    await provisionUser(port, `requester-4-4-${run}@example.com`, [
      {
        role: 'floor_supervisor',
        module: 'procurement',
        functionScope: 'write',
        locationId: siteA,
      },
    ]);
    requesterHeaders = await authFor(port, `requester-4-4-${run}@example.com`);

    await provisionUser(port, `doa-admin-4-4-${run}@example.com`, [
      {
        role: 'compliance_admin_4_4',
        module: 'compliance',
        functionScope: 'write',
        locationId: '*',
      },
    ]);
    const doaHeaders = await authFor(port, `doa-admin-4-4-${run}@example.com`);
    const entryIds: string[] = [];
    for (const entry of [
      { role: 'department_head_4_4', value_min: null, value_max: 50000 },
      { role: 'finance_controller_4_4', value_min: 50000, value_max: 200000 },
      { role: 'super_admin_4_4', value_min: 200000, value_max: null },
    ]) {
      const r = await makeRequest(
        port,
        'POST',
        '/api/v1/doa/entries',
        { transaction_type: 'purchase_order_approval', ...entry },
        doaHeaders,
      );
      assert.strictEqual(
        r.status,
        201,
        `DOA entry ${entry.role} failed: ${JSON.stringify(r.body)}`,
      );
      const created = r.body['entry'] as Record<string, unknown> | undefined;
      entryIds.push(
        (created?.['entry_id'] as string) ??
          ((r.body as Record<string, unknown>)['entry_id'] as string),
      );
    }
    tier1EntryId = entryIds[0]!;
    tier2EntryId = entryIds[1]!;

    await makeRequest(
      port,
      'POST',
      '/api/v1/doa/entries',
      {
        transaction_type: 'indent_approval',
        role: 'department_head_4_4',
        value_min: 0,
        value_max: 1000000,
      },
      doaHeaders,
    );

    const supplierRes = await makeRequest(
      port,
      'POST',
      '/api/v1/suppliers',
      {
        legal_name: `Test Supplier 4.4 ${run}`,
        owner_party_code: `OWNER-44-${run}`,
        gstin_ext: `29ABCDE1234F1Z5`,
        pan_ext: `ABCDE1234A`,
        contacts: [{ name: 'Contact', email: 'contact@example.com' }],
        credit_period_days: 30,
        commercial_terms: 'Net 30',
      },
      officerHeaders,
    );
    assert.strictEqual(supplierRes.status, 201, JSON.stringify(supplierRes.body));
    supplierId = (supplierRes.body['supplier'] as Record<string, unknown>)['supplier_id'] as string;

    const submitRes = await makeRequest(
      port,
      'POST',
      `/api/v1/suppliers/${supplierId}/onboarding/submit`,
      { documents: [{ type: 'registration', reference: 'REG-001', file_hash: 'abc123' }] },
      officerHeaders,
    );
    assert.strictEqual(submitRes.status, 200, JSON.stringify(submitRes.body));

    if (submitRes.body['requires_approval'] !== false) {
      const approveRes = await makeRequest(
        port,
        'POST',
        `/api/v1/suppliers/${supplierId}/onboarding/approve`,
        {},
        deptHeadHeaders,
      );
      assert.strictEqual(approveRes.status, 200, JSON.stringify(approveRes.body));
    }

    approvedIndentId = await createApprovedIndent();
  });

  after(async () => {
    if (server) await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    await closePool();
    await closeAdminPool();
  });

  // --- AC 1: Draft from approved requisition --------------------------------

  it('AC1: drafts a standard PO from an approved indent with the inherited business stream', async () => {
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/purchase-orders',
      draftBody(approvedIndentId),
      officerHeaders,
    );
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    // 100 x 500 = 50000 sits on the Tier 1 boundary (value_max inclusive), so approval routes
    // to the department head - the DOA bands seeded here cover every value, so no draft
    // auto-approves in this harness.
    assert.strictEqual(res.body['error_code'], 'APPROVAL_REQUIRED');
    const po = res.body['purchase_order'] as Record<string, unknown>;
    assert.ok(po, 'purchase_order should be present');
    assert.strictEqual(po['po_type'], 'standard');
    assert.strictEqual(po['indent_id'], approvedIndentId);
    assert.strictEqual(po['business_stream'], 'production');
    assert.strictEqual(po['status'], 'pending-approval');
    assert.strictEqual(po['total_value'], '50000.00');
    assert.strictEqual(po['approver_actor_id'], deptHeadUserId);
    assert.strictEqual(po['doa_entry_id'], tier1EntryId);
    assert.strictEqual(po['payment_terms'], 'Net 30');
    const lines = res.body['lines'] as Record<string, unknown>[];
    assert.strictEqual(lines.length, 1);
    assert.ok(lines[0], 'First line should exist');
    assert.strictEqual(lines[0]!['sku'], `SKU-44-${run}`);
    assert.strictEqual(lines[0]!['ordered_qty'], '100.000');
    assert.strictEqual(lines[0]!['unit_price'], '500.0000');
    assert.strictEqual(lines[0]!['line_value'], '50000.00');
  });

  it('AC1: drafting without lines defaults them from the indent lines (zero re-keying)', async () => {
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/purchase-orders',
      { indent_id: approvedIndentId, supplier_id: supplierId, po_type: 'standard' },
      officerHeaders,
    );
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    const lines = res.body['lines'] as Record<string, unknown>[];
    assert.strictEqual(lines.length, 1);
    assert.strictEqual(lines[0]!['sku'], `SKU-44-IND-1-${run}`);
    assert.strictEqual(lines[0]!['ordered_qty'], '100.000');
    assert.strictEqual(lines[0]!['unit_price'], '500.0000');
  });

  it('AC1: rejects drafting from an unapproved indent with PO_INDENT_NOT_APPROVED', async () => {
    const raiseRes = await makeRequest(
      port,
      'POST',
      '/api/v1/indents',
      {
        department_code: 'PROD',
        site_id: siteA,
        business_stream: 'production',
        need_by_date: '2026-12-01',
        lines: [
          {
            sku: `SKU-44-UNAPPROVED-${run}`,
            item_category: 'raw_materials',
            requested_qty: 10,
            uom: 'KG',
            unit_price_estimate: 100,
          },
        ],
      },
      requesterHeaders,
    );
    assert.strictEqual(raiseRes.status, 201, JSON.stringify(raiseRes.body));
    const unapprovedIndentId = (raiseRes.body['indent'] as Record<string, unknown>)[
      'indent_id'
    ] as string;

    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/purchase-orders',
      draftBody(unapprovedIndentId),
      officerHeaders,
    );
    assert.strictEqual(res.status, 409, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'PO_INDENT_NOT_APPROVED');
  });

  it('AC1: rejects drafting against an inactive supplier with SUPPLIER_NOT_ACTIVE', async () => {
    const inactiveSupplierRes = await makeRequest(
      port,
      'POST',
      '/api/v1/suppliers',
      {
        legal_name: `Inactive Supplier 4.4 ${run}`,
        owner_party_code: `OWNER-44-INACTIVE-${run}`,
        gstin_ext: `29INACT1234F1Z7`,
        pan_ext: `INACT1234Z`,
        contacts: [{ name: 'Contact', email: 'contact@example.com' }],
        credit_period_days: 30,
      },
      officerHeaders,
    );
    assert.strictEqual(inactiveSupplierRes.status, 201, JSON.stringify(inactiveSupplierRes.body));
    const inactiveSupplierId = (inactiveSupplierRes.body['supplier'] as Record<string, unknown>)[
      'supplier_id'
    ] as string;

    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/purchase-orders',
      draftBody(approvedIndentId, { supplier_id: inactiveSupplierId }),
      officerHeaders,
    );
    assert.strictEqual(res.status, 409, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'SUPPLIER_NOT_ACTIVE');
  });

  // --- AC 2: DOA-resolved approval ------------------------------------------

  it('AC2: a high-value PO resolves to the Tier 2 authority (exact boundary math)', async () => {
    // Exactly 200000 (1 x 200000) -> Tier 2 boundary (value_max inclusive) -> finance controller
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/purchase-orders',
      draftBody(approvedIndentId, {
        lines: [
          {
            sku: `SKU-44-T2B-${run}`,
            item_category: 'capital_equipment',
            ordered_qty: 1,
            uom: 'EA',
            unit_price: 200000,
          },
        ],
      }),
      officerHeaders,
    );
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'APPROVAL_REQUIRED');
    const po = res.body['purchase_order'] as Record<string, unknown>;
    assert.strictEqual(po['status'], 'pending-approval');
    assert.strictEqual(po['total_value'], '200000.00');
    assert.strictEqual(po['approver_actor_id'], financeUserId);
    assert.strictEqual(po['doa_entry_id'], tier2EntryId);
  });

  it('AC2: rejects issuing a pending-approval PO with APPROVAL_REQUIRED', async () => {
    const draftRes = await makeRequest(
      port,
      'POST',
      '/api/v1/purchase-orders',
      draftBody(approvedIndentId, {
        lines: [
          {
            sku: `SKU-44-PENDING-${run}`,
            item_category: 'capital_equipment',
            ordered_qty: 1,
            uom: 'EA',
            unit_price: 75000,
          },
        ],
      }),
      officerHeaders,
    );
    assert.strictEqual(draftRes.status, 201, JSON.stringify(draftRes.body));
    const poId = (draftRes.body['purchase_order'] as Record<string, unknown>)['po_id'] as string;

    const issueRes = await makeRequest(
      port,
      'POST',
      `/api/v1/purchase-orders/${poId}/issue`,
      {},
      officerHeaders,
    );
    assert.strictEqual(issueRes.status, 409, JSON.stringify(issueRes.body));
    assert.strictEqual(issueRes.body['error_code'], 'APPROVAL_REQUIRED');
  });

  // --- AC 6: Compliance seam enforcement (SOD, resolved approver) -----------

  it('AC6: rejects approval by the PO creator with PO_CREATOR_CANNOT_APPROVE', async () => {
    const draftRes = await makeRequest(
      port,
      'POST',
      '/api/v1/purchase-orders',
      draftBody(approvedIndentId, {
        lines: [
          {
            sku: `SKU-44-SOD-${run}`,
            item_category: 'raw_materials',
            ordered_qty: 10,
            uom: 'KG',
            unit_price: 1000,
          },
        ],
      }),
      officerHeaders,
    );
    assert.strictEqual(draftRes.status, 201, JSON.stringify(draftRes.body));
    const poId = (draftRes.body['purchase_order'] as Record<string, unknown>)['po_id'] as string;

    const approveRes = await makeRequest(
      port,
      'POST',
      `/api/v1/purchase-orders/${poId}/approve`,
      {},
      officerHeaders,
    );
    assert.strictEqual(approveRes.status, 403, JSON.stringify(approveRes.body));
    assert.strictEqual(approveRes.body['error_code'], 'PO_CREATOR_CANNOT_APPROVE');
  });

  it('AC6: a writer who is not the DOA-resolved approver gets NOT_RESOLVED_APPROVER', async () => {
    // 10 x 1000 = 10000 -> Tier 1 -> department head; the finance controller is not resolved.
    const draftRes = await makeRequest(
      port,
      'POST',
      '/api/v1/purchase-orders',
      draftBody(approvedIndentId, {
        lines: [
          {
            sku: `SKU-44-NRA-${run}`,
            item_category: 'raw_materials',
            ordered_qty: 10,
            uom: 'KG',
            unit_price: 1000,
          },
        ],
      }),
      officerHeaders,
    );
    assert.strictEqual(draftRes.status, 201, JSON.stringify(draftRes.body));
    const poId = (draftRes.body['purchase_order'] as Record<string, unknown>)['po_id'] as string;

    const approveRes = await makeRequest(
      port,
      'POST',
      `/api/v1/purchase-orders/${poId}/approve`,
      {},
      financeHeaders,
    );
    assert.strictEqual(approveRes.status, 403, JSON.stringify(approveRes.body));
    assert.strictEqual(approveRes.body['error_code'], 'NOT_RESOLVED_APPROVER');
  });

  it('AC6: the tagging gate rejects a drafted event without business_stream (UNTAGGED_TRANSACTION)', async () => {
    // purchase_order.drafted is registered requiresBusinessStream: true, so the seam-level
    // FR-AC-01 gate rejects an untagged direct event before any write.
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/events',
      {
        stream_type: 'procurement',
        stream_id: randomUUID(),
        event_type: 'purchase_order.drafted',
        payload: {
          po_id: randomUUID(),
          po_type: 'standard',
          supplier_id: supplierId,
          indent_id: approvedIndentId,
          site_id: siteA,
          lines: [
            {
              sku: `SKU-44-UNTAGGED-${run}`,
              item_category: 'raw_materials',
              ordered_qty: 1,
              uom: 'KG',
              unit_price: 100,
            },
          ],
        },
        metadata: {
          correlation_id: randomUUID(),
          actor: { user_id: officerUserId, role: 'procurement_officer_4_4', location_id: siteA },
          occurred_at: new Date().toISOString(),
        },
      },
      officerHeaders,
    );
    assert.strictEqual(res.status, 400, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'UNTAGGED_TRANSACTION');
  });

  // --- AC 2 / AC 4 notifications --------------------------------------------

  it('AC2/AC4: approval request notifies the resolved approver, the decision notifies the creator', async () => {
    const draftRes = await makeRequest(
      port,
      'POST',
      '/api/v1/purchase-orders',
      draftBody(approvedIndentId, {
        lines: [
          {
            sku: `SKU-44-NOTIFY-${run}`,
            item_category: 'raw_materials',
            ordered_qty: 10,
            uom: 'KG',
            unit_price: 100,
          },
        ],
      }),
      officerHeaders,
    );
    assert.strictEqual(draftRes.status, 201, JSON.stringify(draftRes.body));
    const poId = (draftRes.body['purchase_order'] as Record<string, unknown>)['po_id'] as string;

    const requestNotice = await getPool().query(
      `SELECT payload FROM domain_events
       WHERE stream_type = 'notification' AND event_type = 'notification.created'
         AND payload->>'object_id' = $1 AND payload->>'event_type' = 'po_approval_request'`,
      [poId],
    );
    assert.strictEqual(requestNotice.rows.length, 1);
    const requestPayload = requestNotice.rows[0]!['payload'] as Record<string, unknown>;
    assert.strictEqual(
      (requestPayload['target'] as Record<string, unknown>)['user_id'],
      deptHeadUserId,
    );

    const approveRes = await makeRequest(
      port,
      'POST',
      `/api/v1/purchase-orders/${poId}/approve`,
      {},
      deptHeadHeaders,
    );
    assert.strictEqual(approveRes.status, 200, JSON.stringify(approveRes.body));

    const decisionNotice = await getPool().query(
      `SELECT payload FROM domain_events
       WHERE stream_type = 'notification' AND event_type = 'notification.created'
         AND payload->>'object_id' = $1 AND payload->>'event_type' = 'po_decision'`,
      [poId],
    );
    assert.strictEqual(decisionNotice.rows.length, 1);
    const decisionPayload = decisionNotice.rows[0]!['payload'] as Record<string, unknown>;
    assert.strictEqual(
      (decisionPayload['target'] as Record<string, unknown>)['user_id'],
      officerUserId,
    );
    assert.strictEqual(decisionPayload['status_verb'], 'approved');

    // user_id targeting delivers exactly one row per notice (the 4.1 broadcast gap stays closed).
    await runDispatchCycle();
    const delivered = await getPool().query(
      `SELECT target_user_id FROM notifications WHERE object_id = $1 ORDER BY created_at ASC`,
      [poId],
    );
    assert.strictEqual(delivered.rows.length, 2);
    const targets = delivered.rows.map((r) => r['target_user_id']);
    assert.ok(targets.includes(deptHeadUserId));
    assert.ok(targets.includes(officerUserId));

    // Double-approve returns PO_ALREADY_DECIDED.
    const again = await makeRequest(
      port,
      'POST',
      `/api/v1/purchase-orders/${poId}/approve`,
      {},
      deptHeadHeaders,
    );
    assert.strictEqual(again.status, 409, JSON.stringify(again.body));
    assert.strictEqual(again.body['error_code'], 'PO_ALREADY_DECIDED');
  });

  it('AC2: rejection requires a reason and records it', async () => {
    const draftRes = await makeRequest(
      port,
      'POST',
      '/api/v1/purchase-orders',
      draftBody(approvedIndentId, {
        lines: [
          {
            sku: `SKU-44-REJ-${run}`,
            item_category: 'raw_materials',
            ordered_qty: 10,
            uom: 'KG',
            unit_price: 100,
          },
        ],
      }),
      officerHeaders,
    );
    assert.strictEqual(draftRes.status, 201, JSON.stringify(draftRes.body));
    const poId = (draftRes.body['purchase_order'] as Record<string, unknown>)['po_id'] as string;

    const noReason = await makeRequest(
      port,
      'POST',
      `/api/v1/purchase-orders/${poId}/reject`,
      {},
      deptHeadHeaders,
    );
    assert.strictEqual(noReason.status, 400, JSON.stringify(noReason.body));
    assert.strictEqual(noReason.body['error_code'], 'PO_REJECTION_REASON_REQUIRED');

    const rejectRes = await makeRequest(
      port,
      'POST',
      `/api/v1/purchase-orders/${poId}/reject`,
      { rejection_reason: 'Budget exhausted' },
      deptHeadHeaders,
    );
    assert.strictEqual(rejectRes.status, 200, JSON.stringify(rejectRes.body));
    const po = rejectRes.body['purchase_order'] as Record<string, unknown>;
    assert.strictEqual(po['status'], 'rejected');
    assert.strictEqual(po['rejection_reason'], 'Budget exhausted');
  });

  // --- AC 3: Issue through ERP adapter --------------------------------------

  it('AC3: approve + issue writes po_outbound_message and flips the indent to ordered with the PO id', async () => {
    const indentId = await createApprovedIndent();
    const draftRes = await makeRequest(
      port,
      'POST',
      '/api/v1/purchase-orders',
      draftBody(indentId, {
        lines: [
          {
            sku: `SKU-44-ISSUE-${run}`,
            item_category: 'raw_materials',
            ordered_qty: 50,
            uom: 'KG',
            unit_price: 400,
            tax_rate_pct: 18,
          },
        ],
      }),
      officerHeaders,
    );
    assert.strictEqual(draftRes.status, 201, JSON.stringify(draftRes.body));
    const poId = (draftRes.body['purchase_order'] as Record<string, unknown>)['po_id'] as string;
    const poNumber = (draftRes.body['purchase_order'] as Record<string, unknown>)[
      'po_number_ext'
    ] as string;
    assert.match(poNumber, /^PO-\d{4}-\d{4,}$/);

    const approveRes = await makeRequest(
      port,
      'POST',
      `/api/v1/purchase-orders/${poId}/approve`,
      {},
      deptHeadHeaders,
    );
    assert.strictEqual(approveRes.status, 200, JSON.stringify(approveRes.body));
    const approvedPo = approveRes.body['purchase_order'] as Record<string, unknown>;
    assert.strictEqual(approvedPo['status'], 'approved');

    const issueRes = await makeRequest(
      port,
      'POST',
      `/api/v1/purchase-orders/${poId}/issue`,
      {},
      officerHeaders,
    );
    assert.strictEqual(issueRes.status, 200, JSON.stringify(issueRes.body));
    const issuedPo = issueRes.body['purchase_order'] as Record<string, unknown>;
    assert.strictEqual(issuedPo['status'], 'issued');
    assert.ok(issuedPo['issued_at'], 'issued_at should be stamped');

    // AC3 is verified against the adapter's recorded outbound payload, not a live ERP.
    const pool = getPool();
    const outboundResult = await pool.query(
      'SELECT payload FROM po_outbound_message WHERE po_id = $1',
      [poId],
    );
    assert.strictEqual(outboundResult.rows.length, 1, 'po_outbound_message should be written');
    const payload = outboundResult.rows[0]!['payload'] as Record<string, unknown>;
    assert.strictEqual(payload['po_number_ext'], poNumber);
    assert.strictEqual(payload['po_type'], 'standard');
    assert.strictEqual(payload['business_stream'], 'production');
    assert.strictEqual(payload['currency'], 'INR');
    assert.strictEqual(payload['total_value'], '20000.00');
    // The supplier seam normalizes owner_party_code to uppercase at registration.
    assert.strictEqual(
      (payload['supplier'] as Record<string, unknown>)['owner_party_code'],
      `OWNER-44-${run}`.toUpperCase(),
    );
    assert.ok(payload['issued_at']);
    const lines = payload['lines'] as Record<string, unknown>[];
    assert.strictEqual(lines.length, 1);
    assert.ok(lines[0], 'First line should exist');
    assert.strictEqual(lines[0]!['sku'], `SKU-44-ISSUE-${run}`);
    assert.strictEqual(lines[0]!['ordered_qty'], '50.000');
    assert.strictEqual(lines[0]!['unit_price'], '400.0000');
    assert.strictEqual(lines[0]!['tax_rate_pct'], '18.00');
    assert.strictEqual(lines[0]!['line_value'], '20000.00');

    const indentResult = await pool.query(
      'SELECT status, purchase_order_id FROM indent WHERE indent_id = $1',
      [indentId],
    );
    assert.strictEqual(indentResult.rows[0]!['status'], 'ordered');
    assert.strictEqual(indentResult.rows[0]!['purchase_order_id'], poId);
  });

  // --- AC 4: Supplier confirmation ------------------------------------------

  it('AC4: confirm stamps the promised date on the PO, its lines, and the linked indent', async () => {
    const indentId = await createApprovedIndent();
    const draftRes = await makeRequest(
      port,
      'POST',
      '/api/v1/purchase-orders',
      draftBody(indentId, {
        lines: [
          {
            sku: `SKU-44-CONFIRM-${run}`,
            item_category: 'raw_materials',
            ordered_qty: 20,
            uom: 'KG',
            unit_price: 300,
          },
        ],
      }),
      officerHeaders,
    );
    assert.strictEqual(draftRes.status, 201, JSON.stringify(draftRes.body));
    const poId = (draftRes.body['purchase_order'] as Record<string, unknown>)['po_id'] as string;

    await makeRequest(port, 'POST', `/api/v1/purchase-orders/${poId}/approve`, {}, deptHeadHeaders);
    await makeRequest(port, 'POST', `/api/v1/purchase-orders/${poId}/issue`, {}, officerHeaders);

    const confirmRes = await makeRequest(
      port,
      'POST',
      `/api/v1/purchase-orders/${poId}/confirm`,
      { promised_delivery_date: '2026-11-15' },
      officerHeaders,
    );
    assert.strictEqual(confirmRes.status, 200, JSON.stringify(confirmRes.body));
    const confirmedPo = confirmRes.body['purchase_order'] as Record<string, unknown>;
    assert.strictEqual(confirmedPo['status'], 'confirmed');
    assert.ok(confirmedPo['confirmed_at'], 'confirmed_at should be stamped');

    // node-postgres parses DATE at local midnight; assert calendar dates via ::text.
    const pool = getPool();
    const headerDate = await pool.query(
      'SELECT promised_delivery_date::text AS d FROM purchase_order WHERE po_id = $1',
      [poId],
    );
    assert.strictEqual(headerDate.rows[0]!['d'], '2026-11-15');
    const lineDate = await pool.query(
      'SELECT promised_delivery_date::text AS d FROM purchase_order_line WHERE po_id = $1',
      [poId],
    );
    assert.strictEqual(lineDate.rows[0]!['d'], '2026-11-15');

    // Feeds the Story 4.2 responsiveness metric: the requisition shows the expected date.
    const indentDate = await pool.query(
      'SELECT expected_delivery_date::text AS d, status FROM indent WHERE indent_id = $1',
      [indentId],
    );
    assert.strictEqual(indentDate.rows[0]!['status'], 'ordered');
    assert.strictEqual(indentDate.rows[0]!['d'], '2026-11-15');
  });

  it('AC4: rejects invalid promised delivery calendar dates', async () => {
    const indentId = await createApprovedIndent();
    const draftRes = await makeRequest(
      port,
      'POST',
      '/api/v1/purchase-orders',
      draftBody(indentId, {
        lines: [
          {
            sku: `SKU-44-BADDATE-${run}`,
            item_category: 'raw_materials',
            ordered_qty: 10,
            uom: 'KG',
            unit_price: 200,
          },
        ],
      }),
      officerHeaders,
    );
    assert.strictEqual(draftRes.status, 201, JSON.stringify(draftRes.body));
    const poId = (draftRes.body['purchase_order'] as Record<string, unknown>)['po_id'] as string;

    await makeRequest(port, 'POST', `/api/v1/purchase-orders/${poId}/approve`, {}, deptHeadHeaders);
    await makeRequest(port, 'POST', `/api/v1/purchase-orders/${poId}/issue`, {}, officerHeaders);

    const confirmRes = await makeRequest(
      port,
      'POST',
      `/api/v1/purchase-orders/${poId}/confirm`,
      { promised_delivery_date: '2026-02-31' },
      officerHeaders,
    );
    assert.strictEqual(confirmRes.status, 400, JSON.stringify(confirmRes.body));
    assert.strictEqual(confirmRes.body['error_code'], 'INVALID_PARAMS');
  });

  it('AC4: rejects confirming a non-issued PO with PO_NOT_ISSUED', async () => {
    const draftRes = await makeRequest(
      port,
      'POST',
      '/api/v1/purchase-orders',
      draftBody(approvedIndentId, {
        lines: [
          {
            sku: `SKU-44-NOTISSUED-${run}`,
            item_category: 'raw_materials',
            ordered_qty: 10,
            uom: 'KG',
            unit_price: 200,
          },
        ],
      }),
      officerHeaders,
    );
    assert.strictEqual(draftRes.status, 201, JSON.stringify(draftRes.body));
    const poId = (draftRes.body['purchase_order'] as Record<string, unknown>)['po_id'] as string;

    const confirmRes = await makeRequest(
      port,
      'POST',
      `/api/v1/purchase-orders/${poId}/confirm`,
      { promised_delivery_date: '2026-11-20' },
      officerHeaders,
    );
    assert.strictEqual(confirmRes.status, 409, JSON.stringify(confirmRes.body));
    assert.strictEqual(confirmRes.body['error_code'], 'PO_NOT_ISSUED');
  });

  // --- AC 5: Ceiling enforcement for blanket/contract -----------------------

  it('AC5: enforces the ceiling on releases and requires fresh DOA approval to revise it', async () => {
    const indentId = await createApprovedIndent();
    const draftRes = await makeRequest(
      port,
      'POST',
      '/api/v1/purchase-orders',
      draftBody(indentId, { po_type: 'blanket', ceiling_value: 100000 }),
      officerHeaders,
    );
    assert.strictEqual(draftRes.status, 201, JSON.stringify(draftRes.body));
    const poId = (draftRes.body['purchase_order'] as Record<string, unknown>)['po_id'] as string;
    const blanketPo = draftRes.body['purchase_order'] as Record<string, unknown>;
    assert.strictEqual(blanketPo['ceiling_value'], '100000.00');

    const earlyRelease = await makeRequest(
      port,
      'POST',
      `/api/v1/purchase-orders/${poId}/releases`,
      { release_value: 1, release_reference: `REL-EARLY-${run}` },
      officerHeaders,
    );
    assert.strictEqual(earlyRelease.status, 409, JSON.stringify(earlyRelease.body));
    assert.strictEqual(earlyRelease.body['error_code'], 'PO_NOT_ISSUED');

    await makeRequest(port, 'POST', `/api/v1/purchase-orders/${poId}/approve`, {}, deptHeadHeaders);
    await makeRequest(port, 'POST', `/api/v1/purchase-orders/${poId}/issue`, {}, officerHeaders);

    const release1Res = await makeRequest(
      port,
      'POST',
      `/api/v1/purchase-orders/${poId}/releases`,
      { release_value: 60000, release_reference: `REL-1-${run}` },
      officerHeaders,
    );
    assert.strictEqual(release1Res.status, 200, JSON.stringify(release1Res.body));
    const released1Po = release1Res.body['purchase_order'] as Record<string, unknown>;
    assert.strictEqual(released1Po['released_value'], '60000.00');

    const duplicateRelease = await makeRequest(
      port,
      'POST',
      `/api/v1/purchase-orders/${poId}/releases`,
      { release_value: 1, release_reference: `REL-1-${run}` },
      officerHeaders,
    );
    assert.strictEqual(duplicateRelease.status, 409, JSON.stringify(duplicateRelease.body));
    assert.strictEqual(duplicateRelease.body['error_code'], 'DUPLICATE_EVENT');

    const release2Res = await makeRequest(
      port,
      'POST',
      `/api/v1/purchase-orders/${poId}/releases`,
      { release_value: 50000, release_reference: `REL-2-${run}` },
      officerHeaders,
    );
    assert.strictEqual(release2Res.status, 409, JSON.stringify(release2Res.body));
    assert.strictEqual(release2Res.body['error_code'], 'PO_CEILING_EXCEEDED');

    const lowerCeiling = await makeRequest(
      port,
      'POST',
      `/api/v1/purchase-orders/${poId}/ceiling`,
      { new_ceiling_value: 50000 },
      deptHeadHeaders,
    );
    assert.strictEqual(lowerCeiling.status, 409, JSON.stringify(lowerCeiling.body));
    assert.strictEqual(lowerCeiling.body['error_code'], 'PO_CEILING_EXCEEDED');

    // The revision is itself the DOA-gated approval act (AC5): the creator is blocked by SOD,
    // a non-resolved authority is blocked, and the Tier 2 authority for the NEW value succeeds.
    const officerRevise = await makeRequest(
      port,
      'POST',
      `/api/v1/purchase-orders/${poId}/ceiling`,
      { new_ceiling_value: 200000 },
      officerHeaders,
    );
    assert.strictEqual(officerRevise.status, 403, JSON.stringify(officerRevise.body));
    assert.strictEqual(officerRevise.body['error_code'], 'PO_CREATOR_CANNOT_APPROVE');

    const deptHeadRevise = await makeRequest(
      port,
      'POST',
      `/api/v1/purchase-orders/${poId}/ceiling`,
      { new_ceiling_value: 200000 },
      deptHeadHeaders,
    );
    assert.strictEqual(deptHeadRevise.status, 403, JSON.stringify(deptHeadRevise.body));
    assert.strictEqual(deptHeadRevise.body['error_code'], 'NOT_RESOLVED_APPROVER');

    const reviseRes = await makeRequest(
      port,
      'POST',
      `/api/v1/purchase-orders/${poId}/ceiling`,
      { new_ceiling_value: 200000 },
      financeHeaders,
    );
    assert.strictEqual(reviseRes.status, 200, JSON.stringify(reviseRes.body));
    const revisedPo = reviseRes.body['purchase_order'] as Record<string, unknown>;
    assert.strictEqual(revisedPo['ceiling_value'], '200000.00');
    assert.strictEqual(revisedPo['approver_actor_id'], financeUserId);

    const release3Res = await makeRequest(
      port,
      'POST',
      `/api/v1/purchase-orders/${poId}/releases`,
      { release_value: 50000, release_reference: `REL-3-${run}` },
      officerHeaders,
    );
    assert.strictEqual(release3Res.status, 200, JSON.stringify(release3Res.body));
    const released3Po = release3Res.body['purchase_order'] as Record<string, unknown>;
    assert.strictEqual(released3Po['released_value'], '110000.00');
  });

  it('AC5: rejects drafting a blanket PO without ceiling_value with PO_CEILING_REQUIRED', async () => {
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/purchase-orders',
      draftBody(approvedIndentId, { po_type: 'blanket' }),
      officerHeaders,
    );
    assert.strictEqual(res.status, 400, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'PO_CEILING_REQUIRED');

    const nullRes = await makeRequest(
      port,
      'POST',
      '/api/v1/purchase-orders',
      draftBody(approvedIndentId, { po_type: 'blanket', ceiling_value: null }),
      officerHeaders,
    );
    assert.strictEqual(nullRes.status, 400, JSON.stringify(nullRes.body));
    assert.strictEqual(nullRes.body['error_code'], 'PO_CEILING_REQUIRED');
  });

  // --- Idempotency and replay -----------------------------------------------

  it('replays a duplicate purchase_order.drafted event without creating a second PO', async () => {
    const indentId = await createApprovedIndent();
    const poId = randomUUID();
    const eventId = randomUUID();
    const envelope = {
      stream_type: 'procurement',
      stream_id: poId,
      event_type: 'purchase_order.drafted',
      event_id: eventId,
      payload: {
        po_id: poId,
        po_type: 'standard',
        supplier_id: supplierId,
        indent_id: indentId,
        site_id: siteA,
        business_stream: 'production',
        lines: [
          {
            sku: `SKU-44-REPLAY-${run}`,
            item_category: 'raw_materials',
            ordered_qty: 10,
            uom: 'KG',
            unit_price: 100,
          },
        ],
      },
      metadata: {
        correlation_id: randomUUID(),
        actor: { user_id: officerUserId, role: 'procurement_officer_4_4', location_id: siteA },
        occurred_at: new Date().toISOString(),
      },
    };

    const first = await makeRequest(port, 'POST', '/api/v1/events', envelope, officerHeaders);
    assert.strictEqual(first.status, 201, JSON.stringify(first.body));

    // Story 3-10 idempotent-replay decision: the replay surface may answer 201 (silent no-op)
    // or 409 (DUPLICATE_EVENT); the pinned invariant is the row count.
    const replay = await makeRequest(port, 'POST', '/api/v1/events', envelope, officerHeaders);
    assert.ok([201, 409].includes(replay.status), `Replay: ${JSON.stringify(replay.body)}`);

    const pool = getPool();
    const poCount = await pool.query(
      'SELECT count(*)::int AS c FROM purchase_order WHERE po_id = $1',
      [poId],
    );
    assert.strictEqual(poCount.rows[0]!['c'], 1, 'Only one PO row should exist');
    const lineCount = await pool.query(
      'SELECT count(*)::int AS c FROM purchase_order_line WHERE po_id = $1',
      [poId],
    );
    assert.strictEqual(lineCount.rows[0]!['c'], 1, 'Only one PO line should exist');
  });
});
