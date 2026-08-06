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

// Story 4.6: MSME Compliance Tracking. Runs against the PRODUCTION router surface
// (createAppRouter) with real auth, RBAC, and PostgreSQL. Tests run serially (npm test uses
// --test-concurrency=1) and seed their own users/supplier/PO fixtures for isolation.
//
// DATE columns are asserted via ::text against the admin pool (repo-wide DATE serialization
// deferral: no global pg type parser exists, so DATE surfaces as a shifted timestamp through
// JSON). Statutory expectations are computed with the same IST calendar arithmetic as the
// production rule (UTC+5:30 shift, then UTC getters).

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCIM_HEADERS = { Authorization: 'Bearer test-only-scim-bearer-token-not-for-production-use' };
const run = randomUUID().slice(0, 8);
const RULE_VERSION = 'msmed-2006.s15-16.v1';

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

/** IST calendar date of an instant - same rule as production (shift +5:30, read UTC getters). */
function istYmd(iso: string): string {
  const ist = new Date(new Date(iso).getTime() + 5.5 * 60 * 60 * 1000);
  return `${ist.getUTCFullYear()}-${String(ist.getUTCMonth() + 1).padStart(2, '0')}-${String(ist.getUTCDate()).padStart(2, '0')}`;
}

function addDays(ymd: string, days: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const shifted = new Date(Date.UTC(y!, m! - 1, d! + days));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}-${String(shifted.getUTCDate()).padStart(2, '0')}`;
}

function addYears(ymd: string, years: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const shifted = new Date(Date.UTC(y! + years, m! - 1, d!));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}-${String(shifted.getUTCDate()).padStart(2, '0')}`;
}

