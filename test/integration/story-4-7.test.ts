import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { request as httpRequest, type Server, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createAppRouter, createAppServer } from '../../src/server.js';
import { closePool, getAdminPool, closeAdminPool } from '../../src/config/db.js';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Story 4.7: Supplier Invoice Capture. Runs against the PRODUCTION router surface
// (createAppRouter) with real auth, RBAC, and PostgreSQL. Tests run serially (npm test uses
// --test-concurrency=1) and seed their own users/supplier/PO fixtures for isolation.
//
// Story 4.6 (MSME registration) is NOT implemented in this codebase. AC5 therefore stays an
// explicit blocked dependency (Task 7.4/Dev Notes): every assertion here pins
// msme_classification_at_capture/statutory_due_date/statutory_due_rule_version to null rather
// than fabricating MSME status. Story 4.5 (three-way match) is likewise not implemented, so its
// SOURCE_DOCUMENT_REQUIRED consumer check stays a documented, visibly-blocked gap.

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

function sha256Hex(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

describe('Story 4.7 Supplier Invoice Capture Integration Tests', () => {
  let server: Server;
  let port: number;
  const siteA = randomUUID();
  let officerHeaders: Record<string, string>;
  let deptHeadHeaders: Record<string, string>;
  let overrideHeaders: Record<string, string>;
  let requesterHeaders: Record<string, string>;
  let readerHeaders: Record<string, string>;
  let supplierId: string;
  let supplierGstin: string;
  let indentSeq = 0;
  // Task 3.5 (review patch): a PO-backed manual capture must anchor EVERY line to a po_line_id
  // on that PO, so captureBody looks the issued PO's line up here by po_id.
  const poLineIndex = new Map<string, { sku: string; poLineId: string }>();

  async function createApprovedIndent(sku: string): Promise<string> {
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
            sku: `${sku}-${indentSeq}`,
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

  /** Drafts, approves, and issues a native PO against a fresh approved indent. */
  async function createIssuedPo(
    skuPrefix: string,
    lineOverrides: Record<string, unknown> = {},
  ): Promise<{ poId: string; lineSku: string; poLineId: string }> {
    const sku = `SKU-47-${skuPrefix}-${run}`;
    const indentId = await createApprovedIndent(sku);
    const draftRes = await makeRequest(
      port,
      'POST',
      '/api/v1/purchase-orders',
      {
        indent_id: indentId,
        supplier_id: supplierId,
        po_type: 'standard',
        lines: [
          {
            sku,
            item_category: 'raw_materials',
            ordered_qty: 100,
            uom: 'KG',
            unit_price: 500,
            ...lineOverrides,
          },
        ],
      },
      officerHeaders,
    );
    assert.strictEqual(draftRes.status, 201, JSON.stringify(draftRes.body));
    const po = draftRes.body['purchase_order'] as Record<string, unknown>;
    const poId = po['po_id'] as string;
    if (po['status'] === 'pending-approval') {
      const approveRes = await makeRequest(
        port,
        'POST',
        `/api/v1/purchase-orders/${poId}/approve`,
        {},
        deptHeadHeaders,
      );
      assert.strictEqual(approveRes.status, 200, JSON.stringify(approveRes.body));
    }
    const issueRes = await makeRequest(
      port,
      'POST',
      `/api/v1/purchase-orders/${poId}/issue`,
      {},
      officerHeaders,
    );
    assert.strictEqual(issueRes.status, 200, JSON.stringify(issueRes.body));
    const issuedLines = draftRes.body['lines'] as Record<string, unknown>[];
    const poLineId = issuedLines[0]!['po_line_id'] as string;
    poLineIndex.set(poId, { sku, poLineId });
    return { poId, lineSku: sku, poLineId };
  }

  function captureBody(
    poId: string,
    invoiceNumberExt: string,
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    const poLine = poLineIndex.get(poId);
    return {
      supplier_id: supplierId,
      invoice_number_ext: invoiceNumberExt,
      invoice_date: '2026-06-15',
      po_id: poId,
      currency: 'INR',
      lines: [
        {
          po_line_id: poLine?.poLineId,
          sku: overrides['sku'] ?? poLine?.sku ?? `SKU-47-CAP-${run}`,
          quantity: 10,
          uom: 'KG',
          unit_price: 500,
          taxable_value: 5000,
          cgst_amount: 450,
          sgst_amount: 450,
          line_total: 5900,
        },
      ],
      subtotal: 5000,
      cgst_total: 450,
      sgst_total: 450,
      total_value: 5900,
      ...overrides,
    };
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
      '../../read/projections/supplier_invoice.sql',
      '../../read/projections/supplier_invoice_line.sql',
      '../../read/projections/supplier_invoice_ingestion.sql',
    ]) {
      await adminPool.query(readFileSync(resolve(__dirname, file), 'utf-8'));
    }
    await adminPool.query('ALTER TABLE audit_log DISABLE TRIGGER ALL');
    await adminPool.query('ALTER TABLE audit_log_tamper_attempt_log DISABLE TRIGGER ALL');
    await adminPool.query('ALTER TABLE audit_log_archive DISABLE TRIGGER ALL');
    try {
      await adminPool.query(
        'TRUNCATE supplier_invoice_line, supplier_invoice_ingestion, supplier_invoice, po_outbound_message, purchase_order_line, purchase_order, indent_line, indent, supplier, notification_escalations, notification_escalation_defs, notification_deliveries, notification_dispatch_attempts, notification_dispatch_log, notifications, doa_vacation_delegations, doa_registry_entries, transaction_tagging_rules, audit_log_tamper_attempt_log, audit_log_archive, audit_log, user_role_assignments, users, domain_events CASCADE',
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

    await provisionUser(port, `officer-4-7-${run}@example.com`, [
      {
        role: 'procurement_officer_4_7',
        module: 'procurement',
        functionScope: 'write',
        locationId: siteA,
      },
    ]);
    officerHeaders = await authFor(port, `officer-4-7-${run}@example.com`);

    await provisionUser(port, `approver-4-7-${run}@example.com`, [
      {
        role: 'department_head_4_7',
        module: 'procurement',
        functionScope: 'write',
        locationId: '*',
      },
    ]);
    deptHeadHeaders = await authFor(port, `approver-4-7-${run}@example.com`);

    await provisionUser(port, `override-4-7-${run}@example.com`, [
      {
        role: 'ap_override_officer_4_7',
        module: 'procurement',
        functionScope: 'write',
        locationId: siteA,
      },
      {
        role: 'ap_override_officer_4_7',
        module: 'procurement.duplicate-override',
        functionScope: 'write',
        locationId: siteA,
      },
    ]);
    overrideHeaders = await authFor(port, `override-4-7-${run}@example.com`);

    await provisionUser(port, `requester-4-7-${run}@example.com`, [
      {
        role: 'floor_supervisor',
        module: 'procurement',
        functionScope: 'write',
        locationId: siteA,
      },
    ]);
    requesterHeaders = await authFor(port, `requester-4-7-${run}@example.com`);

    await provisionUser(port, `reader-4-7-${run}@example.com`, [
      {
        role: 'procurement_reader_4_7',
        module: 'procurement',
        functionScope: 'read',
        locationId: siteA,
      },
    ]);
    readerHeaders = await authFor(port, `reader-4-7-${run}@example.com`);

    await provisionUser(port, `doa-admin-4-7-${run}@example.com`, [
      {
        role: 'compliance_admin_4_7',
        module: 'compliance',
        functionScope: 'write',
        locationId: '*',
      },
    ]);
    const doaHeaders = await authFor(port, `doa-admin-4-7-${run}@example.com`);
    for (const entry of [
      {
        transaction_type: 'indent_approval',
        role: 'department_head_4_7',
        value_min: 0,
        value_max: null,
      },
      {
        transaction_type: 'purchase_order_approval',
        role: 'department_head_4_7',
        value_min: 0,
        value_max: null,
      },
    ]) {
      const r = await makeRequest(port, 'POST', '/api/v1/doa/entries', entry, doaHeaders);
      assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    }

    supplierGstin = '27AAACT2727Q1ZS';
    const supplierRes = await makeRequest(
      port,
      'POST',
      '/api/v1/suppliers',
      {
        legal_name: `Test Supplier 4.7 ${run}`,
        owner_party_code: `OWNER-47-${run}`,
        gstin_ext: supplierGstin,
        pan_ext: 'AAACT2727Q',
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
  });

  after(async () => {
    if (server) await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    await closePool();
    await closeAdminPool();
  });

  // --- AC1: manual capture against a native PO -------------------------------

  it('AC1: captures a manual invoice against an issued PO with derived business_stream and MSME fields left null', async () => {
    const { poId, lineSku, poLineId } = await createIssuedPo('AC1');
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/supplier-invoices',
      captureBody(poId, `INV-AC1-${run}`, {
        sku: lineSku,
        lines: [
          {
            po_line_id: poLineId,
            sku: lineSku,
            quantity: 10,
            uom: 'KG',
            unit_price: 500,
            taxable_value: 5000,
            cgst_amount: 450,
            sgst_amount: 450,
            line_total: 5900,
          },
        ],
      }),
      officerHeaders,
    );
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    const invoice = res.body['supplier_invoice'] as Record<string, unknown>;
    assert.strictEqual(invoice['status'], 'captured');
    assert.strictEqual(invoice['po_id'], poId);
    assert.strictEqual(invoice['business_stream'], 'production');
    assert.strictEqual(invoice['total_value'], '5900.00');
    assert.strictEqual(invoice['msme_classification_at_capture'], null);
    assert.strictEqual(invoice['statutory_due_date'], null);
    const lines = res.body['lines'] as Record<string, unknown>[];
    assert.strictEqual(lines.length, 1);
    assert.strictEqual(lines[0]!['po_line_id'], poLineId);
  });

  it('AC1/AC6: rejects a mismatched line total (NUMERIC arithmetic, not JS floats)', async () => {
    const { poId } = await createIssuedPo('AC1MISMATCH');
    const body = captureBody(poId, `INV-AC1B-${run}`);
    body['total_value'] = 9999.99;
    const res = await makeRequest(port, 'POST', '/api/v1/supplier-invoices', body, officerHeaders);
    assert.strictEqual(res.status, 400, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'INVOICE_TOTAL_MISMATCH');
  });

  it('AC1: rejects capture against a non-issued (draft) PO', async () => {
    const sku = `SKU-47-NOTISSUED-${run}`;
    const indentId = await createApprovedIndent(sku);
    const draftRes = await makeRequest(
      port,
      'POST',
      '/api/v1/purchase-orders',
      {
        indent_id: indentId,
        supplier_id: supplierId,
        po_type: 'standard',
        lines: [
          { sku, item_category: 'raw_materials', ordered_qty: 100, uom: 'KG', unit_price: 500 },
        ],
      },
      officerHeaders,
    );
    const poId = (draftRes.body['purchase_order'] as Record<string, unknown>)['po_id'] as string;
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/supplier-invoices',
      captureBody(poId, `INV-AC1C-${run}`),
      officerHeaders,
    );
    assert.strictEqual(res.status, 409, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'PO_NOT_ISSUED');
  });

  // --- AC3: duplicate blocking and evidenced override ------------------------

  it('AC3: blocks a same-grain duplicate with HTTP 409 DUPLICATE_EVENT and existing-invoice details', async () => {
    const { poId: poId1 } = await createIssuedPo('AC3A');
    const invoiceNumber = `INV-AC3-${run}`;
    const first = await makeRequest(
      port,
      'POST',
      '/api/v1/supplier-invoices',
      captureBody(poId1, invoiceNumber),
      officerHeaders,
    );
    assert.strictEqual(first.status, 201, JSON.stringify(first.body));
    const firstInvoiceId = (first.body['supplier_invoice'] as Record<string, unknown>)[
      'invoice_id'
    ];

    const { poId: poId2 } = await createIssuedPo('AC3B');
    const second = await makeRequest(
      port,
      'POST',
      '/api/v1/supplier-invoices',
      captureBody(poId2, invoiceNumber),
      officerHeaders,
    );
    assert.strictEqual(second.status, 409, JSON.stringify(second.body));
    assert.strictEqual(second.body['error_code'], 'DUPLICATE_EVENT');
    assert.strictEqual(
      (second.body['details'] as Record<string, unknown>)['existing_invoice_id'],
      firstInvoiceId,
    );
  });

  it('AC3: different financial years (31 March vs 1 April) are not duplicates', async () => {
    const invoiceNumber = `INV-AC3FY-${run}`;
    const { poId: poId1 } = await createIssuedPo('AC3FY1');
    const first = await makeRequest(
      port,
      'POST',
      '/api/v1/supplier-invoices',
      captureBody(poId1, invoiceNumber, { invoice_date: '2026-03-31' }),
      officerHeaders,
    );
    assert.strictEqual(first.status, 201, JSON.stringify(first.body));

    const { poId: poId2 } = await createIssuedPo('AC3FY2');
    const second = await makeRequest(
      port,
      'POST',
      '/api/v1/supplier-invoices',
      captureBody(poId2, invoiceNumber, { invoice_date: '2026-04-01' }),
      officerHeaders,
    );
    assert.strictEqual(second.status, 201, JSON.stringify(second.body));
  });

  it('AC3: conservative invoice-number normalization treats case-insensitive but space-preserving numbers as the same grain', async () => {
    const invoiceNumber = `inv ac3norm ${run}`;
    const { poId: poId1 } = await createIssuedPo('AC3N1');
    const first = await makeRequest(
      port,
      'POST',
      '/api/v1/supplier-invoices',
      captureBody(poId1, invoiceNumber),
      officerHeaders,
    );
    assert.strictEqual(first.status, 201, JSON.stringify(first.body));

    const { poId: poId2 } = await createIssuedPo('AC3N2');
    const second = await makeRequest(
      port,
      'POST',
      '/api/v1/supplier-invoices',
      captureBody(poId2, invoiceNumber.toUpperCase()),
      officerHeaders,
    );
    assert.strictEqual(second.status, 409, JSON.stringify(second.body));
    assert.strictEqual(second.body['error_code'], 'DUPLICATE_EVENT');
  });

  it('AC3: the duplicate-override endpoint rejects a blank reason', async () => {
    const { poId } = await createIssuedPo('AC3OVERRIDEBLANK');
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/supplier-invoices/duplicate-overrides',
      captureBody(poId, `INV-AC3OB-${run}`, { duplicate_override_reason: '   ' }),
      overrideHeaders,
    );
    assert.strictEqual(res.status, 400, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'INVOICE_DUPLICATE_OVERRIDE_REASON_REQUIRED');
  });

  it('AC3: an unauthorized caller cannot use the duplicate-override endpoint', async () => {
    const { poId } = await createIssuedPo('AC3UNAUTH');
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/supplier-invoices/duplicate-overrides',
      captureBody(poId, `INV-AC3UA-${run}`, {
        duplicate_override_reason: 'Vendor resubmission approved',
      }),
      officerHeaders,
    );
    assert.strictEqual(res.status, 403, JSON.stringify(res.body));
  });

  it('AC3: an authorized override records duplicate_of_invoice_id and the evidenced reason', async () => {
    const invoiceNumber = `INV-AC3OK-${run}`;
    const { poId: poId1 } = await createIssuedPo('AC3OKA');
    const first = await makeRequest(
      port,
      'POST',
      '/api/v1/supplier-invoices',
      captureBody(poId1, invoiceNumber),
      officerHeaders,
    );
    assert.strictEqual(first.status, 201, JSON.stringify(first.body));
    const firstInvoiceId = (first.body['supplier_invoice'] as Record<string, unknown>)[
      'invoice_id'
    ];

    const { poId: poId2 } = await createIssuedPo('AC3OKB');
    const overrideRes = await makeRequest(
      port,
      'POST',
      '/api/v1/supplier-invoices/duplicate-overrides',
      captureBody(poId2, invoiceNumber, {
        duplicate_override_reason: 'Vendor resubmission approved by AP lead',
      }),
      overrideHeaders,
    );
    assert.strictEqual(overrideRes.status, 201, JSON.stringify(overrideRes.body));
    const overriddenInvoice = overrideRes.body['supplier_invoice'] as Record<string, unknown>;
    assert.strictEqual(overriddenInvoice['duplicate_of_invoice_id'], firstInvoiceId);
    assert.strictEqual(
      overriddenInvoice['duplicate_override_reason'],
      'Vendor resubmission approved by AP lead',
    );
  });

  it('AC3: concurrent ordinary captures of the same grain resolve to exactly one winner', async () => {
    const invoiceNumber = `INV-AC3RACE-${run}`;
    const { poId: poId1 } = await createIssuedPo('AC3RACEA');
    const { poId: poId2 } = await createIssuedPo('AC3RACEB');
    const [r1, r2] = await Promise.all([
      makeRequest(
        port,
        'POST',
        '/api/v1/supplier-invoices',
        captureBody(poId1, invoiceNumber),
        officerHeaders,
      ),
      makeRequest(
        port,
        'POST',
        '/api/v1/supplier-invoices',
        captureBody(poId2, invoiceNumber),
        officerHeaders,
      ),
    ]);
    const statuses = [r1.status, r2.status].sort();
    assert.deepStrictEqual(statuses, [201, 409]);
    const loser = r1.status === 409 ? r1 : r2;
    assert.strictEqual(loser.body['error_code'], 'DUPLICATE_EVENT');
  });

  // --- AC4: unmatched exception lifecycle and PO linking ---------------------

  it('AC4: an invoice with no PO reference is recorded unmatched with no fabricated site or business stream', async () => {
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/supplier-invoice-ingestions',
      {
        source_format: 'csv',
        attachment_ref: `att-unmatched-${run}`,
        sha256_hash: sha256Hex(`unmatched-${run}`),
        detected_mime: 'text/csv',
        byte_size: 128,
        extracted_draft: { supplier_id: supplierId, invoice_number_ext: `INV-AC4-${run}` },
      },
      officerHeaders,
    );
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    const ingestionId = (res.body['ingestion'] as Record<string, unknown>)[
      'ingestion_id'
    ] as string;

    const confirmRes = await makeRequest(
      port,
      'POST',
      `/api/v1/supplier-invoice-ingestions/${ingestionId}/confirm`,
      {
        corrected_header: {
          supplier_id: supplierId,
          invoice_number_ext: `INV-AC4-${run}`,
          invoice_date: '2026-06-20',
          total_value: 1180,
          subtotal: 1000,
          cgst_total: 90,
          sgst_total: 90,
        },
        corrected_lines: [
          {
            sku: `SKU-47-AC4-${run}`,
            quantity: 2,
            uom: 'EA',
            unit_price: 500,
            taxable_value: 1000,
            cgst_amount: 90,
            sgst_amount: 90,
            line_total: 1180,
          },
        ],
      },
      officerHeaders,
    );
    assert.strictEqual(confirmRes.status, 200, JSON.stringify(confirmRes.body));

    // AC7: an unmatched invoice with no derived site is visible only to wildcard readers - list
    // with the wildcard-scoped approver, not the site-scoped officer.
    const listRes = await makeRequest(
      port,
      'GET',
      '/api/v1/supplier-invoices?status=unmatched',
      undefined,
      deptHeadHeaders,
    );
    assert.strictEqual(listRes.status, 200, JSON.stringify(listRes.body));
    const found = (listRes.body['supplier_invoices'] as Record<string, unknown>[]).find(
      (i) =>
        i['invoice_id'] ===
        (confirmRes.body['ingestion'] as Record<string, unknown>)['resulting_invoice_id'],
    );
    assert.ok(found, 'unmatched invoice should be listed');
    assert.strictEqual(found!['po_id'], null);
    assert.strictEqual(found!['site_id'], null);
    assert.strictEqual(found!['business_stream'], null);
    assert.strictEqual(found!['status'], 'unmatched');
  });

  it('AC4: linking an unmatched invoice to a mismatched-supplier PO is rejected', async () => {
    const stageRes = await makeRequest(
      port,
      'POST',
      '/api/v1/supplier-invoice-ingestions',
      {
        source_format: 'pdf',
        attachment_ref: `att-linkmismatch-${run}`,
        sha256_hash: sha256Hex(`linkmismatch-${run}`),
        detected_mime: 'application/pdf',
        byte_size: 256,
        extracted_draft: {},
      },
      officerHeaders,
    );
    const ingestionId = (stageRes.body['ingestion'] as Record<string, unknown>)[
      'ingestion_id'
    ] as string;
    const confirmRes = await makeRequest(
      port,
      'POST',
      `/api/v1/supplier-invoice-ingestions/${ingestionId}/confirm`,
      {
        corrected_header: {
          supplier_id: supplierId,
          invoice_number_ext: `INV-AC4M-${run}`,
          invoice_date: '2026-06-21',
          total_value: 590,
          subtotal: 500,
          cgst_total: 45,
          sgst_total: 45,
        },
        corrected_lines: [
          {
            sku: `SKU-47-AC4M-${run}`,
            quantity: 1,
            uom: 'EA',
            unit_price: 500,
            taxable_value: 500,
            cgst_amount: 45,
            sgst_amount: 45,
            line_total: 590,
          },
        ],
      },
      officerHeaders,
    );
    const invoiceId = (confirmRes.body['ingestion'] as Record<string, unknown>)[
      'resulting_invoice_id'
    ] as string;

    // A different supplier's PO cannot be linked: onboard and activate a SECOND supplier, draft
    // and issue a PO that belongs to it, then try to link the first supplier's unmatched invoice.
    const otherSupplierRes = await makeRequest(
      port,
      'POST',
      '/api/v1/suppliers',
      {
        legal_name: `Other Supplier 4.7 ${run}`,
        owner_party_code: `OWNER-47-OTHER-${run}`,
        gstin_ext: '29AACCS1234A1Z0',
        pan_ext: 'AACCS1234A',
        contacts: [{ name: 'Contact', email: 'contact2@example.com' }],
        credit_period_days: 30,
      },
      officerHeaders,
    );
    assert.strictEqual(otherSupplierRes.status, 201, JSON.stringify(otherSupplierRes.body));
    const otherSupplierId = (otherSupplierRes.body['supplier'] as Record<string, unknown>)[
      'supplier_id'
    ] as string;
    const otherSubmit = await makeRequest(
      port,
      'POST',
      `/api/v1/suppliers/${otherSupplierId}/onboarding/submit`,
      { documents: [{ type: 'registration', reference: 'REG-002', file_hash: 'def456' }] },
      officerHeaders,
    );
    assert.strictEqual(otherSubmit.status, 200, JSON.stringify(otherSubmit.body));
    if (otherSubmit.body['requires_approval'] !== false) {
      const otherApprove = await makeRequest(
        port,
        'POST',
        `/api/v1/suppliers/${otherSupplierId}/onboarding/approve`,
        {},
        deptHeadHeaders,
      );
      assert.strictEqual(otherApprove.status, 200, JSON.stringify(otherApprove.body));
    }

    const otherIndentId = await createApprovedIndent(`SKU-47-OTHERSUP-${run}`);
    const otherDraft = await makeRequest(
      port,
      'POST',
      '/api/v1/purchase-orders',
      {
        indent_id: otherIndentId,
        supplier_id: otherSupplierId,
        po_type: 'standard',
        lines: [
          {
            sku: `SKU-47-OTHERSUP-${run}-${indentSeq}`,
            item_category: 'raw_materials',
            ordered_qty: 10,
            uom: 'KG',
            unit_price: 500,
          },
        ],
      },
      officerHeaders,
    );
    assert.strictEqual(otherDraft.status, 201, JSON.stringify(otherDraft.body));
    const otherPo = otherDraft.body['purchase_order'] as Record<string, unknown>;
    const otherPoId = otherPo['po_id'] as string;
    if (otherPo['status'] === 'pending-approval') {
      const approveRes = await makeRequest(
        port,
        'POST',
        `/api/v1/purchase-orders/${otherPoId}/approve`,
        {},
        deptHeadHeaders,
      );
      assert.strictEqual(approveRes.status, 200, JSON.stringify(approveRes.body));
    }
    const issueRes = await makeRequest(
      port,
      'POST',
      `/api/v1/purchase-orders/${otherPoId}/issue`,
      {},
      officerHeaders,
    );
    assert.strictEqual(issueRes.status, 200, JSON.stringify(issueRes.body));

    const linkRes = await makeRequest(
      port,
      'POST',
      `/api/v1/supplier-invoices/${invoiceId}/link-po`,
      { po_id: otherPoId },
      officerHeaders,
    );
    assert.strictEqual(linkRes.status, 409, JSON.stringify(linkRes.body));
    assert.strictEqual(linkRes.body['error_code'], 'INVOICE_PO_SUPPLIER_MISMATCH');

    // The invoice stays unmatched and linkable to the CORRECT supplier's PO afterwards.
    const { poId: rightPoId } = await createIssuedPo('AC4MHAPPY');
    const rightLink = await makeRequest(
      port,
      'POST',
      `/api/v1/supplier-invoices/${invoiceId}/link-po`,
      { po_id: rightPoId },
      officerHeaders,
    );
    assert.strictEqual(rightLink.status, 200, JSON.stringify(rightLink.body));
    const linked = rightLink.body['supplier_invoice'] as Record<string, unknown>;
    assert.strictEqual(linked['status'], 'captured');
    assert.strictEqual(linked['po_id'], rightPoId);
    assert.ok(linked['site_id']);
    assert.strictEqual(linked['business_stream'], 'production');
    // AC5 dependency honesty: linking must not fabricate MSME context (Story 4.6 absent).
    assert.strictEqual(linked['msme_classification_at_capture'], null);
    assert.strictEqual(linked['statutory_due_date'], null);
    assert.strictEqual(linked['statutory_due_rule_version'], null);
  });

  it('AC4: linking rejects an unmatched status precondition once already linked', async () => {
    const stageRes = await makeRequest(
      port,
      'POST',
      '/api/v1/supplier-invoice-ingestions',
      {
        source_format: 'xml',
        attachment_ref: `att-relink-${run}`,
        sha256_hash: sha256Hex(`relink-${run}`),
        detected_mime: 'application/xml',
        byte_size: 64,
        extracted_draft: {},
      },
      officerHeaders,
    );
    const ingestionId = (stageRes.body['ingestion'] as Record<string, unknown>)[
      'ingestion_id'
    ] as string;
    const confirmRes = await makeRequest(
      port,
      'POST',
      `/api/v1/supplier-invoice-ingestions/${ingestionId}/confirm`,
      {
        corrected_header: {
          supplier_id: supplierId,
          invoice_number_ext: `INV-AC4R-${run}`,
          invoice_date: '2026-06-22',
          total_value: 590,
          subtotal: 500,
          cgst_total: 45,
          sgst_total: 45,
        },
        corrected_lines: [
          {
            sku: `SKU-47-AC4R-${run}`,
            quantity: 1,
            uom: 'EA',
            unit_price: 500,
            taxable_value: 500,
            cgst_amount: 45,
            sgst_amount: 45,
            line_total: 590,
          },
        ],
      },
      officerHeaders,
    );
    const invoiceId = (confirmRes.body['ingestion'] as Record<string, unknown>)[
      'resulting_invoice_id'
    ] as string;
    const { poId } = await createIssuedPo('AC4RELINK');
    const firstLink = await makeRequest(
      port,
      'POST',
      `/api/v1/supplier-invoices/${invoiceId}/link-po`,
      { po_id: poId },
      officerHeaders,
    );
    assert.strictEqual(firstLink.status, 200, JSON.stringify(firstLink.body));

    const { poId: poId2 } = await createIssuedPo('AC4RELINK2');
    const secondLink = await makeRequest(
      port,
      'POST',
      `/api/v1/supplier-invoices/${invoiceId}/link-po`,
      { po_id: poId2 },
      officerHeaders,
    );
    assert.strictEqual(secondLink.status, 409, JSON.stringify(secondLink.body));
    assert.strictEqual(secondLink.body['error_code'], 'INVOICE_NOT_UNMATCHED');
  });

  // --- AC2: file ingestion requires review ------------------------------------

  it('AC2: staging alone never posts an invoice; only a confirmed review does', async () => {
    const stageRes = await makeRequest(
      port,
      'POST',
      '/api/v1/supplier-invoice-ingestions',
      {
        source_format: 'pdf',
        attachment_ref: `att-ac2-${run}`,
        sha256_hash: sha256Hex(`ac2-${run}`),
        detected_mime: 'application/pdf',
        byte_size: 512,
        extracted_draft: { note: 'draft only' },
      },
      officerHeaders,
    );
    assert.strictEqual(stageRes.status, 201, JSON.stringify(stageRes.body));
    const ingestion = stageRes.body['ingestion'] as Record<string, unknown>;
    assert.strictEqual(ingestion['review_status'], 'review-required');
    assert.strictEqual(ingestion['resulting_invoice_id'], null);

    const { poId } = await createIssuedPo('AC2CONFIRM');
    const confirmRes = await makeRequest(
      port,
      'POST',
      `/api/v1/supplier-invoice-ingestions/${ingestion['ingestion_id']}/confirm`,
      {
        corrected_header: {
          supplier_id: supplierId,
          invoice_number_ext: `INV-AC2-${run}`,
          invoice_date: '2026-06-25',
          po_id: poId,
          total_value: 590,
          subtotal: 500,
          cgst_total: 45,
          sgst_total: 45,
        },
        corrected_lines: [
          {
            sku: `SKU-47-AC2-${run}`,
            quantity: 1,
            uom: 'EA',
            unit_price: 500,
            taxable_value: 500,
            cgst_amount: 45,
            sgst_amount: 45,
            line_total: 590,
          },
        ],
      },
      officerHeaders,
    );
    assert.strictEqual(confirmRes.status, 200, JSON.stringify(confirmRes.body));
    const updatedIngestion = confirmRes.body['ingestion'] as Record<string, unknown>;
    assert.strictEqual(updatedIngestion['review_status'], 'reviewed');
    assert.ok(updatedIngestion['resulting_invoice_id']);
  });

  it('AC2: repeat review of the same ingestion is rejected', async () => {
    const stageRes = await makeRequest(
      port,
      'POST',
      '/api/v1/supplier-invoice-ingestions',
      {
        source_format: 'csv',
        attachment_ref: `att-ac2b-${run}`,
        sha256_hash: sha256Hex(`ac2b-${run}`),
        detected_mime: 'text/csv',
        byte_size: 96,
        extracted_draft: {},
      },
      officerHeaders,
    );
    const ingestionId = (stageRes.body['ingestion'] as Record<string, unknown>)[
      'ingestion_id'
    ] as string;
    const header = {
      supplier_id: supplierId,
      invoice_number_ext: `INV-AC2B-${run}`,
      invoice_date: '2026-06-26',
      total_value: 590,
      subtotal: 500,
      cgst_total: 45,
      sgst_total: 45,
    };
    const lines = [
      {
        sku: `SKU-47-AC2B-${run}`,
        quantity: 1,
        uom: 'EA',
        unit_price: 500,
        taxable_value: 500,
        cgst_amount: 45,
        sgst_amount: 45,
        line_total: 590,
      },
    ];
    const first = await makeRequest(
      port,
      'POST',
      `/api/v1/supplier-invoice-ingestions/${ingestionId}/confirm`,
      { corrected_header: header, corrected_lines: lines },
      officerHeaders,
    );
    assert.strictEqual(first.status, 200, JSON.stringify(first.body));
    const second = await makeRequest(
      port,
      'POST',
      `/api/v1/supplier-invoice-ingestions/${ingestionId}/confirm`,
      { corrected_header: header, corrected_lines: lines },
      officerHeaders,
    );
    assert.strictEqual(second.status, 409, JSON.stringify(second.body));
    assert.strictEqual(second.body['error_code'], 'INVOICE_ALREADY_REVIEWED');
  });

  it('AC2: an unsupported source_format is rejected at staging', async () => {
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/supplier-invoice-ingestions',
      {
        source_format: 'docx',
        attachment_ref: `att-badformat-${run}`,
        sha256_hash: sha256Hex(`badformat-${run}`),
        detected_mime: 'application/msword',
        byte_size: 10,
        extracted_draft: {},
      },
      officerHeaders,
    );
    assert.strictEqual(res.status, 400, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'INVOICE_SOURCE_FORMAT_UNSUPPORTED');
  });

  it('AC2: a malformed SHA-256 hash is rejected at staging', async () => {
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/supplier-invoice-ingestions',
      {
        source_format: 'pdf',
        attachment_ref: `att-badhash-${run}`,
        sha256_hash: 'not-a-hash',
        detected_mime: 'application/pdf',
        byte_size: 10,
        extracted_draft: {},
      },
      officerHeaders,
    );
    assert.strictEqual(res.status, 400, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'INVOICE_PROVENANCE_INVALID');
  });

  // --- AC6: central enforcement (direct-event bypass attempts) ---------------

  it('AC6: a direct POST /api/v1/events attempt cannot spoof business_stream on a captured invoice', async () => {
    const { poId } = await createIssuedPo('AC6SPOOF');
    const invoiceId = randomUUID();
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/events',
      {
        stream_type: 'procurement',
        stream_id: invoiceId,
        event_type: 'supplier_invoice.captured',
        payload: {
          invoice_id: invoiceId,
          supplier_id: supplierId,
          invoice_number_ext: `INV-AC6-${run}`,
          invoice_date: '2026-06-27',
          po_id: poId,
          // A validly-registered but WRONG stream (the PO's own stream is 'production') proves
          // the seam's own re-derivation-and-reject check, not merely the earlier tagging gate's
          // vocabulary check.
          business_stream: 'research',
          lines: [
            {
              sku: `SKU-47-AC6-${run}`,
              quantity: 1,
              uom: 'EA',
              unit_price: 500,
              taxable_value: 500,
              cgst_amount: 45,
              sgst_amount: 45,
              line_total: 590,
            },
          ],
          total_value: 590,
          subtotal: 500,
          cgst_total: 45,
          sgst_total: 45,
          capture_method: 'manual',
        },
        metadata: {
          correlation_id: randomUUID(),
          actor: { user_id: randomUUID(), role: 'procurement_officer_4_7', location_id: siteA },
          occurred_at: new Date().toISOString(),
        },
      },
      officerHeaders,
    );
    assert.strictEqual(res.status, 409, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'BUSINESS_STREAM_MISMATCH');
  });

  it('AC1/AC6: an unrecognized business_stream is rejected by the earlier tagging gate before the seam ever runs', async () => {
    const { poId } = await createIssuedPo('AC6TAGGATE');
    const invoiceId = randomUUID();
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/events',
      {
        stream_type: 'procurement',
        stream_id: invoiceId,
        event_type: 'supplier_invoice.captured',
        payload: {
          invoice_id: invoiceId,
          supplier_id: supplierId,
          invoice_number_ext: `INV-AC6TG-${run}`,
          invoice_date: '2026-06-27',
          po_id: poId,
          business_stream: 'not_a_real_stream',
          lines: [
            {
              sku: `SKU-47-AC6TG-${run}`,
              quantity: 1,
              uom: 'EA',
              unit_price: 500,
              taxable_value: 500,
              cgst_amount: 45,
              sgst_amount: 45,
              line_total: 590,
            },
          ],
          total_value: 590,
          subtotal: 500,
          cgst_total: 45,
          sgst_total: 45,
          capture_method: 'manual',
        },
        metadata: {
          correlation_id: randomUUID(),
          actor: { user_id: randomUUID(), role: 'procurement_officer_4_7', location_id: siteA },
          occurred_at: new Date().toISOString(),
        },
      },
      officerHeaders,
    );
    assert.strictEqual(res.status, 400, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'INVALID_BUSINESS_STREAM');
  });

  it('AC6: shape validation runs before idempotency (a malformed captured payload is rejected, not silently accepted)', async () => {
    const invoiceId = randomUUID();
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/events',
      {
        stream_type: 'procurement',
        stream_id: invoiceId,
        event_type: 'supplier_invoice.captured',
        idempotency_key: `bad-shape-${run}`,
        payload: { invoice_id: invoiceId },
        metadata: {
          correlation_id: randomUUID(),
          actor: { user_id: randomUUID(), role: 'procurement_officer_4_7', location_id: siteA },
          occurred_at: new Date().toISOString(),
        },
      },
      officerHeaders,
    );
    assert.strictEqual(res.status, 400, JSON.stringify(res.body));
  });

  // --- AC7: read and provenance contract --------------------------------------

  it('AC7: detail read includes lines, provenance, and audit identifiers', async () => {
    const { poId, lineSku, poLineId } = await createIssuedPo('AC7DETAIL');
    const captureRes = await makeRequest(
      port,
      'POST',
      '/api/v1/supplier-invoices',
      captureBody(poId, `INV-AC7-${run}`, {
        sku: lineSku,
        lines: [
          {
            po_line_id: poLineId,
            sku: lineSku,
            quantity: 10,
            uom: 'KG',
            unit_price: 500,
            taxable_value: 5000,
            cgst_amount: 450,
            sgst_amount: 450,
            line_total: 5900,
          },
        ],
      }),
      officerHeaders,
    );
    const invoiceId = (captureRes.body['supplier_invoice'] as Record<string, unknown>)[
      'invoice_id'
    ] as string;
    const getRes = await makeRequest(
      port,
      'GET',
      `/api/v1/supplier-invoices/${invoiceId}`,
      undefined,
      readerHeaders,
    );
    assert.strictEqual(getRes.status, 200, JSON.stringify(getRes.body));
    const invoice = getRes.body['supplier_invoice'] as Record<string, unknown>;
    assert.ok(invoice['captured_by']);
    assert.ok(invoice['source_event_id']);
    const lines = getRes.body['lines'] as Record<string, unknown>[];
    assert.strictEqual(lines.length, 1);
  });

  it('AC7: an unmatched invoice with no site is hidden from a site-scoped (non-wildcard) reader', async () => {
    const stageRes = await makeRequest(
      port,
      'POST',
      '/api/v1/supplier-invoice-ingestions',
      {
        source_format: 'csv',
        attachment_ref: `att-ac7-${run}`,
        sha256_hash: sha256Hex(`ac7-${run}`),
        detected_mime: 'text/csv',
        byte_size: 32,
        extracted_draft: {},
      },
      officerHeaders,
    );
    const ingestionId = (stageRes.body['ingestion'] as Record<string, unknown>)[
      'ingestion_id'
    ] as string;
    const confirmRes = await makeRequest(
      port,
      'POST',
      `/api/v1/supplier-invoice-ingestions/${ingestionId}/confirm`,
      {
        corrected_header: {
          supplier_id: supplierId,
          invoice_number_ext: `INV-AC7U-${run}`,
          invoice_date: '2026-06-28',
          total_value: 590,
          subtotal: 500,
          cgst_total: 45,
          sgst_total: 45,
        },
        corrected_lines: [
          {
            sku: `SKU-47-AC7U-${run}`,
            quantity: 1,
            uom: 'EA',
            unit_price: 500,
            taxable_value: 500,
            cgst_amount: 45,
            sgst_amount: 45,
            line_total: 590,
          },
        ],
      },
      officerHeaders,
    );
    const invoiceId = (confirmRes.body['ingestion'] as Record<string, unknown>)[
      'resulting_invoice_id'
    ] as string;

    const readerGetRes = await makeRequest(
      port,
      'GET',
      `/api/v1/supplier-invoices/${invoiceId}`,
      undefined,
      readerHeaders,
    );
    // Review patch: a hidden invoice reads as 404, never 403 - a 403 would be an existence
    // oracle confirming the hidden invoice ID is real.
    assert.strictEqual(readerGetRes.status, 404, JSON.stringify(readerGetRes.body));
    assert.strictEqual(readerGetRes.body['error_code'], 'SUPPLIER_INVOICE_NOT_FOUND');

    // A wildcard-scoped reader (deptHead holds locationId '*') may still see the unmatched row.
    const wildcardGetRes = await makeRequest(
      port,
      'GET',
      `/api/v1/supplier-invoices/${invoiceId}`,
      undefined,
      deptHeadHeaders,
    );
    assert.strictEqual(wildcardGetRes.status, 200, JSON.stringify(wildcardGetRes.body));
  });

  it('AC7: list supports status and search filters', async () => {
    const { poId } = await createIssuedPo('AC7LIST');
    const invoiceNumber = `INV-AC7LIST-${run}`;
    await makeRequest(
      port,
      'POST',
      '/api/v1/supplier-invoices',
      captureBody(poId, invoiceNumber),
      officerHeaders,
    );
    const listRes = await makeRequest(
      port,
      'GET',
      `/api/v1/supplier-invoices?status=captured&search=${encodeURIComponent(invoiceNumber)}`,
      undefined,
      officerHeaders,
    );
    assert.strictEqual(listRes.status, 200, JSON.stringify(listRes.body));
    const invoices = listRes.body['supplier_invoices'] as Record<string, unknown>[];
    assert.ok(invoices.some((i) => i['invoice_number_ext'] === invoiceNumber));
  });

  // --- Review patches (2026-08-06): seam authorization, provenance, GST, hygiene ---

  it('AC3/AC6: a direct POST /api/v1/events cannot self-authorize a duplicate override without the capability', async () => {
    const { poId, lineSku, poLineId } = await createIssuedPo('OVRSPOOF');
    const invoiceId = randomUUID();
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/events',
      {
        stream_type: 'procurement',
        stream_id: invoiceId,
        event_type: 'supplier_invoice.captured',
        payload: {
          invoice_id: invoiceId,
          supplier_id: supplierId,
          invoice_number_ext: `INV-OVRSPOOF-${run}`,
          invoice_date: '2026-06-15',
          po_id: poId,
          business_stream: 'production',
          duplicate_override_reason: 'self-granted override attempt',
          lines: [
            {
              po_line_id: poLineId,
              sku: lineSku,
              quantity: 10,
              uom: 'KG',
              unit_price: 500,
              taxable_value: 5000,
              cgst_amount: 450,
              sgst_amount: 450,
              line_total: 5900,
            },
          ],
          subtotal: 5000,
          cgst_total: 450,
          sgst_total: 450,
          total_value: 5900,
          capture_method: 'manual',
        },
        metadata: {
          correlation_id: randomUUID(),
          actor: { user_id: randomUUID(), role: 'procurement_officer_4_7', location_id: siteA },
          occurred_at: new Date().toISOString(),
        },
      },
      officerHeaders,
    );
    assert.strictEqual(res.status, 403, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'FUNCTION_ACCESS_DENIED');
  });

  it('AC3/AC6: an ordinary reviewer cannot smuggle an override reason through the confirm payload', async () => {
    const stageRes = await makeRequest(
      port,
      'POST',
      '/api/v1/supplier-invoice-ingestions',
      {
        source_format: 'csv',
        attachment_ref: `att-confsmuggle-${run}`,
        sha256_hash: sha256Hex(`confsmuggle-${run}`),
        detected_mime: 'text/csv',
        byte_size: 40,
        extracted_draft: {},
      },
      officerHeaders,
    );
    const ingestionId = (stageRes.body['ingestion'] as Record<string, unknown>)[
      'ingestion_id'
    ] as string;
    const res = await makeRequest(
      port,
      'POST',
      `/api/v1/supplier-invoice-ingestions/${ingestionId}/confirm`,
      {
        corrected_header: {
          supplier_id: supplierId,
          invoice_number_ext: `INV-CONFSMUGGLE-${run}`,
          invoice_date: '2026-06-15',
          total_value: 590,
          duplicate_override_reason: 'reviewer-smuggled override',
        },
        corrected_lines: [
          {
            sku: `SKU-47-SMUGGLE-${run}`,
            quantity: 1,
            uom: 'EA',
            unit_price: 500,
            taxable_value: 500,
            cgst_amount: 45,
            sgst_amount: 45,
            line_total: 590,
          },
        ],
      },
      officerHeaders,
    );
    assert.strictEqual(res.status, 403, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'FUNCTION_ACCESS_DENIED');
  });

  it('AC3: an authorized override with no existing duplicate is rejected, not silently downgraded', async () => {
    const { poId } = await createIssuedPo('OVRNODUP');
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/supplier-invoices/duplicate-overrides',
      captureBody(poId, `INV-OVRNODUP-${run}`, {
        duplicate_override_reason: 'nothing to override',
      }),
      overrideHeaders,
    );
    assert.strictEqual(res.status, 409, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'INVOICE_NO_DUPLICATE_TO_OVERRIDE');
  });

  it('AC3: the reviewed-file path hits the same duplicate grain as manual capture', async () => {
    const invoiceNumber = `INV-FDUP-${run}`;
    const { poId } = await createIssuedPo('FDUPA');
    const first = await makeRequest(
      port,
      'POST',
      '/api/v1/supplier-invoices',
      captureBody(poId, invoiceNumber),
      officerHeaders,
    );
    assert.strictEqual(first.status, 201, JSON.stringify(first.body));

    const stageRes = await makeRequest(
      port,
      'POST',
      '/api/v1/supplier-invoice-ingestions',
      {
        source_format: 'pdf',
        attachment_ref: `att-fdup-${run}`,
        sha256_hash: sha256Hex(`fdup-${run}`),
        detected_mime: 'application/pdf',
        byte_size: 77,
        extracted_draft: {},
      },
      officerHeaders,
    );
    const ingestionId = (stageRes.body['ingestion'] as Record<string, unknown>)[
      'ingestion_id'
    ] as string;
    const confirmRes = await makeRequest(
      port,
      'POST',
      `/api/v1/supplier-invoice-ingestions/${ingestionId}/confirm`,
      {
        corrected_header: {
          supplier_id: supplierId,
          invoice_number_ext: invoiceNumber,
          invoice_date: '2026-06-15',
          total_value: 590,
        },
        corrected_lines: [
          {
            sku: `SKU-47-FDUP-${run}`,
            quantity: 1,
            uom: 'EA',
            unit_price: 500,
            taxable_value: 500,
            cgst_amount: 45,
            sgst_amount: 45,
            line_total: 590,
          },
        ],
      },
      officerHeaders,
    );
    assert.strictEqual(confirmRes.status, 409, JSON.stringify(confirmRes.body));
    assert.strictEqual(confirmRes.body['error_code'], 'DUPLICATE_EVENT');
  });

  it('AC2/AC6: a direct event cannot post a file-captured invoice against a nonexistent ingestion', async () => {
    const invoiceId = randomUUID();
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/events',
      {
        stream_type: 'procurement',
        stream_id: invoiceId,
        event_type: 'supplier_invoice.unmatched_recorded',
        payload: {
          invoice_id: invoiceId,
          supplier_id: supplierId,
          invoice_number_ext: `INV-GHOSTING-${run}`,
          invoice_date: '2026-06-15',
          capture_method: 'file',
          ingestion_id: randomUUID(),
          lines: [
            {
              sku: `SKU-47-GHOST-${run}`,
              quantity: 1,
              uom: 'EA',
              unit_price: 500,
              taxable_value: 500,
              cgst_amount: 45,
              sgst_amount: 45,
              line_total: 590,
            },
          ],
          total_value: 590,
        },
        metadata: {
          correlation_id: randomUUID(),
          actor: { user_id: randomUUID(), role: 'procurement_officer_4_7', location_id: siteA },
          occurred_at: new Date().toISOString(),
        },
      },
      officerHeaders,
    );
    assert.strictEqual(res.status, 404, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'INVOICE_PROVENANCE_INVALID');
  });

  it('AC2/AC6: a direct event cannot record a manual unmatched invoice (file review is the only unmatched source)', async () => {
    const invoiceId = randomUUID();
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/events',
      {
        stream_type: 'procurement',
        stream_id: invoiceId,
        event_type: 'supplier_invoice.unmatched_recorded',
        payload: {
          invoice_id: invoiceId,
          supplier_id: supplierId,
          invoice_number_ext: `INV-MANUNMATCHED-${run}`,
          invoice_date: '2026-06-15',
          capture_method: 'manual',
          lines: [
            {
              sku: `SKU-47-MU-${run}`,
              quantity: 1,
              uom: 'EA',
              unit_price: 500,
              taxable_value: 500,
              cgst_amount: 45,
              sgst_amount: 45,
              line_total: 590,
            },
          ],
          total_value: 590,
        },
        metadata: {
          correlation_id: randomUUID(),
          actor: { user_id: randomUUID(), role: 'procurement_officer_4_7', location_id: siteA },
          occurred_at: new Date().toISOString(),
        },
      },
      officerHeaders,
    );
    assert.strictEqual(res.status, 400, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'INVALID_PARAMS');
  });

  it('AC6: a direct event cannot spoof captured_by against the authenticated actor', async () => {
    const { poId, lineSku, poLineId } = await createIssuedPo('ACTORSPOOF');
    const invoiceId = randomUUID();
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/events',
      {
        stream_type: 'procurement',
        stream_id: invoiceId,
        event_type: 'supplier_invoice.captured',
        payload: {
          invoice_id: invoiceId,
          supplier_id: supplierId,
          invoice_number_ext: `INV-ACTORSPOOF-${run}`,
          invoice_date: '2026-06-15',
          po_id: poId,
          business_stream: 'production',
          captured_by: randomUUID(),
          lines: [
            {
              po_line_id: poLineId,
              sku: lineSku,
              quantity: 10,
              uom: 'KG',
              unit_price: 500,
              taxable_value: 5000,
              cgst_amount: 450,
              sgst_amount: 450,
              line_total: 5900,
            },
          ],
          total_value: 5900,
          capture_method: 'manual',
        },
        metadata: {
          correlation_id: randomUUID(),
          actor: { user_id: randomUUID(), role: 'procurement_officer_4_7', location_id: siteA },
          occurred_at: new Date().toISOString(),
        },
      },
      officerHeaders,
    );
    assert.strictEqual(res.status, 400, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'INVALID_PARAMS');
  });

  it('AC1: a submitted GST head that disagrees with the line sums is rejected, never silently overwritten', async () => {
    const { poId } = await createIssuedPo('GSTHEAD');
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/supplier-invoices',
      captureBody(poId, `INV-GSTHEAD-${run}`, { cgst_total: 900 }),
      officerHeaders,
    );
    assert.strictEqual(res.status, 400, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'INVOICE_TOTAL_MISMATCH');
  });

  it('AC1: a line carrying IGST together with CGST/SGST is rejected (GST head exclusivity)', async () => {
    const { poId, lineSku, poLineId } = await createIssuedPo('GSTEXCL');
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/supplier-invoices',
      captureBody(poId, `INV-GSTEXCL-${run}`, {
        lines: [
          {
            po_line_id: poLineId,
            sku: lineSku,
            quantity: 10,
            uom: 'KG',
            unit_price: 500,
            taxable_value: 5000,
            cgst_amount: 450,
            igst_amount: 450,
            line_total: 5900,
          },
        ],
      }),
      officerHeaders,
    );
    assert.strictEqual(res.status, 400, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'INVALID_PARAMS');
  });

  it('AC1: line arithmetic must balance - taxable plus GST heads equals line_total', async () => {
    const { poId, lineSku, poLineId } = await createIssuedPo('LINEARITH');
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/supplier-invoices',
      captureBody(poId, `INV-LINEARITH-${run}`, {
        lines: [
          {
            po_line_id: poLineId,
            sku: lineSku,
            quantity: 10,
            uom: 'KG',
            unit_price: 500,
            taxable_value: 5000,
            cgst_amount: 450,
            sgst_amount: 450,
            line_total: 9999,
          },
        ],
        total_value: 9999,
      }),
      officerHeaders,
    );
    assert.strictEqual(res.status, 400, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'INVOICE_TOTAL_MISMATCH');
  });

  it('AC1: a far-future invoice_date is rejected by the plausibility window', async () => {
    const { poId } = await createIssuedPo('FUTUREDATE');
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/supplier-invoices',
      captureBody(poId, `INV-FUTURE-${run}`, { invoice_date: '2999-01-01' }),
      officerHeaders,
    );
    assert.strictEqual(res.status, 400, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'INVALID_PARAMS');
  });

  it('AC1: a non-INR currency is rejected while foreign currency stays deferred', async () => {
    const { poId } = await createIssuedPo('CURRENCY');
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/supplier-invoices',
      captureBody(poId, `INV-CURRENCY-${run}`, { currency: 'USD' }),
      officerHeaders,
    );
    assert.strictEqual(res.status, 400, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'INVALID_PARAMS');
  });

  it('AC1: a malformed recipient GSTIN is rejected', async () => {
    const { poId } = await createIssuedPo('BADGSTIN');
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/supplier-invoices',
      captureBody(poId, `INV-BADGSTIN-${run}`, { recipient_gstin_ext: 'not-a-gstin' }),
      officerHeaders,
    );
    assert.strictEqual(res.status, 400, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'INVALID_PARAMS');
  });

  it('AC1: a valid inbound IRN is preserved on the captured invoice', async () => {
    const { poId } = await createIssuedPo('IRN');
    const irn = sha256Hex(`irn-${run}`);
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/supplier-invoices',
      captureBody(poId, `INV-IRN-${run}`, { irn_ext: irn }),
      officerHeaders,
    );
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    const invoice = res.body['supplier_invoice'] as Record<string, unknown>;
    assert.strictEqual(invoice['irn_ext'], irn);
  });

  it('AC1: capture against a CONFIRMED purchase order is accepted', async () => {
    const { poId, lineSku, poLineId } = await createIssuedPo('CONFIRMEDPO');
    const confirmPoRes = await makeRequest(
      port,
      'POST',
      `/api/v1/purchase-orders/${poId}/confirm`,
      { promised_delivery_date: '2026-12-15' },
      officerHeaders,
    );
    assert.strictEqual(confirmPoRes.status, 200, JSON.stringify(confirmPoRes.body));
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/supplier-invoices',
      captureBody(poId, `INV-CONFIRMEDPO-${run}`, {
        lines: [
          {
            po_line_id: poLineId,
            sku: lineSku,
            quantity: 10,
            uom: 'KG',
            unit_price: 500,
            taxable_value: 5000,
            cgst_amount: 450,
            sgst_amount: 450,
            line_total: 5900,
          },
        ],
      }),
      officerHeaders,
    );
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
  });

  it('AC3: NFC normalization collapses composed and decomposed invoice numbers into one grain', async () => {
    // Explicit escapes so no editor/toolchain normalization can silently merge the two
    // forms: composed U+00C9 vs decomposed E + U+0301.
    const composed = `INV-CAFÉ-${run}`;
    const decomposed = `INV-CAFÉ-${run}`;
    const { poId: poId1 } = await createIssuedPo('NFC1');
    const first = await makeRequest(
      port,
      'POST',
      '/api/v1/supplier-invoices',
      captureBody(poId1, composed),
      officerHeaders,
    );
    assert.strictEqual(first.status, 201, JSON.stringify(first.body));
    const { poId: poId2 } = await createIssuedPo('NFC2');
    const second = await makeRequest(
      port,
      'POST',
      '/api/v1/supplier-invoices',
      captureBody(poId2, decomposed),
      officerHeaders,
    );
    assert.strictEqual(second.status, 409, JSON.stringify(second.body));
    assert.strictEqual(second.body['error_code'], 'DUPLICATE_EVENT');
  });

  it('AC2: re-staging the same attachment reference is a stable 409, not a raw 500', async () => {
    const stageBody = {
      source_format: 'pdf' as const,
      attachment_ref: `att-restage-${run}`,
      sha256_hash: sha256Hex(`restage-${run}`),
      detected_mime: 'application/pdf',
      byte_size: 55,
      extracted_draft: {},
    };
    const first = await makeRequest(
      port,
      'POST',
      '/api/v1/supplier-invoice-ingestions',
      stageBody,
      officerHeaders,
    );
    assert.strictEqual(first.status, 201, JSON.stringify(first.body));
    const second = await makeRequest(
      port,
      'POST',
      '/api/v1/supplier-invoice-ingestions',
      stageBody,
      officerHeaders,
    );
    assert.strictEqual(second.status, 409, JSON.stringify(second.body));
    assert.strictEqual(second.body['error_code'], 'INVOICE_ATTACHMENT_ALREADY_STAGED');
  });

  it('AC2: a missing ingestion returns its own not-found code', async () => {
    const res = await makeRequest(
      port,
      'GET',
      `/api/v1/supplier-invoice-ingestions/${randomUUID()}`,
      undefined,
      readerHeaders,
    );
    assert.strictEqual(res.status, 404, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'SUPPLIER_INVOICE_INGESTION_NOT_FOUND');
  });

  it('AC2/AC7: the review queue lists pending ingestions', async () => {
    const stageRes = await makeRequest(
      port,
      'POST',
      '/api/v1/supplier-invoice-ingestions',
      {
        source_format: 'xml',
        attachment_ref: `att-queue-${run}`,
        sha256_hash: sha256Hex(`queue-${run}`),
        detected_mime: 'application/xml',
        byte_size: 21,
        extracted_draft: {},
      },
      officerHeaders,
    );
    assert.strictEqual(stageRes.status, 201, JSON.stringify(stageRes.body));
    const ingestionId = (stageRes.body['ingestion'] as Record<string, unknown>)[
      'ingestion_id'
    ] as string;
    const listRes = await makeRequest(
      port,
      'GET',
      '/api/v1/supplier-invoice-ingestions?review_status=review-required',
      undefined,
      readerHeaders,
    );
    assert.strictEqual(listRes.status, 200, JSON.stringify(listRes.body));
    const ingestions = listRes.body['ingestions'] as Record<string, unknown>[];
    assert.ok(ingestions.some((i) => i['ingestion_id'] === ingestionId));
  });

  it('AC7: a malformed invoice_date list filter is a 400, not a database error', async () => {
    const res = await makeRequest(
      port,
      'GET',
      '/api/v1/supplier-invoices?invoice_date=31-03-2026',
      undefined,
      readerHeaders,
    );
    assert.strictEqual(res.status, 400, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'INVALID_PARAMS');
  });

  it('AC7: numeric list params reject trailing junk instead of silently truncating', async () => {
    const res = await makeRequest(
      port,
      'GET',
      '/api/v1/supplier-invoices?financial_year_start=2025abc',
      undefined,
      readerHeaders,
    );
    assert.strictEqual(res.status, 400, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'INVALID_PARAMS');
  });
});
