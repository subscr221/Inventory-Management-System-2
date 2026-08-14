import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request as httpRequest, type Server, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createAppRouter, createAppServer } from '../../src/server.js';
import { closePool, getPool, getAdminPool, closeAdminPool } from '../../src/config/db.js';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const run = randomUUID().slice(0, 8);

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

async function authFor(port: number, sub: string): Promise<Record<string, string>> {
  const res = await makeRequest(port, 'POST', '/api/v1/auth/dev-token', { sub });
  assert.ok(
    res.status >= 200 && res.status < 300,
    `dev-token ${sub} failed: ${JSON.stringify(res.body)}`,
  );
  return { Authorization: `Bearer ${res.body['token'] as string}` };
}

interface Role {
  role: string;
  module: string;
  functionScope: 'read' | 'write';
  locationId: string;
}

async function provisionUser(port: number, externalId: string, roles: Role[]): Promise<string> {
  const res = await makeRequest(
    port,
    'POST',
    '/api/v1/scim/v2/Users',
    {
      externalId,
      email: externalId,
      displayName: externalId,
      roles,
    },
    { Authorization: 'Bearer test-only-scim-bearer-token-not-for-production-use' },
  );
  assert.strictEqual(
    res.status,
    201,
    `provision ${externalId} failed: ${JSON.stringify(res.body)}`,
  );
  return (res.body as Record<string, string>)['userId']!;
}