describe('Story 4.6 MSME Compliance Tracking Integration Tests', () => {
  let server: Server;
  let port: number;
  const siteA = randomUUID();
  let officerHeaders: Record<string, string>;
  let deptHeadHeaders: Record<string, string>;
  let requesterHeaders: Record<string, string>;
  let readerHeaders: Record<string, string>;
  let indentSeq = 0;
  const istToday = istYmd(new Date().toISOString());

  // Suppliers by scenario. All start active and non-MSME; individual tests verify Udyam.
  let supplierCredit30: string; // 30-day agreed credit period
  let supplierCredit60: string; // 60-day credit period - the 45-day ceiling must cap it
  let supplierNoCredit: string; // no credit period - the 15-day appointed-day rule
  let supplierNonMsme: string; // never MSME-verified
  let supplierRevalSoon: string; // revalidation window (AC5)
  let supplierLapsed: string; // lapsed revalidation (AC7)

  const poLineIndex = new Map<string, { sku: string; poLineId: string }>();

  async function createActiveSupplier(
    tag: string,
    creditPeriodDays: number,
    gstin: string,
  ): Promise<string> {
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/suppliers',
      {
        legal_name: `MSME Supplier ${tag} ${run}`,
        owner_party_code: `OWN-46-${tag}-${run}`.toUpperCase(),
        gstin_ext: gstin,
        contacts: [{ name: 'Contact', email: 'contact@example.com' }],
        credit_period_days: creditPeriodDays,
      },
      officerHeaders,
    );
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    const supplierId = (res.body['supplier'] as Record<string, unknown>)['supplier_id'] as string;
    const submitRes = await makeRequest(
      port,
      'POST',
      `/api/v1/suppliers/${supplierId}/onboarding/submit`,
      { documents: [{ type: 'registration', reference: `REG-${tag}`, file_hash: 'abc123' }] },
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
    return supplierId;
  }

  async function verifyMsme(
    supplierId: string,
    overrides: Record<string, unknown> = {},
  ): Promise<HttpResult> {
    return makeRequest(
      port,
      'POST',
      `/api/v1/suppliers/${supplierId}/msme`,
      {
        udyam_number_ext: 'UDYAM-MH-12-1234567',
        msme_classification: 'micro',
        certificate_reference: `CERT-${run}`,
        ...overrides,
      },
      officerHeaders,
    );
  }

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

  /** Drafts, approves, and issues a PO for the given supplier; returns ids plus draft body. */
  async function createIssuedPo(
    supplierId: string,
    skuPrefix: string,
  ): Promise<{
    poId: string;
    lineSku: string;
    poLineId: string;
    draftBody: Record<string, unknown>;
  }> {
    const sku = `SKU-46-${skuPrefix}-${run}`;
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
    const draftLines = draftRes.body['lines'] as Record<string, unknown>[];
    const poLineId = draftLines[0]!['po_line_id'] as string;
    poLineIndex.set(poId, { sku, poLineId });
    return { poId, lineSku: sku, poLineId, draftBody: draftRes.body };
  }

  async function confirmPo(poId: string): Promise<HttpResult> {
    return makeRequest(
      port,
      'POST',
      `/api/v1/purchase-orders/${poId}/confirm`,
      { promised_delivery_date: '2026-12-15' },
      officerHeaders,
    );
  }

  /** Captures a PO-backed invoice for the supplier; returns invoice_id. */
  async function captureInvoice(
    supplierId: string,
    poId: string,
    invoiceNumberExt: string,
    invoiceDate: string,
  ): Promise<string> {
    const poLine = poLineIndex.get(poId)!;
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/supplier-invoices',
      {
        supplier_id: supplierId,
        invoice_number_ext: invoiceNumberExt,
        invoice_date: invoiceDate,
        po_id: poId,
        currency: 'INR',
        lines: [
          {
            po_line_id: poLine.poLineId,
            sku: poLine.sku,
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
      },
      officerHeaders,
    );
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    return (res.body['supplier_invoice'] as Record<string, unknown>)['invoice_id'] as string;
  }

  async function invoiceStampRow(invoiceId: string): Promise<Record<string, unknown>> {
    const adminPool = getAdminPool();
    const r = await adminPool.query(
      `SELECT msme_classification_at_capture, statutory_due_date::text AS statutory_due_date,
              statutory_due_rule_version, statutory_breach
       FROM supplier_invoice WHERE invoice_id = $1`,
      [invoiceId],
    );
    return r.rows[0] as Record<string, unknown>;
  }

  async function supplierMsmeRow(supplierId: string): Promise<Record<string, unknown>> {
    const adminPool = getAdminPool();
    const r = await adminPool.query(
      `SELECT udyam_number_ext, msme_classification, msme_certificate_reference, msme_status,
              udyam_verified_at, udyam_revalidation_due_date::text AS udyam_revalidation_due_date
       FROM supplier WHERE supplier_id = $1`,
      [supplierId],
    );
    return r.rows[0] as Record<string, unknown>;
  }

  async function runDailyCheck(businessDate?: string): Promise<HttpResult> {
    return makeRequest(
      port,
      'POST',
      '/api/v1/compliance/msme/daily-check',
      businessDate ? { business_date: businessDate } : {},
      officerHeaders,
    );
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
      '../../read/projections/msme_ageing_feed.sql',
    ]) {
      await adminPool.query(readFileSync(resolve(__dirname, file), 'utf-8'));
    }
    await adminPool.query('ALTER TABLE audit_log DISABLE TRIGGER ALL');
    await adminPool.query('ALTER TABLE audit_log_tamper_attempt_log DISABLE TRIGGER ALL');
    await adminPool.query('ALTER TABLE audit_log_archive DISABLE TRIGGER ALL');
    try {
      await adminPool.query(
        'TRUNCATE msme_ageing_feed, supplier_invoice_line, supplier_invoice_ingestion, supplier_invoice, po_outbound_message, purchase_order_line, purchase_order, indent_line, indent, supplier, notification_escalations, notification_escalation_defs, notification_deliveries, notification_dispatch_attempts, notification_dispatch_log, notifications, doa_vacation_delegations, doa_registry_entries, transaction_tagging_rules, audit_log_tamper_attempt_log, audit_log_archive, audit_log, user_role_assignments, users, domain_events CASCADE',
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

    await provisionUser(port, `officer-4-6-${run}@example.com`, [
      {
        role: 'procurement_officer_4_6',
        module: 'procurement',
        functionScope: 'write',
        locationId: siteA,
      },
    ]);
    officerHeaders = await authFor(port, `officer-4-6-${run}@example.com`);

    await provisionUser(port, `approver-4-6-${run}@example.com`, [
      {
        role: 'department_head_4_6',
        module: 'procurement',
        functionScope: 'write',
        locationId: '*',
      },
    ]);
    deptHeadHeaders = await authFor(port, `approver-4-6-${run}@example.com`);

    await provisionUser(port, `requester-4-6-${run}@example.com`, [
      {
        role: 'floor_supervisor',
        module: 'procurement',
        functionScope: 'write',
        locationId: siteA,
      },
    ]);
    requesterHeaders = await authFor(port, `requester-4-6-${run}@example.com`);

    await provisionUser(port, `reader-4-6-${run}@example.com`, [
      {
        role: 'procurement_reader_4_6',
        module: 'procurement',
        functionScope: 'read',
        locationId: siteA,
      },
    ]);
    readerHeaders = await authFor(port, `reader-4-6-${run}@example.com`);

    // AC8: the finance compliance escalation target role - provisioned like every other role so
    // the notification target resolves to a real role holder in this environment.
    await provisionUser(port, `finance-4-6-${run}@example.com`, [
      {
        role: 'finance_compliance_officer',
        module: 'procurement',
        functionScope: 'read',
        locationId: '*',
      },
    ]);

    await provisionUser(port, `doa-admin-4-6-${run}@example.com`, [
      {
        role: 'compliance_admin_4_6',
        module: 'compliance',
        functionScope: 'write',
        locationId: '*',
      },
    ]);
    const doaHeaders = await authFor(port, `doa-admin-4-6-${run}@example.com`);
    for (const entry of [
      {
        transaction_type: 'indent_approval',
        role: 'department_head_4_6',
        value_min: 0,
        value_max: null,
      },
      {
        transaction_type: 'purchase_order_approval',
        role: 'department_head_4_6',
        value_min: 0,
        value_max: null,
      },
    ]) {
      const r = await makeRequest(port, 'POST', '/api/v1/doa/entries', entry, doaHeaders);
      assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    }

    supplierCredit30 = await createActiveSupplier('C30', 30, '27ABCDE1234F1Z5');
    supplierCredit60 = await createActiveSupplier('C60', 60, '29FGHIJ5678K2Z6');
    supplierNoCredit = await createActiveSupplier('C0', 0, '24LMNOP9012Q3Z7');
    supplierNonMsme = await createActiveSupplier('NON', 30, '33QRSTU3456V4Z8');
    supplierRevalSoon = await createActiveSupplier('SOON', 30, '06VWXYZ7890A5Z9');
    supplierLapsed = await createActiveSupplier('LAPS', 30, '09BCDEF2345G6Z1');
  });

  after(async () => {
    if (server) await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    await closePool();
    await closeAdminPool();
  });

  // --- AC1 / AC6: Udyam capture and validation gate ---------------------------

  it('AC1: a valid Udyam registration flags the supplier as MSME with classification, certificate, and default annual revalidation date', async () => {
    const res = await verifyMsme(supplierCredit30, {
      udyam_number_ext: 'UDYAM-MH-12-1234567',
      msme_classification: 'micro',
      certificate_reference: `CERT-C30-${run}`,
    });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    const row = await supplierMsmeRow(supplierCredit30);
    assert.strictEqual(row['udyam_number_ext'], 'UDYAM-MH-12-1234567');
    assert.strictEqual(row['msme_classification'], 'micro');
    assert.strictEqual(row['msme_certificate_reference'], `CERT-C30-${run}`);
    assert.strictEqual(row['msme_status'], 'active');
    assert.ok(row['udyam_verified_at']);
    assert.strictEqual(row['udyam_revalidation_due_date'], addYears(istToday, 1));
  });

  it('AC6: a malformed Udyam number is rejected with UDYAM_INVALID and the supplier stays untagged', async () => {
    const res = await verifyMsme(supplierNonMsme, { udyam_number_ext: 'UDYAM-M1-1-BAD' });
    assert.strictEqual(res.status, 400, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'UDYAM_INVALID');
    const row = await supplierMsmeRow(supplierNonMsme);
    assert.strictEqual(row['msme_status'], null);
    assert.strictEqual(row['udyam_number_ext'], null);
  });

  it('AC6: a verification missing the certificate reference or carrying an off-certificate classification is rejected with UDYAM_INVALID', async () => {
    const noCert = await verifyMsme(supplierNonMsme, { certificate_reference: '   ' });
    assert.strictEqual(noCert.status, 400, JSON.stringify(noCert.body));
    assert.strictEqual(noCert.body['error_code'], 'UDYAM_INVALID');

    const badClass = await verifyMsme(supplierNonMsme, { msme_classification: 'gigantic' });
    assert.strictEqual(badClass.status, 400, JSON.stringify(badClass.body));
    assert.strictEqual(badClass.body['error_code'], 'UDYAM_INVALID');

    const row = await supplierMsmeRow(supplierNonMsme);
    assert.strictEqual(row['msme_status'], null);
  });

  // --- AC2: PO confirmation stamping ------------------------------------------

  it('AC2: PO confirmation stamps the agreed date when the credit period is inside the 45-day ceiling', async () => {
    const { poId } = await createIssuedPo(supplierCredit30, 'AC2A');
    const res = await confirmPo(poId);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    const adminPool = getAdminPool();
    const r = await adminPool.query(
      `SELECT statutory_due_date::text AS statutory_due_date, statutory_due_rule_version FROM purchase_order WHERE po_id = $1`,
      [poId],
    );
    assert.strictEqual(r.rows[0]!['statutory_due_date'], addDays(istToday, 30));
    assert.strictEqual(r.rows[0]!['statutory_due_rule_version'], RULE_VERSION);
  });

  it('AC2: the 45-day statutory ceiling caps a longer agreed credit period', async () => {
    const verify = await verifyMsme(supplierCredit60, {
      udyam_number_ext: 'UDYAM-KA-07-7654321',
      msme_classification: 'small',
      certificate_reference: `CERT-C60-${run}`,
    });
    assert.strictEqual(verify.status, 200, JSON.stringify(verify.body));
    const { poId } = await createIssuedPo(supplierCredit60, 'AC2B');
    const res = await confirmPo(poId);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    const adminPool = getAdminPool();
    const r = await adminPool.query(
      `SELECT statutory_due_date::text AS statutory_due_date FROM purchase_order WHERE po_id = $1`,
      [poId],
    );
    assert.strictEqual(r.rows[0]!['statutory_due_date'], addDays(istToday, 45));
  });

  it('AC2: the appointed-day rule stamps 15 days when no credit period exists', async () => {
    const verify = await verifyMsme(supplierNoCredit, {
      udyam_number_ext: 'UDYAM-GJ-03-2468135',
      msme_classification: 'medium',
      certificate_reference: `CERT-C0-${run}`,
    });
    assert.strictEqual(verify.status, 200, JSON.stringify(verify.body));
    const { poId } = await createIssuedPo(supplierNoCredit, 'AC2C');
    const res = await confirmPo(poId);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    const adminPool = getAdminPool();
    const r = await adminPool.query(
      `SELECT statutory_due_date::text AS statutory_due_date FROM purchase_order WHERE po_id = $1`,
      [poId],
    );
    assert.strictEqual(r.rows[0]!['statutory_due_date'], addDays(istToday, 15));
  });

  it('AC2: a non-MSME supplier leaves both statutory columns null at confirmation', async () => {
    const { poId } = await createIssuedPo(supplierNonMsme, 'AC2D');
    const res = await confirmPo(poId);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    const adminPool = getAdminPool();
    const r = await adminPool.query(
      `SELECT statutory_due_date::text AS statutory_due_date, statutory_due_rule_version FROM purchase_order WHERE po_id = $1`,
      [poId],
    );
    assert.strictEqual(r.rows[0]!['statutory_due_date'], null);
    assert.strictEqual(r.rows[0]!['statutory_due_rule_version'], null);
  });

  // --- AC3a: invoice stamping (Story 4.7 AC5 closure) --------------------------

  it('AC3a: invoice capture stamps classification, statutory due date, and rule version anchored on invoice_date', async () => {
    const { poId } = await createIssuedPo(supplierCredit30, 'AC3A');
    const invoiceId = await captureInvoice(
      supplierCredit30,
      poId,
      `INV-46-CAP-${run}`,
      '2026-06-15',
    );
    const row = await invoiceStampRow(invoiceId);
    assert.strictEqual(row['msme_classification_at_capture'], 'micro');
    assert.strictEqual(row['statutory_due_date'], '2026-07-15');
    assert.strictEqual(row['statutory_due_rule_version'], RULE_VERSION);
  });

  it('AC3a: linking an unmatched invoice stamps the snapshot anchored on the invoice own date, not the link date', async () => {
    // Unmatched invoices exist only via the file-ingestion review path (Story 4.7 AC2/AC4).
    const stageRes = await makeRequest(
      port,
      'POST',
      '/api/v1/supplier-invoice-ingestions',
      {
        source_format: 'csv',
        attachment_ref: `att-46-link-${run}`,
        sha256_hash: createHash('sha256').update(`link-46-${run}`).digest('hex'),
        detected_mime: 'text/csv',
        byte_size: 128,
        extracted_draft: {
          supplier_id: supplierCredit30,
          invoice_number_ext: `INV-46-LINK-${run}`,
        },
      },
      officerHeaders,
    );
    assert.strictEqual(stageRes.status, 201, JSON.stringify(stageRes.body));
    const ingestionId = (stageRes.body['ingestion'] as Record<string, unknown>)[
      'ingestion_id'
    ] as string;

    const { poId } = await createIssuedPo(supplierCredit30, 'AC3L');
    const poLine = poLineIndex.get(poId)!;
    const confirmRes = await makeRequest(
      port,
      'POST',
      `/api/v1/supplier-invoice-ingestions/${ingestionId}/confirm`,
      {
        corrected_header: {
          supplier_id: supplierCredit30,
          invoice_number_ext: `INV-46-LINK-${run}`,
          invoice_date: '2026-06-20',
          total_value: 1180,
          subtotal: 1000,
          cgst_total: 90,
          sgst_total: 90,
        },
        corrected_lines: [
          {
            sku: poLine.sku,
            quantity: 2,
            uom: 'KG',
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
    const invoiceId = (confirmRes.body['ingestion'] as Record<string, unknown>)[
      'resulting_invoice_id'
    ] as string;
    assert.ok(invoiceId);
    // The statutory obligation runs from the invoice date with or without a PO, so the unmatched
    // recording already carries the snapshot (same insert seam as capture).
    const preLink = await invoiceStampRow(invoiceId);
    assert.strictEqual(preLink['statutory_due_date'], '2026-07-20');
    assert.strictEqual(preLink['msme_classification_at_capture'], 'micro');

    const linkRes = await makeRequest(
      port,
      'POST',
      `/api/v1/supplier-invoices/${invoiceId}/link-po`,
      { po_id: poId },
      officerHeaders,
    );
    assert.strictEqual(linkRes.status, 200, JSON.stringify(linkRes.body));
    const row = await invoiceStampRow(invoiceId);
    assert.strictEqual(row['msme_classification_at_capture'], 'micro');
    assert.strictEqual(row['statutory_due_date'], '2026-07-20');
    assert.strictEqual(row['statutory_due_rule_version'], RULE_VERSION);
  });

  // --- AC3: ageing report ------------------------------------------------------

  it('AC3: the ageing report tags each line with the MSME classification and computes s.43B(h)/s.16 exposure in SQL', async () => {
    // As-of 40 days past the AC3a capture invoice's 2026-07-15 due date.
    const asOf = addDays('2026-07-15', 40);
    const res = await makeRequest(
      port,
      'GET',
      `/api/v1/compliance/msme/ageing?as_of=${asOf}`,
      undefined,
      readerHeaders,
    );
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body['rule_version'], RULE_VERSION);
    const rows = res.body['rows'] as Record<string, unknown>[];
    const line = rows.find((r) => r['invoice_number_ext'] === `INV-46-CAP-${run}`);
    assert.ok(line, 'ageing must include the captured MSME invoice');
    assert.strictEqual(line['msme_classification'], 'micro');
    assert.strictEqual(line['statutory_due_date'], '2026-07-15');
    assert.strictEqual(line['days_overdue'], 40);
    assert.strictEqual(line['days_to_due'], -40);
    assert.strictEqual(line['s43b_exposure'], true);
    assert.ok(Number(line['s16_interest_exposure']) > 0, JSON.stringify(line));

    // On the due date itself: no overdue, no exposure, zero interest.
    const onDue = await makeRequest(
      port,
      'GET',
      '/api/v1/compliance/msme/ageing?as_of=2026-07-15',
      undefined,
      readerHeaders,
    );
    assert.strictEqual(onDue.status, 200, JSON.stringify(onDue.body));
    const onDueLine = (onDue.body['rows'] as Record<string, unknown>[]).find(
      (r) => r['invoice_number_ext'] === `INV-46-CAP-${run}`,
    );
    assert.ok(onDueLine);
    assert.strictEqual(onDueLine['days_overdue'], 0);
    assert.strictEqual(onDueLine['s43b_exposure'], false);
    assert.strictEqual(onDueLine['s16_interest_exposure'], '0.00');
  });

  // --- AC4: ERP ageing feed ----------------------------------------------------

  it('AC4: a feed run records the classification-tagged ageing payload with timestamp and row count in the append-only ledger', async () => {
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/compliance/msme/ageing-feed/run',
      {},
      officerHeaders,
    );
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    const feedId = res.body['feed_id'] as string;
    assert.ok(feedId);

    const adminPool = getAdminPool();
    const feedRow = await adminPool.query(
      `SELECT payload, row_count, recorded_at FROM msme_ageing_feed WHERE feed_id = $1`,
      [feedId],
    );
    assert.strictEqual(feedRow.rows.length, 1);
    const payload = feedRow.rows[0]!['payload'] as Record<string, unknown>;
    assert.strictEqual(payload['feed_type'], 'msme_ageing');
    const lines = payload['lines'] as Record<string, unknown>[];
    assert.strictEqual(feedRow.rows[0]!['row_count'], lines.length);
    assert.ok(feedRow.rows[0]!['recorded_at']);
    assert.ok(
      lines.every((l) => ['micro', 'small', 'medium'].includes(l['msme_classification'] as string)),
      'every feed line carries an MSME classification tag',
    );

    const evt = await adminPool.query(
      `SELECT payload FROM domain_events WHERE event_type = 'msme_ageing_feed.recorded' AND payload->>'feed_id' = $1`,
      [feedId],
    );
    assert.strictEqual(evt.rows.length, 1);
    assert.strictEqual(
      (evt.rows[0]!['payload'] as Record<string, unknown>)['row_count'],
      lines.length,
    );
  });

  // --- AC5: revalidation alert -------------------------------------------------

  it('AC5: an approaching revalidation date raises a re-verify alert through the notification foundation exactly once', async () => {
    const verify = await verifyMsme(supplierRevalSoon, {
      udyam_number_ext: 'UDYAM-TN-01-1357913',
      msme_classification: 'small',
      certificate_reference: `CERT-SOON-${run}`,
      revalidation_due_date: addDays(istToday, 10),
    });
    assert.strictEqual(verify.status, 200, JSON.stringify(verify.body));

    const check = await runDailyCheck();
    assert.strictEqual(check.status, 200, JSON.stringify(check.body));
    const alerts = check.body['revalidation_alerts'] as Record<string, unknown>[];
    assert.ok(
      alerts.some((a) => a['supplier_id'] === supplierRevalSoon),
      JSON.stringify(alerts),
    );

    const adminPool = getAdminPool();
    const countAlerts = async (): Promise<number> => {
      const r = await adminPool.query(
        `SELECT count(*)::int AS n FROM domain_events
         WHERE event_type = 'notification.created'
           AND payload->>'object_type' = 'supplier_udyam_revalidation'
           AND payload->>'object_id' = $1`,
        [supplierRevalSoon],
      );
      return (r.rows[0] as Record<string, number>)['n']!;
    };
    assert.strictEqual(await countAlerts(), 1);

    // Idempotent per due date: a second daily run does not re-notify.
    const second = await runDailyCheck();
    assert.strictEqual(second.status, 200, JSON.stringify(second.body));
    assert.strictEqual(await countAlerts(), 1);
  });

  // --- AC7: lapse, suspension, warning, conservative treatment ------------------

  it('AC7: a lapsed revalidation suspends the MSME flag with an edit-log row, warns new PO drafts, and keeps stamped dates in force', async () => {
    const verify = await verifyMsme(supplierLapsed, {
      udyam_number_ext: 'UDYAM-WB-19-9753197',
      msme_classification: 'micro',
      certificate_reference: `CERT-LAPS-${run}`,
      revalidation_due_date: addDays(istToday, -1),
    });
    assert.strictEqual(verify.status, 200, JSON.stringify(verify.body));

    // Stamp a due date BEFORE the lapse so conservative treatment is observable.
    const { poId: prePoId } = await createIssuedPo(supplierLapsed, 'AC7PRE');
    const preConfirm = await confirmPo(prePoId);
    assert.strictEqual(preConfirm.status, 200, JSON.stringify(preConfirm.body));
    const adminPool = getAdminPool();
    const stampedBefore = (
      await adminPool.query(
        `SELECT statutory_due_date::text AS d FROM purchase_order WHERE po_id = $1`,
        [prePoId],
      )
    ).rows[0]!['d'] as string;
    assert.ok(stampedBefore);

    const check = await runDailyCheck();
    assert.strictEqual(check.status, 200, JSON.stringify(check.body));
    const suspended = check.body['suspended'] as Record<string, unknown>[];
    assert.ok(
      suspended.some((s) => s['supplier_id'] === supplierLapsed),
      JSON.stringify(suspended),
    );

    const row = await supplierMsmeRow(supplierLapsed);
    assert.strictEqual(row['msme_status'], 'suspended-pending-reverification');

    // FR-AC-13: the suspension is a domain event with its edit-log (audit) row.
    const evt = await adminPool.query(
      `SELECT event_id FROM domain_events WHERE event_type = 'supplier.msme_suspended' AND payload->>'supplier_id' = $1`,
      [supplierLapsed],
    );
    assert.strictEqual(evt.rows.length, 1);
    const auditRow = await adminPool.query(`SELECT 1 FROM audit_log WHERE event_id = $1`, [
      evt.rows[0]!['event_id'],
    ]);
    assert.strictEqual(auditRow.rows.length, 1, 'suspension must write an edit-log row');

    // Already-stamped statutory dates stay in force.
    const stampedAfter = (
      await adminPool.query(
        `SELECT statutory_due_date::text AS d FROM purchase_order WHERE po_id = $1`,
        [prePoId],
      )
    ).rows[0]!['d'] as string;
    assert.strictEqual(stampedAfter, stampedBefore);

    // New PO drafts warn but proceed; confirmation still stamps (conservative treatment).
    const { poId: postPoId, draftBody } = await createIssuedPo(supplierLapsed, 'AC7POST');
    const warning = draftBody['warning'] as Record<string, unknown> | undefined;
    assert.ok(warning, 'draft to a suspended MSME supplier must carry a warning');
    assert.strictEqual(warning['warning_code'], 'MSME_SUPPLIER_SUSPENDED');
    const postConfirm = await confirmPo(postPoId);
    assert.strictEqual(postConfirm.status, 200, JSON.stringify(postConfirm.body));
    const postStamp = (
      await adminPool.query(
        `SELECT statutory_due_date::text AS d FROM purchase_order WHERE po_id = $1`,
        [postPoId],
      )
    ).rows[0]!['d'] as string;
    assert.strictEqual(postStamp, addDays(istToday, 30));
  });

  // --- AC8: statutory breach ---------------------------------------------------

  it('AC8: an invoice past its statutory due date is flagged, accrues s.16 interest from the day after, and escalates once', async () => {
    const { poId } = await createIssuedPo(supplierCredit30, 'AC8');
    const invoiceId = await captureInvoice(
      supplierCredit30,
      poId,
      `INV-46-BREACH-${run}`,
      '2026-01-10',
    );
    const preRow = await invoiceStampRow(invoiceId);
    assert.strictEqual(preRow['statutory_due_date'], '2026-02-09');

    const check = await runDailyCheck();
    assert.strictEqual(check.status, 200, JSON.stringify(check.body));
    const flagged = check.body['breaches_flagged'] as Record<string, unknown>[];
    assert.ok(
      flagged.some((f) => f['invoice_id'] === invoiceId),
      JSON.stringify(flagged),
    );

    const row = await invoiceStampRow(invoiceId);
    assert.strictEqual(row['statutory_breach'], true);

    const adminPool = getAdminPool();
    const countBreachArtifacts = async (): Promise<{ events: number; escalations: number }> => {
      const events = await adminPool.query(
        `SELECT count(*)::int AS n FROM domain_events
         WHERE event_type = 'supplier_invoice.statutory_breach_flagged' AND payload->>'invoice_id' = $1`,
        [invoiceId],
      );
      const escalations = await adminPool.query(
        `SELECT count(*)::int AS n FROM domain_events
         WHERE event_type = 'notification.created'
           AND payload->>'event_type' = 'msme_statutory_breach'
           AND payload->>'object_id' = $1`,
        [invoiceId],
      );
      return {
        events: (events.rows[0] as Record<string, number>)['n']!,
        escalations: (escalations.rows[0] as Record<string, number>)['n']!,
      };
    };
    const first = await countBreachArtifacts();
    assert.strictEqual(first.events, 1);
    assert.strictEqual(first.escalations, 1, 'breach must escalate to the finance compliance role');

    // Interest accrues from the day AFTER the due date: zero on the due date, positive after.
    const dayAfter = await makeRequest(
      port,
      'GET',
      '/api/v1/compliance/msme/ageing?as_of=2026-02-10',
      undefined,
      readerHeaders,
    );
    const dayAfterLine = (dayAfter.body['rows'] as Record<string, unknown>[]).find(
      (r) => r['invoice_number_ext'] === `INV-46-BREACH-${run}`,
    );
    assert.ok(dayAfterLine);
    assert.strictEqual(dayAfterLine['days_overdue'], 1);
    assert.ok(Number(dayAfterLine['s16_interest_exposure']) > 0);
    assert.strictEqual(dayAfterLine['statutory_breach'], true);

    // Idempotent per invoice: a second run neither re-flags nor re-escalates.
    const second = await runDailyCheck();
    assert.strictEqual(second.status, 200, JSON.stringify(second.body));
    const again = await countBreachArtifacts();
    assert.strictEqual(again.events, 1);
    assert.strictEqual(again.escalations, 1);
  });

  // --- Direct event-POST spoof tests (mandatory per 4.7 conventions) -----------

  it('AC6 spoof: a direct event POST cannot bypass the Udyam format gate', async () => {
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/events',
      {
        stream_type: 'procurement',
        stream_id: supplierNonMsme,
        event_type: 'supplier.msme_verified',
        payload: {
          supplier_id: supplierNonMsme,
          udyam_number_ext: 'UDYAM-BAD-FORMAT',
          msme_classification: 'micro',
          certificate_reference: 'CERT-SPOOF',
          verified_at: new Date().toISOString(),
          revalidation_due_date: addYears(istToday, 1),
        },
        metadata: {
          correlation_id: randomUUID(),
          actor: { user_id: randomUUID(), role: 'procurement_officer_4_6', location_id: siteA },
          occurred_at: new Date().toISOString(),
        },
      },
      officerHeaders,
    );
    assert.strictEqual(res.status, 400, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'UDYAM_INVALID');
  });

  it('spoof: malformed suspension and ageing-feed payloads are rejected on the central write path', async () => {
    const badReason = await makeRequest(
      port,
      'POST',
      '/api/v1/events',
      {
        stream_type: 'procurement',
        stream_id: supplierNonMsme,
        event_type: 'supplier.msme_suspended',
        payload: { supplier_id: supplierNonMsme, reason: 'because', lapsed_on: istToday },
        metadata: {
          correlation_id: randomUUID(),
          actor: { user_id: randomUUID(), role: 'procurement_officer_4_6', location_id: siteA },
          occurred_at: new Date().toISOString(),
        },
      },
      officerHeaders,
    );
    assert.strictEqual(badReason.status, 400, JSON.stringify(badReason.body));

    const badCount = await makeRequest(
      port,
      'POST',
      '/api/v1/events',
      {
        stream_type: 'procurement',
        stream_id: randomUUID(),
        event_type: 'msme_ageing_feed.recorded',
        payload: { feed_id: randomUUID(), row_count: -3, generated_at: new Date().toISOString() },
        metadata: {
          correlation_id: randomUUID(),
          actor: { user_id: randomUUID(), role: 'procurement_officer_4_6', location_id: siteA },
          occurred_at: new Date().toISOString(),
        },
      },
      officerHeaders,
    );
    assert.strictEqual(badCount.status, 400, JSON.stringify(badCount.body));
  });

  it('spoof: malformed statutory-breach payloads are rejected on the central write path', async () => {
    const badBreach = await makeRequest(
      port,
      'POST',
      '/api/v1/events',
      {
        stream_type: 'procurement',
        stream_id: randomUUID(),
        event_type: 'supplier_invoice.statutory_breach_flagged',
        payload: {
          invoice_id: 'not-a-uuid',
          supplier_id: randomUUID(),
          statutory_due_date: 'not-a-date',
          detected_on: istToday,
        },
        metadata: {
          correlation_id: randomUUID(),
          actor: { user_id: randomUUID(), role: 'procurement_officer_4_6', location_id: siteA },
          occurred_at: new Date().toISOString(),
        },
      },
      officerHeaders,
    );
    assert.strictEqual(badBreach.status, 400, JSON.stringify(badBreach.body));
    assert.strictEqual(badBreach.body['error_code'], 'INVALID_PARAMS');
  });

  // --- Trailing idempotent replay (mandatory per 4.7 conventions) --------------

  it('idempotent replay: supplier.msme_verified with the same idempotency key persists exactly one event', async () => {
    const envelope = {
      stream_type: 'procurement',
      stream_id: supplierCredit30,
      event_type: 'supplier.msme_verified',
      idempotency_key: `msme-verify-replay-${run}`,
      payload: {
        supplier_id: supplierCredit30,
        udyam_number_ext: 'UDYAM-MH-12-1234567',
        msme_classification: 'micro',
        certificate_reference: `CERT-C30-${run}`,
        verified_at: new Date().toISOString(),
        revalidation_due_date: addYears(istToday, 1),
      },
      metadata: {
        correlation_id: randomUUID(),
        actor: { user_id: randomUUID(), role: 'procurement_officer_4_6', location_id: siteA },
        occurred_at: new Date().toISOString(),
      },
    };
    const first = await makeRequest(port, 'POST', '/api/v1/events', envelope, officerHeaders);
    assert.ok(first.status >= 200 && first.status < 300, JSON.stringify(first.body));
    const second = await makeRequest(port, 'POST', '/api/v1/events', envelope, officerHeaders);
    assert.ok(second.status >= 200 && second.status < 300, JSON.stringify(second.body));

    const adminPool = getAdminPool();
    const count = await adminPool.query(
      `SELECT count(*)::int AS n FROM domain_events WHERE idempotency_key = $1`,
      [`msme-verify-replay-${run}`],
    );
    assert.strictEqual((count.rows[0] as Record<string, number>)['n'], 1);

    // The replay leaves the supplier exactly as verified - still active MSME.
    const row = await supplierMsmeRow(supplierCredit30);
    assert.strictEqual(row['msme_status'], 'active');
  });
});