describe('Story 5.3 ECO Workflow and Where-Used Impact Integration Tests', () => {
  let server: Server;
  let port: number;
  let engineerHeaders: Record<string, string>;
  let readerHeaders: Record<string, string>;
  let noRoleHeaders: Record<string, string>;
  let approverUserId: string;

  async function createItem(sku: string, overrides: Record<string, unknown> = {}): Promise<string> {
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/items',
      {
        sku,
        description: `Test item ${sku}`,
        valuation_method: 'fifo',
        uom: 'EA',
        business_stream: 'production',
        category: 'raw_materials',
        // Story 5.6 fixture setup: a usable Ind AS 2 rate on every component, so a cost
        // rollup over these BOMs has missing_rate_count 0 and satisfies the release gate.
        standard_cost_designation: 'ind_as_2_para_21_measurement_technique',
        standard_cost_amount: 10,
        ...overrides,
      },
      engineerHeaders,
    );
    assert.strictEqual(res.status, 201, `item ${sku} failed: ${JSON.stringify(res.body)}`);
    return (res.body as Record<string, string>)['item_id']!;
  }

  /**
   * Story 5.6 fixture setup: cost_rollup_complete is now an ENFORCED release-gate condition, so
   * every fixture that reaches 'released' must first take a complete rollup. Deliberately
   * non-asserting - it is also called on BOMs whose release is expected to fail for an unrelated
   * reason. No assertion in this suite is weakened by it.
   */
  async function primeCostRollup(bomId: string): Promise<void> {
    await makeRequest(
      port,
      'POST',
      `/api/v1/boms/${bomId}/cost-rollups`,
      { idempotency_key: randomUUID() },
      engineerHeaders,
    );
  }

  interface DraftOptions {
    scrapPercent?: string | undefined;
  }

  async function draftAndReleaseBom(
    parentItemId: string,
    componentItemIds: string[],
    options: DraftOptions = {},
  ): Promise<{ bomId: string; revisionId: string; parentSku: string }> {
    const draftRes = await makeRequest(
      port,
      'POST',
      '/api/v1/boms',
      {
        parent_item_id: parentItemId,
        revision_code: 'A',
        bom_type: 'production',
        lines: componentItemIds.map((componentItemId, index) => ({
          line_no: index + 1,
          component_item_id: componentItemId,
          output_class: 'component',
          quantity_per: '2.0',
          line_uom: 'EA',
          uom_conversion_factor: '1.0',
          scrap_percent: 'scrapPercent' in options ? options.scrapPercent : '5.0',
          is_phantom: false,
          effective_from: '2026-01-01',
        })),
      },
      engineerHeaders,
    );
    assert.strictEqual(draftRes.status, 201, `draft failed: ${JSON.stringify(draftRes.body)}`);
    const bomId = draftRes.body['bom_id'] as string;
    const parentSku = draftRes.body['parent_sku'] as string;

    await primeCostRollup(bomId);
    const releaseRes = await makeRequest(
      port,
      'POST',
      `/api/v1/boms/${bomId}/release`,
      { idempotency_key: randomUUID() },
      engineerHeaders,
    );
    assert.strictEqual(
      releaseRes.status,
      200,
      `release failed: ${JSON.stringify(releaseRes.body)}`,
    );
    const revisionId = releaseRes.body['current_revision_id'] as string;

    return { bomId, revisionId, parentSku };
  }

  async function raiseEco(
    bomId: string,
    changes: Record<string, unknown>[],
    overrides: Record<string, unknown> = {},
  ): Promise<HttpResult> {
    return makeRequest(
      port,
      'POST',
      '/api/v1/ecos',
      {
        bom_id: bomId,
        reason: 'Engineering change for test',
        changes,
        idempotency_key: randomUUID(),
        ...overrides,
      },
      engineerHeaders,
    );
  }

  async function seedStock(
    sku: string,
    locationId: string,
    lotId: string | null,
    onHand: string,
  ): Promise<void> {
    await getPool().query(
      `INSERT INTO stock_balance (sku, location_id, lot_id, stock_class, on_hand)
       VALUES ($1, $2, $3, 'owned', $4)`,
      [sku, locationId, lotId, onHand],
    );
  }

  async function seedOpenPo(
    poNumberExt: string,
    supplierRefExt: string,
    sku: string,
    openQty: string,
  ): Promise<void> {
    await getPool().query(
      `INSERT INTO erp_purchase_order (po_number_ext, supplier_ref_ext, currency, status, source_system, last_synced_at)
       VALUES ($1, $2, 'INR', 'open', 'ERP', now())`,
      [poNumberExt, supplierRefExt],
    );
    await getPool().query(
      `INSERT INTO erp_purchase_order_line (po_number_ext, line_no, sku, ordered_qty, open_qty, unit_price, source_system, last_synced_at)
       VALUES ($1, 1, $2, 10, $3, 100, 'ERP', now())`,
      [poNumberExt, sku, openQty],
    );
  }

  before(async () => {
    const pool = getPool();
    await pool.query(`SET search_path TO public`);

    const adminPool = getAdminPool();
    for (const sqlFile of [
      'read/projections/item_master.sql',
      'read/projections/business_stream_config.sql',
      'read/projections/bom.sql',
      'read/projections/bom_revision.sql',
      'read/projections/bom_line.sql',
      'read/projections/bom_structure.sql',
      'read/projections/eco.sql',
      'read/projections/eco_change_line.sql',
      'read/projections/eco_stock_disposition.sql',
      'read/projections/stock_balance.sql',
      'read/projections/erp_purchase_order.sql',
    ]) {
      const sql = readFileSync(resolve(__dirname, `../../${sqlFile}`), 'utf-8');
      await adminPool.query(sql);
    }

    const app = createAppRouter();
    server = createAppServer(app);
    await new Promise<void>((resolvePromise) => {
      server.listen(0, () => {
        resolvePromise();
      });
    });
    port = (server.address() as AddressInfo).port;

    await provisionUser(port, `engineer53-${run}@test.com`, [
      { role: 'engineering_admin', module: 'engineering', functionScope: 'write', locationId: '*' },
      {
        role: 'inventory_controller',
        module: 'inventory',
        functionScope: 'write',
        locationId: '*',
      },
    ]);
    await provisionUser(port, `reader53-${run}@test.com`, [
      { role: 'bom_viewer', module: 'engineering', functionScope: 'read', locationId: '*' },
    ]);
    await provisionUser(port, `norole53-${run}@test.com`, [
      { role: 'nothing_53', module: 'unrelated_module', functionScope: 'read', locationId: '*' },
    ]);

    engineerHeaders = await authFor(port, `engineer53-${run}@test.com`);
    readerHeaders = await authFor(port, `reader53-${run}@test.com`);
    noRoleHeaders = await authFor(port, `norole53-${run}@test.com`);

    // DOA registry: an unbounded eco_approval entry resolved to a dedicated approver role/user
    // (AC 7). Mirrors the story-4-3 DOA fixture pattern.
    await provisionUser(port, `doa-admin-5-3-${run}@test.com`, [
      {
        role: 'compliance_admin_5_3',
        module: 'compliance',
        functionScope: 'write',
        locationId: '*',
      },
    ]);
    const doaHeaders = await authFor(port, `doa-admin-5-3-${run}@test.com`);
    const entryRes = await makeRequest(
      port,
      'POST',
      '/api/v1/doa/entries',
      {
        transaction_type: 'eco_approval',
        role: 'eco_approver_5_3',
        value_min: null,
        value_max: null,
      },
      doaHeaders,
    );
    assert.strictEqual(entryRes.status, 201, JSON.stringify(entryRes.body));

    approverUserId = await provisionUser(port, `approver53-${run}@test.com`, [
      { role: 'eco_approver_5_3', module: 'engineering', functionScope: 'write', locationId: '*' },
    ]);
  });

  after(async () => {
    server.close();
    const admin = await getAdminPool().connect();
    try {
      // doa_registry_entries/user_role_assignments/users are also truncated: this suite's DOA
      // fixture and approver role are shared, unscoped names ('eco_approval', 'eco_approver_5_3')
      // - without this, a repeat run resolves findRoleHolder's "earliest-assigned holder" to a
      // PRIOR run's approver user (the story-4-3 precedent for this exact pollution class).
      await admin.query(
        'TRUNCATE TABLE eco_stock_disposition, eco_change_line, eco, bom_line, bom_revision, bom_structure, bom, stock_balance, erp_purchase_order_line, erp_purchase_order, doa_vacation_delegations, doa_registry_entries, user_role_assignments, users RESTART IDENTITY CASCADE',
      );
    } finally {
      admin.release();
    }
    await closePool();
    await closeAdminPool();
  });

  let approverHeaders: Record<string, string>;

  before(async () => {
    approverHeaders = await authFor(port, `approver53-${run}@test.com`);
  });

  // --- AC 1: raise -----------------------------------------------------------

  it('raises an ECO against a Released BOM, landing draft with change lines and a resolved approver', async () => {
    const parentId = await createItem(`E1-PARENT-${run}`, { category: 'finished_goods' });
    const componentId = await createItem(`E1-COMP-${run}`);
    const newComponentId = await createItem(`E1-NEWCOMP-${run}`);
    const { bomId, revisionId } = await draftAndReleaseBom(parentId, [componentId]);

    const res = await raiseEco(bomId, [
      {
        change_type: 'add',
        component_item_id: newComponentId,
        output_class: 'component',
        quantity_per: '1.0',
        line_uom: 'EA',
        uom_conversion_factor: '1.0',
        scrap_percent: '0.0',
        is_phantom: false,
        effective_from: '2026-02-01',
      },
    ]);
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    assert.strictEqual(res.body['status'], 'draft');
    assert.strictEqual(res.body['bom_id'], bomId);
    assert.strictEqual(res.body['target_revision_id'], revisionId);
    assert.ok(res.body['approver_actor_id'], 'approver_actor_id should be resolved at raise time');
    assert.strictEqual(res.body['approver_actor_id'], approverUserId);

    const ecoId = res.body['eco_id'] as string;
    const getRes = await makeRequest(
      port,
      'GET',
      `/api/v1/ecos/${ecoId}`,
      undefined,
      engineerHeaders,
    );
    assert.strictEqual(getRes.status, 200);
    const changes = getRes.body['changes'] as Record<string, unknown>[];
    assert.strictEqual(changes.length, 1);
    assert.strictEqual(changes[0]!['change_type'], 'add');
  });

  it('rejects raising an ECO against a Draft BOM with BOM_NOT_RELEASED', async () => {
    const parentId = await createItem(`E2-PARENT-${run}`, { category: 'finished_goods' });
    const componentId = await createItem(`E2-COMP-${run}`);
    const draftRes = await makeRequest(
      port,
      'POST',
      '/api/v1/boms',
      {
        parent_item_id: parentId,
        revision_code: 'A',
        lines: [
          {
            line_no: 1,
            component_item_id: componentId,
            output_class: 'component',
            quantity_per: '1.0',
            line_uom: 'EA',
            uom_conversion_factor: '1.0',
            scrap_percent: '0.0',
            is_phantom: false,
            effective_from: '2026-01-01',
          },
        ],
      },
      engineerHeaders,
    );
    assert.strictEqual(draftRes.status, 201, JSON.stringify(draftRes.body));
    const bomId = draftRes.body['bom_id'] as string;

    const res = await raiseEco(bomId, [
      { change_type: 'retire', target_bom_line_id: randomUUID() },
    ]);
    assert.strictEqual(res.status, 409, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'BOM_NOT_RELEASED');
  });

  it('rejects raising an ECO whose target_revision_id belongs to another BOM', async () => {
    const parentId1 = await createItem(`E3A-PARENT-${run}`, { category: 'finished_goods' });
    const parentId2 = await createItem(`E3B-PARENT-${run}`, { category: 'finished_goods' });
    const componentId = await createItem(`E3-COMP-${run}`);
    const bom1 = await draftAndReleaseBom(parentId1, [componentId]);
    const bom2 = await draftAndReleaseBom(parentId2, [componentId]);

    const res = await raiseEco(
      bom1.bomId,
      [{ change_type: 'retire', target_bom_line_id: randomUUID() }],
      {
        target_revision_id: bom2.revisionId,
      },
    );
    assert.strictEqual(res.status, 400, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'INVALID_PARAMS');
  });

  // --- Full lifecycle happy path ----------------------------------------------

  it('runs the full chain draft -> under_review -> approved -> dispositions -> implemented', async () => {
    const parentId = await createItem(`E4-PARENT-${run}`, { category: 'finished_goods' });
    const componentId = await createItem(`E4-COMP-${run}`);
    const amendComponentId = await createItem(`E4-AMEND-COMP-${run}`);
    const newComponentId = await createItem(`E4-NEW-COMP-${run}`);
    const { bomId, revisionId, parentSku } = await draftAndReleaseBom(parentId, [
      componentId,
      amendComponentId,
    ]);

    const structureRes = await makeRequest(
      port,
      'GET',
      `/api/v1/boms/${bomId}/structure`,
      undefined,
      engineerHeaders,
    );
    const oldLines = structureRes.body['lines'] as Record<string, unknown>[];
    const amendLine = oldLines.find((l) => l['component_item_id'] === amendComponentId)!;
    const retireLine = oldLines.find((l) => l['component_item_id'] === componentId)!;

    const raiseRes = await raiseEco(bomId, [
      {
        change_type: 'add',
        component_item_id: newComponentId,
        output_class: 'component',
        quantity_per: '3.0',
        line_uom: 'EA',
        uom_conversion_factor: '1.0',
        scrap_percent: '1.0',
        is_phantom: false,
        effective_from: '2026-02-01',
      },
      {
        change_type: 'amend',
        target_bom_line_id: amendLine['bom_line_id'],
        quantity_per: '9.0',
      },
      {
        change_type: 'retire',
        target_bom_line_id: retireLine['bom_line_id'],
      },
    ]);
    assert.strictEqual(raiseRes.status, 201, JSON.stringify(raiseRes.body));
    const ecoId = raiseRes.body['eco_id'] as string;

    const reviewRes = await makeRequest(
      port,
      'POST',
      `/api/v1/ecos/${ecoId}/review`,
      { idempotency_key: randomUUID() },
      engineerHeaders,
    );
    assert.strictEqual(reviewRes.status, 200, JSON.stringify(reviewRes.body));
    assert.strictEqual(reviewRes.body['status'], 'under_review');

    // AC 7: an approval by a user outside the resolved chain is rejected.
    const wrongApproveRes = await makeRequest(
      port,
      'POST',
      `/api/v1/ecos/${ecoId}/approve`,
      { idempotency_key: randomUUID() },
      engineerHeaders,
    );
    assert.strictEqual(wrongApproveRes.status, 403, JSON.stringify(wrongApproveRes.body));
    assert.strictEqual(wrongApproveRes.body['error_code'], 'APPROVAL_REQUIRED');

    const approveRes = await makeRequest(
      port,
      'POST',
      `/api/v1/ecos/${ecoId}/approve`,
      { idempotency_key: randomUUID() },
      approverHeaders,
    );
    assert.strictEqual(approveRes.status, 200, JSON.stringify(approveRes.body));
    assert.strictEqual(approveRes.body['status'], 'approved');

    // AC 3: approved but not implemented leaves the target BOM byte-identical.
    const bomBeforeImplement = await makeRequest(
      port,
      'GET',
      `/api/v1/boms/${bomId}`,
      undefined,
      engineerHeaders,
    );
    assert.strictEqual(bomBeforeImplement.body['current_revision_id'], revisionId);
    const linesBeforeImplement = await makeRequest(
      port,
      'GET',
      `/api/v1/boms/${bomId}/structure`,
      undefined,
      engineerHeaders,
    );
    assert.deepStrictEqual(linesBeforeImplement.body['lines'], oldLines);

    // Seed on-hand stock for the parent SKU so a disposition decision is required.
    const locationId = randomUUID();
    await seedStock(parentSku, locationId, `LOT-E4-${run}`, '5.000000');

    // AC 6: implement from approved-but-undisposed rejects DISPOSITION_REQUIRED.
    const implementNoDispositionRes = await makeRequest(
      port,
      'POST',
      `/api/v1/ecos/${ecoId}/implement`,
      { idempotency_key: randomUUID() },
      engineerHeaders,
    );
    assert.strictEqual(
      implementNoDispositionRes.status,
      409,
      JSON.stringify(implementNoDispositionRes.body),
    );
    assert.strictEqual(implementNoDispositionRes.body['error_code'], 'DISPOSITION_REQUIRED');
    const pendingLots = (implementNoDispositionRes.body['details'] as Record<string, unknown>)[
      'pending_lots'
    ] as Record<string, unknown>[];
    assert.strictEqual(pendingLots.length, 1);

    const dispositionRes = await makeRequest(
      port,
      'POST',
      `/api/v1/ecos/${ecoId}/dispositions`,
      {
        idempotency_key: randomUUID(),
        dispositions: [
          {
            lot_id: `LOT-E4-${run}`,
            sku: parentSku,
            location_id: locationId,
            disposition: 'use_up',
          },
        ],
      },
      engineerHeaders,
    );
    assert.strictEqual(dispositionRes.status, 200, JSON.stringify(dispositionRes.body));
    const savedDispositions = dispositionRes.body['dispositions'] as Record<string, unknown>[];
    assert.strictEqual(savedDispositions.length, 1);
    assert.strictEqual(savedDispositions[0]!['on_hand_qty'], '5.000000');

    const implementRes = await makeRequest(
      port,
      'POST',
      `/api/v1/ecos/${ecoId}/implement`,
      { idempotency_key: randomUUID() },
      engineerHeaders,
    );
    assert.strictEqual(implementRes.status, 200, JSON.stringify(implementRes.body));
    assert.strictEqual(implementRes.body['status'], 'implemented');
    const newRevisionId = implementRes.body['new_revision_id'] as string;
    assert.ok(newRevisionId && newRevisionId !== revisionId);

    // AC 4: a new released revision was created, the prior revision retained immutably.
    const bomAfter = await makeRequest(
      port,
      'GET',
      `/api/v1/boms/${bomId}`,
      undefined,
      engineerHeaders,
    );
    assert.strictEqual(bomAfter.body['current_revision_id'], newRevisionId);
    assert.strictEqual(bomAfter.body['status'], 'released');

    const structureAfter = await makeRequest(
      port,
      'GET',
      `/api/v1/boms/${bomId}/structure`,
      undefined,
      engineerHeaders,
    );
    const revisions = structureAfter.body['revisions'] as Record<string, unknown>[];
    const newRevisionRow = revisions.find((r) => r['revision_id'] === newRevisionId)!;
    assert.strictEqual(newRevisionRow['source_eco_id'], ecoId);
    assert.strictEqual(newRevisionRow['revision_status'], 'released');

    const oldRevisionRow = revisions.find((r) => r['revision_id'] === revisionId)!;
    assert.strictEqual(oldRevisionRow['revision_status'], 'released');

    // The superseded revision's own bom_line rows are untouched.
    const oldLinesAfter = await getPool().query(
      `SELECT * FROM bom_line WHERE revision_id = $1 ORDER BY line_no`,
      [revisionId],
    );
    assert.strictEqual(oldLinesAfter.rows.length, oldLines.length);

    // The new revision reflects add/amend/retire.
    const newLines = await getPool().query(
      `SELECT * FROM bom_line WHERE revision_id = $1 ORDER BY line_no`,
      [newRevisionId],
    );
    const addedLine = newLines.rows.find((l) => l.component_item_id === newComponentId);
    assert.ok(addedLine, 'added component should be present on the new revision');
    const amendedLine = newLines.rows.find((l) => l.component_item_id === amendComponentId);
    assert.strictEqual(amendedLine?.quantity_per, '9.000000');
    const retiredLine = newLines.rows.find((l) => l.component_item_id === componentId);
    assert.ok(
      retiredLine?.effective_to,
      'retired line should carry a closed effectivity, never be deleted',
    );
  });

  it('rejects implementation from under_review with ECO_STATE_INVALID', async () => {
    const parentId = await createItem(`E5-PARENT-${run}`, { category: 'finished_goods' });
    const componentId = await createItem(`E5-COMP-${run}`);
    const { bomId } = await draftAndReleaseBom(parentId, [componentId]);
    const raiseRes = await raiseEco(bomId, [
      { change_type: 'retire', target_bom_line_id: randomUUID() },
    ]);
    const ecoId = raiseRes.body['eco_id'] as string;
    await makeRequest(port, 'POST', `/api/v1/ecos/${ecoId}/review`, {}, engineerHeaders);

    const implementRes = await makeRequest(
      port,
      'POST',
      `/api/v1/ecos/${ecoId}/implement`,
      {},
      engineerHeaders,
    );
    assert.strictEqual(implementRes.status, 409, JSON.stringify(implementRes.body));
    assert.strictEqual(implementRes.body['error_code'], 'ECO_STATE_INVALID');
  });

  it('accepts use_up, scrap, and rework dispositions; rework without rework_reference is rejected', async () => {
    const parentId = await createItem(`E6-PARENT-${run}`, { category: 'finished_goods' });
    const componentId = await createItem(`E6-COMP-${run}`);
    const { bomId, parentSku } = await draftAndReleaseBom(parentId, [componentId]);
    const raiseRes = await raiseEco(bomId, [
      {
        change_type: 'add',
        component_item_id: await createItem(`E6-NEW-${run}`),
        output_class: 'component',
        quantity_per: '1.0',
        line_uom: 'EA',
        uom_conversion_factor: '1.0',
        scrap_percent: '0.0',
        is_phantom: false,
        effective_from: '2026-02-01',
      },
    ]);
    const ecoId = raiseRes.body['eco_id'] as string;
    await makeRequest(port, 'POST', `/api/v1/ecos/${ecoId}/review`, {}, engineerHeaders);
    await makeRequest(port, 'POST', `/api/v1/ecos/${ecoId}/approve`, {}, approverHeaders);

    const locUseUp = randomUUID();
    const locScrap = randomUUID();
    const locRework = randomUUID();
    await seedStock(parentSku, locUseUp, `LOT-E6-U-${run}`, '1');
    await seedStock(parentSku, locScrap, `LOT-E6-S-${run}`, '1');
    await seedStock(parentSku, locRework, `LOT-E6-R-${run}`, '1');

    const badReworkRes = await makeRequest(
      port,
      'POST',
      `/api/v1/ecos/${ecoId}/dispositions`,
      {
        dispositions: [
          {
            lot_id: `LOT-E6-U-${run}`,
            sku: parentSku,
            location_id: locUseUp,
            disposition: 'use_up',
          },
          {
            lot_id: `LOT-E6-S-${run}`,
            sku: parentSku,
            location_id: locScrap,
            disposition: 'scrap',
          },
          {
            lot_id: `LOT-E6-R-${run}`,
            sku: parentSku,
            location_id: locRework,
            disposition: 'rework',
          },
        ],
      },
      engineerHeaders,
    );
    assert.strictEqual(badReworkRes.status, 400, JSON.stringify(badReworkRes.body));

    const goodRes = await makeRequest(
      port,
      'POST',
      `/api/v1/ecos/${ecoId}/dispositions`,
      {
        dispositions: [
          {
            lot_id: `LOT-E6-U-${run}`,
            sku: parentSku,
            location_id: locUseUp,
            disposition: 'use_up',
          },
          {
            lot_id: `LOT-E6-S-${run}`,
            sku: parentSku,
            location_id: locScrap,
            disposition: 'scrap',
          },
          {
            lot_id: `LOT-E6-R-${run}`,
            sku: parentSku,
            location_id: locRework,
            disposition: 'rework',
            rework_reference: 'RWK-1',
          },
        ],
      },
      engineerHeaders,
    );
    assert.strictEqual(goodRes.status, 200, JSON.stringify(goodRes.body));
    assert.strictEqual((goodRes.body['dispositions'] as unknown[]).length, 3);
  });

  it('cancels from draft, under_review, and approved; implement/review on a cancelled ECO reject ECO_STATE_INVALID', async () => {
    const parentId = await createItem(`E7-PARENT-${run}`, { category: 'finished_goods' });
    const componentId = await createItem(`E7-COMP-${run}`);
    const { bomId } = await draftAndReleaseBom(parentId, [componentId]);

    const draftRes = await raiseEco(bomId, [
      { change_type: 'retire', target_bom_line_id: randomUUID() },
    ]);
    const draftEcoId = draftRes.body['eco_id'] as string;
    const cancelDraft = await makeRequest(
      port,
      'POST',
      `/api/v1/ecos/${draftEcoId}/cancel`,
      { cancel_reason: 'no longer needed' },
      engineerHeaders,
    );
    assert.strictEqual(cancelDraft.status, 200, JSON.stringify(cancelDraft.body));
    assert.strictEqual(cancelDraft.body['status'], 'cancelled');

    const reviewOnCancelled = await makeRequest(
      port,
      'POST',
      `/api/v1/ecos/${draftEcoId}/review`,
      {},
      engineerHeaders,
    );
    assert.strictEqual(reviewOnCancelled.status, 409);
    assert.strictEqual(reviewOnCancelled.body['error_code'], 'ECO_STATE_INVALID');

    const reviewingRes = await raiseEco(bomId, [
      { change_type: 'retire', target_bom_line_id: randomUUID() },
    ]);
    const reviewingEcoId = reviewingRes.body['eco_id'] as string;
    await makeRequest(port, 'POST', `/api/v1/ecos/${reviewingEcoId}/review`, {}, engineerHeaders);
    const cancelReviewing = await makeRequest(
      port,
      'POST',
      `/api/v1/ecos/${reviewingEcoId}/cancel`,
      { cancel_reason: 'superseded' },
      engineerHeaders,
    );
    assert.strictEqual(cancelReviewing.status, 200, JSON.stringify(cancelReviewing.body));

    const approvedRes = await raiseEco(bomId, [
      { change_type: 'retire', target_bom_line_id: randomUUID() },
    ]);
    const approvedEcoId = approvedRes.body['eco_id'] as string;
    await makeRequest(port, 'POST', `/api/v1/ecos/${approvedEcoId}/review`, {}, engineerHeaders);
    await makeRequest(port, 'POST', `/api/v1/ecos/${approvedEcoId}/approve`, {}, approverHeaders);
    const cancelApproved = await makeRequest(
      port,
      'POST',
      `/api/v1/ecos/${approvedEcoId}/cancel`,
      { cancel_reason: 'business decision reversed' },
      engineerHeaders,
    );
    assert.strictEqual(cancelApproved.status, 200, JSON.stringify(cancelApproved.body));

    const implementOnCancelled = await makeRequest(
      port,
      'POST',
      `/api/v1/ecos/${approvedEcoId}/implement`,
      {},
      engineerHeaders,
    );
    assert.strictEqual(implementOnCancelled.status, 409);
    assert.strictEqual(implementOnCancelled.body['error_code'], 'ECO_STATE_INVALID');
  });

  // --- AC 9: approved-ECO release gate ----------------------------------------

  it('gates a second BOM revision release on an approved ECO, exempts the first release', async () => {
    const parentId = await createItem(`E8-PARENT-${run}`, { category: 'finished_goods' });
    const componentId = await createItem(`E8-COMP-${run}`);
    // First release: exempt (zero prior released revisions), succeeds without any ECO.
    const { bomId, revisionId } = await draftAndReleaseBom(parentId, [componentId]);

    const checklist = await makeRequest(
      port,
      'GET',
      `/api/v1/boms/${bomId}/release-gate`,
      undefined,
      engineerHeaders,
    );
    const approvedEcoCondition = (checklist.body['conditions'] as Record<string, unknown>[]).find(
      (c) => c['condition'] === 'approved_eco',
    );
    assert.strictEqual(approvedEcoCondition?.['met'], true, 'exempt on first release');
    assert.strictEqual(approvedEcoCondition?.['enforced'], true);

    // Directly attempt to release the ALREADY-released BOM a second time is not meaningful via
    // the API (release only fires from draft/on_hold); instead verify the gate predicate blocks
    // by simulating a fresh draft revision with a prior released revision and no ECO. We do this
    // by creating a second BOM header sharing the pattern: raise+implement an ECO to create
    // revision B (source_eco_id set), then insert a raw draft revision C with no source_eco_id
    // and attempt to release it - this must be blocked RELEASE_GATE_UNMET naming approved_eco.
    const structureForGateTest = await makeRequest(
      port,
      'GET',
      `/api/v1/boms/${bomId}/structure`,
      undefined,
      engineerHeaders,
    );
    const realLineId = (structureForGateTest.body['lines'] as Record<string, unknown>[])[0]![
      'bom_line_id'
    ];

    const raiseRes = await raiseEco(bomId, [
      { change_type: 'retire', target_bom_line_id: realLineId },
    ]);
    const ecoId = raiseRes.body['eco_id'] as string;
    await makeRequest(port, 'POST', `/api/v1/ecos/${ecoId}/review`, {}, engineerHeaders);
    await makeRequest(port, 'POST', `/api/v1/ecos/${ecoId}/approve`, {}, approverHeaders);
    const implementRes = await makeRequest(
      port,
      'POST',
      `/api/v1/ecos/${ecoId}/implement`,
      {},
      engineerHeaders,
    );
    assert.strictEqual(implementRes.status, 200, JSON.stringify(implementRes.body));
    const revisionB = implementRes.body['new_revision_id'] as string;
    assert.notStrictEqual(revisionB, revisionId);

    // Manufacture a third, DRAFT revision with no source_eco_id to exercise the gate directly
    // (there is no product surface to draft a second revision outside the ECO path today).
    const revisionC = randomUUID();
    await getPool().query(
      `INSERT INTO bom_revision (revision_id, bom_id, revision_code, revision_status, drafted_by, drafted_at, source_event_id)
       VALUES ($1, $2, 'C', 'draft', $3, now(), $4)`,
      [revisionC, bomId, randomUUID(), randomUUID()],
    );
    await getPool().query(
      `UPDATE bom SET current_revision_id = $1, status = 'draft' WHERE bom_id = $2`,
      [revisionC, bomId],
    );
    // The gate's "no lines" precondition (evaluated before approved_eco) needs at least one line.
    await getPool().query(
      `INSERT INTO bom_line (bom_line_id, revision_id, bom_id, line_no, component_item_id, component_sku, output_class, quantity_per, line_uom, uom_conversion_factor, base_quantity_per, scrap_percent, is_phantom, effective_from, source_event_id)
       SELECT gen_random_uuid(), $1, bom_id, line_no, component_item_id, component_sku, output_class, quantity_per, line_uom, uom_conversion_factor, base_quantity_per, scrap_percent, is_phantom, effective_from, source_event_id
         FROM bom_line WHERE revision_id = $2`,
      [revisionC, revisionB],
    );

    await primeCostRollup(bomId);
    const blockedRelease = await makeRequest(
      port,
      'POST',
      `/api/v1/boms/${bomId}/release`,
      { idempotency_key: randomUUID() },
      engineerHeaders,
    );
    assert.strictEqual(blockedRelease.status, 409, JSON.stringify(blockedRelease.body));
    assert.strictEqual(blockedRelease.body['error_code'], 'RELEASE_GATE_UNMET');
    const unmet = (blockedRelease.body['details'] as Record<string, unknown>)[
      'unmet_conditions'
    ] as string[];
    assert.ok(
      unmet.includes('approved_eco'),
      `approved_eco should be named: ${JSON.stringify(unmet)}`,
    );
  });

  // --- AC 2: where-used and impact ---------------------------------------------

  it('returns affected BOMs, stock rows, and open-PO rows for a two-level structure', async () => {
    const leafItemId = await createItem(`E9-LEAF-${run}`);
    const midItemId = await createItem(`E9-MID-${run}`, { category: 'finished_goods' });
    const topItemId = await createItem(`E9-TOP-${run}`, { category: 'finished_goods' });

    const midBom = await draftAndReleaseBom(midItemId, [leafItemId]);
    const topBom = await draftAndReleaseBom(topItemId, [midItemId]);

    await seedStock(midBom.parentSku, randomUUID(), `LOT-E9-${run}`, '2');
    await seedOpenPo(`PO-E9-${run}`, `SUP-E9-${run}`, midBom.parentSku, '4');

    const raiseRes = await raiseEco(midBom.bomId, [
      { change_type: 'retire', target_bom_line_id: randomUUID() },
    ]);
    const ecoId = raiseRes.body['eco_id'] as string;

    const impactRes = await makeRequest(
      port,
      'GET',
      `/api/v1/ecos/${ecoId}/impact`,
      undefined,
      engineerHeaders,
    );
    assert.strictEqual(impactRes.status, 200, JSON.stringify(impactRes.body));
    const affectedBoms = impactRes.body['affected_boms'] as Record<string, unknown>[];
    assert.ok(
      affectedBoms.some((b) => b['bom_id'] === topBom.bomId),
      `top-level assembly should be reported as affected: ${JSON.stringify(affectedBoms)}`,
    );
    const stockImpact = impactRes.body['stock_impact'] as Record<string, unknown>[];
    assert.ok(stockImpact.some((s) => s['sku'] === midBom.parentSku));
    const openPoImpact = impactRes.body['open_po_impact'] as Record<string, unknown>[];
    assert.ok(openPoImpact.some((p) => p['po_number_ext'] === `PO-E9-${run}`));
    assert.deepStrictEqual(impactRes.body['open_production_order_impact'], []);
    assert.strictEqual(
      (impactRes.body['production_order_source'] as Record<string, unknown>)['available'],
      false,
    );
    assert.strictEqual(
      (impactRes.body['production_order_source'] as Record<string, unknown>)['registers_with'],
      'Epic 6',
    );
  });

  it('terminates the impact walk on a self-referential structure without recursion blowup', async () => {
    const selfItemId = await createItem(`E10-SELF-${run}`, { category: 'finished_goods' });
    const selfBom = await draftAndReleaseBom(selfItemId, [selfItemId]);

    const raiseRes = await raiseEco(selfBom.bomId, [
      { change_type: 'retire', target_bom_line_id: randomUUID() },
    ]);
    const ecoId = raiseRes.body['eco_id'] as string;

    const impactRes = await makeRequest(
      port,
      'GET',
      `/api/v1/ecos/${ecoId}/impact`,
      undefined,
      engineerHeaders,
    );
    assert.strictEqual(impactRes.status, 200, JSON.stringify(impactRes.body));
    // The walk terminates via the recursion cycle guard, not by exhausting the depth cap: the
    // self-reference is pruned at depth 1, so the response stays small instead of exploding.
    const affectedBoms = impactRes.body['affected_boms'] as Record<string, unknown>[];
    assert.ok(affectedBoms.length <= 1, `expected bounded walk: ${JSON.stringify(affectedBoms)}`);
  });

  // --- Direct-event guard and RBAC ---------------------------------------------

  it('rejects a well-formed direct eco.* post to /api/v1/events with INVALID_EVENT_STREAM', async () => {
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/events',
      {
        stream_type: 'engineering',
        stream_id: randomUUID(),
        event_type: 'eco.cancelled',
        payload: { eco_id: randomUUID(), cancel_reason: 'test' },
        metadata: {
          correlation_id: randomUUID(),
          occurred_at: new Date().toISOString(),
          actor: { user_id: randomUUID(), role: 'engineering_admin', location_id: randomUUID() },
        },
      },
      engineerHeaders,
    );
    assert.strictEqual(res.status, 400, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'INVALID_EVENT_STREAM');
  });

  it('rejects ECO mutation without engineering write role, and ECO read without engineering read role', async () => {
    const parentId = await createItem(`E11-PARENT-${run}`, { category: 'finished_goods' });
    const componentId = await createItem(`E11-COMP-${run}`);
    const { bomId } = await draftAndReleaseBom(parentId, [componentId]);

    const raiseAsReader = await makeRequest(
      port,
      'POST',
      '/api/v1/ecos',
      {
        bom_id: bomId,
        reason: 'x',
        changes: [{ change_type: 'retire', target_bom_line_id: randomUUID() }],
      },
      readerHeaders,
    );
    assert.strictEqual(raiseAsReader.status, 403, JSON.stringify(raiseAsReader.body));

    const listAsNoRole = await makeRequest(port, 'GET', '/api/v1/ecos', undefined, noRoleHeaders);
    assert.strictEqual(listAsNoRole.status, 403, JSON.stringify(listAsNoRole.body));
  });

  // --- Idempotency --------------------------------------------------------------

  it('replays a raise with the same idempotency_key without creating a duplicate ECO', async () => {
    const parentId = await createItem(`E12-PARENT-${run}`, { category: 'finished_goods' });
    const componentId = await createItem(`E12-COMP-${run}`);
    const { bomId } = await draftAndReleaseBom(parentId, [componentId]);
    const key = randomUUID();

    const first = await raiseEco(
      bomId,
      [{ change_type: 'retire', target_bom_line_id: randomUUID() }],
      {
        idempotency_key: key,
      },
    );
    assert.strictEqual(first.status, 201, JSON.stringify(first.body));
    const second = await raiseEco(
      bomId,
      [{ change_type: 'retire', target_bom_line_id: randomUUID() }],
      {
        idempotency_key: key,
      },
    );
    assert.strictEqual(second.status, 201, JSON.stringify(second.body));
    assert.strictEqual(first.body['eco_id'], second.body['eco_id']);

    const countRes = await getPool().query('SELECT COUNT(*) AS cnt FROM eco WHERE eco_id = $1', [
      first.body['eco_id'],
    ]);
    assert.strictEqual(Number(countRes.rows[0]!.cnt), 1);
  });

  // --- Deferred-work resolution: cross-revision immutability -------------------

  it('404s amending a bom_line that belongs to an older, superseded revision (deferred-work.md line 210)', async () => {
    // The exact scenario the deferral describes: a BOM whose CURRENT revision is a fresh DRAFT
    // while an OLDER revision is released and holds the line under attack. This story's own ECO
    // path never leaves the new revision in 'draft' (it lands 'released' directly), so the
    // vulnerable state is manufactured directly here to exercise the defense-in-depth fix in
    // both the handler pre-check and the applier's revision_id-scoped lookup.
    const parentId = await createItem(`E13-PARENT-${run}`, { category: 'finished_goods' });
    const componentId = await createItem(`E13-COMP-${run}`);
    const { bomId, revisionId: oldRevisionId } = await draftAndReleaseBom(parentId, [componentId]);

    const oldStructure = await makeRequest(
      port,
      'GET',
      `/api/v1/boms/${bomId}/structure`,
      undefined,
      engineerHeaders,
    );
    const oldLineId = (oldStructure.body['lines'] as Record<string, unknown>[])[0]![
      'bom_line_id'
    ] as string;

    const newDraftRevisionId = randomUUID();
    await getPool().query(
      `INSERT INTO bom_revision (revision_id, bom_id, revision_code, revision_status, drafted_by, drafted_at, source_event_id)
       VALUES ($1, $2, 'B', 'draft', $3, now(), $4)`,
      [newDraftRevisionId, bomId, randomUUID(), randomUUID()],
    );
    await getPool().query(
      `UPDATE bom SET current_revision_id = $1, status = 'draft' WHERE bom_id = $2`,
      [newDraftRevisionId, bomId],
    );

    // Attempting to amend the OLD revision's line (by its stale bom_line_id) through the
    // current-revision-scoped endpoint must 404, never silently mutate the superseded revision.
    const amendOldRes = await makeRequest(
      port,
      'PATCH',
      `/api/v1/boms/${bomId}/lines/${oldLineId}`,
      { quantity_per: '999.0' },
      engineerHeaders,
    );
    assert.strictEqual(amendOldRes.status, 404, JSON.stringify(amendOldRes.body));
    assert.strictEqual(amendOldRes.body['error_code'], 'BOM_LINE_NOT_FOUND');

    const oldLineRow = await getPool().query(
      'SELECT quantity_per, revision_id FROM bom_line WHERE bom_line_id = $1',
      [oldLineId],
    );
    assert.strictEqual(oldLineRow.rows[0]!.revision_id, oldRevisionId);
    assert.notStrictEqual(oldLineRow.rows[0]!.quantity_per, '999.000000');
  });

  // --- Review regression coverage ---------------------------------------------

  it('rejects implementing a stale ECO whose target revision is no longer current (ECO_STALE)', async () => {
    const parentId = await createItem(`R1-PARENT-${run}`, { category: 'finished_goods' });
    const componentId = await createItem(`R1-COMP-${run}`);
    const { bomId, revisionId } = await draftAndReleaseBom(parentId, [componentId]);

    const eco1 = await raiseEco(bomId, [
      {
        change_type: 'add',
        component_item_id: await createItem(`R1-NEW-${run}`),
        output_class: 'component',
        quantity_per: '1.0',
        line_uom: 'EA',
        uom_conversion_factor: '1.0',
        scrap_percent: '0.0',
        is_phantom: false,
        effective_from: '2026-02-01',
      },
    ]);
    const eco1Id = eco1.body['eco_id'] as string;
    await makeRequest(port, 'POST', `/api/v1/ecos/${eco1Id}/review`, {}, engineerHeaders);
    await makeRequest(port, 'POST', `/api/v1/ecos/${eco1Id}/approve`, {}, approverHeaders);
    const impl1 = await makeRequest(
      port,
      'POST',
      `/api/v1/ecos/${eco1Id}/implement`,
      {},
      engineerHeaders,
    );
    assert.strictEqual(impl1.status, 200, JSON.stringify(impl1.body));

    // ECO2 targets the SUPERSEDED revision A: raise and approve both succeed (A is still a
    // released revision), but implement must reject because A is no longer the current revision.
    const eco2 = await raiseEco(
      bomId,
      [{ change_type: 'retire', target_bom_line_id: randomUUID() }],
      { target_revision_id: revisionId },
    );
    assert.strictEqual(eco2.status, 201, JSON.stringify(eco2.body));
    const eco2Id = eco2.body['eco_id'] as string;
    await makeRequest(port, 'POST', `/api/v1/ecos/${eco2Id}/review`, {}, engineerHeaders);
    await makeRequest(port, 'POST', `/api/v1/ecos/${eco2Id}/approve`, {}, approverHeaders);
    const impl2 = await makeRequest(
      port,
      'POST',
      `/api/v1/ecos/${eco2Id}/implement`,
      {},
      engineerHeaders,
    );
    assert.strictEqual(impl2.status, 409, JSON.stringify(impl2.body));
    assert.strictEqual(impl2.body['error_code'], 'ECO_STALE');
  });

  it('rejects implementation that would release a revision with a deactivated component (RELEASE_GATE_UNMET)', async () => {
    const parentId = await createItem(`R2-PARENT-${run}`, { category: 'finished_goods' });
    const componentId = await createItem(`R2-COMP-${run}`);
    const inactiveId = await createItem(`R2-INACTIVE-${run}`, { status: 'inactive' });
    const { bomId } = await draftAndReleaseBom(parentId, [componentId]);

    const eco = await raiseEco(bomId, [
      {
        change_type: 'add',
        component_item_id: inactiveId,
        output_class: 'component',
        quantity_per: '1.0',
        line_uom: 'EA',
        uom_conversion_factor: '1.0',
        scrap_percent: '0.0',
        is_phantom: false,
        effective_from: '2026-02-01',
      },
    ]);
    const ecoId = eco.body['eco_id'] as string;
    await makeRequest(port, 'POST', `/api/v1/ecos/${ecoId}/review`, {}, engineerHeaders);
    await makeRequest(port, 'POST', `/api/v1/ecos/${ecoId}/approve`, {}, approverHeaders);
    const impl = await makeRequest(
      port,
      'POST',
      `/api/v1/ecos/${ecoId}/implement`,
      {},
      engineerHeaders,
    );
    assert.strictEqual(impl.status, 409, JSON.stringify(impl.body));
    assert.strictEqual(impl.body['error_code'], 'RELEASE_GATE_UNMET');
    const unmet = (impl.body['details'] as Record<string, unknown>)['unmet_conditions'] as string[];
    assert.ok(unmet.includes('component_item_masters_released'));
  });

  it('ignores client-supplied eco_id and eco_number at raise (server-generated only)', async () => {
    const parentId = await createItem(`R3-PARENT-${run}`, { category: 'finished_goods' });
    const componentId = await createItem(`R3-COMP-${run}`);
    const { bomId } = await draftAndReleaseBom(parentId, [componentId]);
    const clientEcoId = randomUUID();

    const res = await raiseEco(
      bomId,
      [{ change_type: 'retire', target_bom_line_id: randomUUID() }],
      { eco_id: clientEcoId, eco_number: 'CLIENT-SUPPLIED-1' },
    );
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    assert.notStrictEqual(res.body['eco_id'], clientEcoId);
    assert.notStrictEqual(res.body['eco_number'], 'CLIENT-SUPPLIED-1');
    assert.match(res.body['eco_number'] as string, /^ECO-\d{4}-/);
  });

  it('rejects an amend change that changes nothing (INVALID_PARAMS)', async () => {
    const parentId = await createItem(`R4-PARENT-${run}`, { category: 'finished_goods' });
    const componentId = await createItem(`R4-COMP-${run}`);
    const { bomId } = await draftAndReleaseBom(parentId, [componentId]);

    const res = await raiseEco(bomId, [{ change_type: 'amend', target_bom_line_id: randomUUID() }]);
    assert.strictEqual(res.status, 400, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'INVALID_PARAMS');
  });

  it('does not report superseded or retired lines in the where-used impact walk', async () => {
    const leafId = await createItem(`R5-LEAF-${run}`);
    const midId = await createItem(`R5-MID-${run}`, { category: 'finished_goods' });
    const { bomId } = await draftAndReleaseBom(midId, [leafId]);

    // ECO1 retires the leaf line, creating revision B where the leaf line is closed.
    const structure1 = await makeRequest(
      port,
      'GET',
      `/api/v1/boms/${bomId}/structure`,
      undefined,
      engineerHeaders,
    );
    const leafLineId = (structure1.body['lines'] as Record<string, unknown>[])[0]![
      'bom_line_id'
    ] as string;
    const eco1 = await raiseEco(bomId, [{ change_type: 'retire', target_bom_line_id: leafLineId }]);
    const eco1Id = eco1.body['eco_id'] as string;
    await makeRequest(port, 'POST', `/api/v1/ecos/${eco1Id}/review`, {}, engineerHeaders);
    await makeRequest(port, 'POST', `/api/v1/ecos/${eco1Id}/approve`, {}, approverHeaders);
    const impl1 = await makeRequest(
      port,
      'POST',
      `/api/v1/ecos/${eco1Id}/implement`,
      {},
      engineerHeaders,
    );
    assert.strictEqual(impl1.status, 200, JSON.stringify(impl1.body));
    const newRevisionId = impl1.body['new_revision_id'] as string;

    // ECO2 against the current (B) revision amends the retired leaf line: the impact walk must
    // not report the BOM as affected through either the superseded revision A line or the closed
    // revision B line.
    const leafLineInB = await getPool().query(
      'SELECT bom_line_id FROM bom_line WHERE revision_id = $1 AND component_item_id = $2',
      [newRevisionId, leafId],
    );
    assert.strictEqual(leafLineInB.rows.length, 1);
    const eco2 = await raiseEco(bomId, [
      {
        change_type: 'amend',
        target_bom_line_id: leafLineInB.rows[0]!.bom_line_id as string,
        quantity_per: '9.0',
      },
    ]);
    const eco2Id = eco2.body['eco_id'] as string;
    const impactRes = await makeRequest(
      port,
      'GET',
      `/api/v1/ecos/${eco2Id}/impact`,
      undefined,
      engineerHeaders,
    );
    assert.strictEqual(impactRes.status, 200, JSON.stringify(impactRes.body));
    const affectedBoms = impactRes.body['affected_boms'] as Record<string, unknown>[];
    assert.ok(
      !affectedBoms.some((b) => b['bom_id'] === bomId),
      `retired/superseded leaf should not report the BOM as affected: ${JSON.stringify(affectedBoms)}`,
    );
  });

  it('honors a caller-supplied effective_to on a retire change', async () => {
    const parentId = await createItem(`R6-PARENT-${run}`, { category: 'finished_goods' });
    const componentId = await createItem(`R6-COMP-${run}`);
    const { bomId } = await draftAndReleaseBom(parentId, [componentId]);
    const structureRes = await makeRequest(
      port,
      'GET',
      `/api/v1/boms/${bomId}/structure`,
      undefined,
      engineerHeaders,
    );
    const lineId = (structureRes.body['lines'] as Record<string, unknown>[])[0]![
      'bom_line_id'
    ] as string;

    const eco = await raiseEco(bomId, [
      { change_type: 'retire', target_bom_line_id: lineId, effective_to: '2027-12-31' },
    ]);
    const ecoId = eco.body['eco_id'] as string;
    await makeRequest(port, 'POST', `/api/v1/ecos/${ecoId}/review`, {}, engineerHeaders);
    await makeRequest(port, 'POST', `/api/v1/ecos/${ecoId}/approve`, {}, approverHeaders);
    const impl = await makeRequest(
      port,
      'POST',
      `/api/v1/ecos/${ecoId}/implement`,
      {},
      engineerHeaders,
    );
    assert.strictEqual(impl.status, 200, JSON.stringify(impl.body));
    const newRevisionId = impl.body['new_revision_id'] as string;

    const lineRow = await getPool().query(
      "SELECT to_char(effective_to, 'YYYY-MM-DD') AS effective_to FROM bom_line WHERE revision_id = $1 AND component_item_id = $2",
      [newRevisionId, componentId],
    );
    assert.strictEqual(lineRow.rows[0]!.effective_to, '2027-12-31');
  });

  it('hides recorded dispositions once the ECO is cancelled', async () => {
    const parentId = await createItem(`R7-PARENT-${run}`, { category: 'finished_goods' });
    const componentId = await createItem(`R7-COMP-${run}`);
    const { bomId, parentSku } = await draftAndReleaseBom(parentId, [componentId]);
    const eco = await raiseEco(bomId, [
      { change_type: 'retire', target_bom_line_id: randomUUID() },
    ]);
    const ecoId = eco.body['eco_id'] as string;
    await makeRequest(port, 'POST', `/api/v1/ecos/${ecoId}/review`, {}, engineerHeaders);
    await makeRequest(port, 'POST', `/api/v1/ecos/${ecoId}/approve`, {}, approverHeaders);

    const locationId = randomUUID();
    await seedStock(parentSku, locationId, `LOT-R7-${run}`, '2');
    const disp = await makeRequest(
      port,
      'POST',
      `/api/v1/ecos/${ecoId}/dispositions`,
      {
        dispositions: [
          {
            lot_id: `LOT-R7-${run}`,
            sku: parentSku,
            location_id: locationId,
            disposition: 'use_up',
          },
        ],
      },
      engineerHeaders,
    );
    assert.strictEqual(disp.status, 200, JSON.stringify(disp.body));

    const cancelRes = await makeRequest(
      port,
      'POST',
      `/api/v1/ecos/${ecoId}/cancel`,
      { cancel_reason: 'test cancellation' },
      engineerHeaders,
    );
    assert.strictEqual(cancelRes.status, 200, JSON.stringify(cancelRes.body));

    const getRes = await makeRequest(
      port,
      'GET',
      `/api/v1/ecos/${ecoId}`,
      undefined,
      engineerHeaders,
    );
    assert.strictEqual(getRes.status, 200);
    assert.deepStrictEqual(getRes.body['dispositions'], []);
  });

  it('rejects a disposition whose SKU does not match the ECO parent SKU (INVALID_PARAMS)', async () => {
    const parentId = await createItem(`R8-PARENT-${run}`, { category: 'finished_goods' });
    const componentId = await createItem(`R8-COMP-${run}`);
    const { bomId, parentSku } = await draftAndReleaseBom(parentId, [componentId]);
    const eco = await raiseEco(bomId, [
      { change_type: 'retire', target_bom_line_id: randomUUID() },
    ]);
    const ecoId = eco.body['eco_id'] as string;
    await makeRequest(port, 'POST', `/api/v1/ecos/${ecoId}/review`, {}, engineerHeaders);
    await makeRequest(port, 'POST', `/api/v1/ecos/${ecoId}/approve`, {}, approverHeaders);
    const locationId = randomUUID();
    await seedStock(parentSku, locationId, `LOT-R8-${run}`, '3');

    const res = await makeRequest(
      port,
      'POST',
      `/api/v1/ecos/${ecoId}/dispositions`,
      {
        dispositions: [
          {
            lot_id: `LOT-R8-${run}`,
            sku: `R8-OTHER-SKU-${run}`,
            location_id: locationId,
            disposition: 'use_up',
          },
        ],
      },
      engineerHeaders,
    );
    assert.strictEqual(res.status, 400, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'INVALID_PARAMS');
  });

  it('rejects a cancelled ECO approval attempt with ECO_STATE_INVALID for any caller (AC 8)', async () => {
    const parentId = await createItem(`R9-PARENT-${run}`, { category: 'finished_goods' });
    const componentId = await createItem(`R9-COMP-${run}`);
    const { bomId } = await draftAndReleaseBom(parentId, [componentId]);
    const eco = await raiseEco(bomId, [
      { change_type: 'retire', target_bom_line_id: randomUUID() },
    ]);
    const ecoId = eco.body['eco_id'] as string;
    const cancelRes = await makeRequest(
      port,
      'POST',
      `/api/v1/ecos/${ecoId}/cancel`,
      { cancel_reason: 'cancelled before review' },
      engineerHeaders,
    );
    assert.strictEqual(cancelRes.status, 200, JSON.stringify(cancelRes.body));

    // A non-approver attempting to approve a cancelled ECO must get ECO_STATE_INVALID (AC 8),
    // not APPROVAL_REQUIRED - the state guard runs before the authority check.
    const approveRes = await makeRequest(
      port,
      'POST',
      `/api/v1/ecos/${ecoId}/approve`,
      { idempotency_key: randomUUID() },
      engineerHeaders,
    );
    assert.strictEqual(approveRes.status, 409, JSON.stringify(approveRes.body));
    assert.strictEqual(approveRes.body['error_code'], 'ECO_STATE_INVALID');
  });
});
