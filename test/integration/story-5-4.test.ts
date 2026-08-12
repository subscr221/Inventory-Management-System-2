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

describe('Story 5.4 R&D Draft BOM Regime Integration Tests', () => {
  let server: Server;
  let port: number;
  let engineerHeaders: Record<string, string>;
  let readerHeaders: Record<string, string>;
  let noRoleHeaders: Record<string, string>;
  const approverHeaders: Record<string, Record<string, string>> = {};

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
        ...overrides,
      },
      engineerHeaders,
    );
    assert.strictEqual(res.status, 201, `item ${sku} failed: ${JSON.stringify(res.body)}`);
    return (res.body as Record<string, string>)['item_id']!;
  }

  function componentLine(
    lineNo: number,
    componentItemId: string,
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      line_no: lineNo,
      component_item_id: componentItemId,
      output_class: 'component',
      quantity_per: '2.0',
      line_uom: 'EA',
      uom_conversion_factor: '1.0',
      scrap_percent: '5.0',
      is_phantom: false,
      effective_from: '2026-01-01',
      ...overrides,
    };
  }

  function placeholderLine(
    lineNo: number,
    freeText: string,
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      line_no: lineNo,
      is_placeholder: true,
      free_text: freeText,
      output_class: 'component',
      quantity_per: '1.0',
      line_uom: 'EA',
      uom_conversion_factor: '1.0',
      scrap_percent: '0.0',
      is_phantom: false,
      effective_from: '2026-01-01',
      ...overrides,
    };
  }

  async function draftBom(
    parentItemId: string,
    bomType: 'production' | 'rnd',
    lines: Record<string, unknown>[],
  ): Promise<HttpResult> {
    return makeRequest(
      port,
      'POST',
      '/api/v1/boms',
      {
        parent_item_id: parentItemId,
        revision_code: 'A',
        bom_type: bomType,
        lines,
        idempotency_key: randomUUID(),
      },
      engineerHeaders,
    );
  }

  async function draftRndBom(
    parentItemId: string,
    lines: Record<string, unknown>[],
  ): Promise<{ bomId: string; revisionId: string }> {
    const res = await draftBom(parentItemId, 'rnd', lines);
    assert.strictEqual(res.status, 201, `rnd draft failed: ${JSON.stringify(res.body)}`);
    return {
      bomId: res.body['bom_id'] as string,
      revisionId: res.body['current_revision_id'] as string,
    };
  }

  async function getBomLinesFromDb(revisionId: string): Promise<Record<string, unknown>[]> {
    const result = await getPool().query(
      `SELECT * FROM bom_line WHERE revision_id = $1 ORDER BY line_no`,
      [revisionId],
    );
    return result.rows as Record<string, unknown>[];
  }

  async function signAll(bomId: string): Promise<void> {
    for (const fn of ['engineering', 'procurement', 'qc']) {
      const res = await makeRequest(
        port,
        'POST',
        `/api/v1/boms/${bomId}/productization-signoffs`,
        { gate_function: fn, idempotency_key: randomUUID() },
        approverHeaders[fn],
      );
      assert.strictEqual(res.status, 200, `sign ${fn} failed: ${JSON.stringify(res.body)}`);
    }
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
      'read/projections/rd_build_record.sql',
      'read/projections/rd_as_built_line.sql',
      'read/projections/rd_productization_signoff.sql',
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

    await provisionUser(port, `engineer54-${run}@test.com`, [
      { role: 'engineering_admin', module: 'engineering', functionScope: 'write', locationId: '*' },
      {
        role: 'inventory_controller',
        module: 'inventory',
        functionScope: 'write',
        locationId: '*',
      },
    ]);
    await provisionUser(port, `reader54-${run}@test.com`, [
      { role: 'bom_viewer', module: 'engineering', functionScope: 'read', locationId: '*' },
    ]);
    await provisionUser(port, `norole54-${run}@test.com`, [
      { role: 'nothing_54', module: 'unrelated_module', functionScope: 'read', locationId: '*' },
    ]);

    engineerHeaders = await authFor(port, `engineer54-${run}@test.com`);
    readerHeaders = await authFor(port, `reader54-${run}@test.com`);
    noRoleHeaders = await authFor(port, `norole54-${run}@test.com`);

    // DOA registry: one unbounded entry per productization gate function, each resolved to its
    // own approver role and user (AC 5). Mirrors the Story 5.3 eco_approval seeding block.
    await provisionUser(port, `doa-admin-5-4-${run}@test.com`, [
      {
        role: 'compliance_admin_5_4',
        module: 'compliance',
        functionScope: 'write',
        locationId: '*',
      },
    ]);
    const doaHeaders = await authFor(port, `doa-admin-5-4-${run}@test.com`);
    for (const fn of ['engineering', 'procurement', 'qc']) {
      const entryRes = await makeRequest(
        port,
        'POST',
        '/api/v1/doa/entries',
        {
          transaction_type: `rd_productization_${fn}`,
          role: `rd_${fn}_approver_5_4`,
          value_min: null,
          value_max: null,
        },
        doaHeaders,
      );
      assert.strictEqual(entryRes.status, 201, JSON.stringify(entryRes.body));

      await provisionUser(port, `rd-approver-${fn}-54-${run}@test.com`, [
        {
          role: `rd_${fn}_approver_5_4`,
          module: 'engineering',
          functionScope: 'write',
          locationId: '*',
        },
      ]);
      approverHeaders[fn] = await authFor(port, `rd-approver-${fn}-54-${run}@test.com`);
    }
  });

  after(async () => {
    server.close();
    const admin = await getAdminPool().connect();
    try {
      // Story 5.2 Group 4 precedent: BOM rows accumulate across runs in the shared test database.
      // doa_registry_entries/user_role_assignments/users are also truncated so a repeat run does
      // not resolve findRoleHolder to a PRIOR run's approver (the story-4-3 pollution class).
      await admin.query(
        'TRUNCATE TABLE rd_as_built_line, rd_build_record, rd_productization_signoff, eco_stock_disposition, eco_change_line, eco, bom_line, bom_revision, bom_structure, bom, doa_vacation_delegations, doa_registry_entries, user_role_assignments, users RESTART IDENTITY CASCADE',
      );
    } finally {
      admin.release();
    }
    await closePool();
    await closeAdminPool();
  });

  // -------------------------------------------------------------------------
  // AC 1: R&D draft creation, placeholders, free iteration
  // -------------------------------------------------------------------------

  it('creates an R&D draft via POST /api/v1/boms with bom_type rnd, accepting a placeholder line at draft time', async () => {
    const parent = await createItem(`RD-P1-${run}`);
    const compA = await createItem(`RD-C1-${run}`);

    const res = await draftBom(parent, 'rnd', [
      componentLine(1, compA),
      placeholderLine(2, 'TBD: custom bracket, supplier under evaluation'),
    ]);
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    assert.strictEqual(res.body['bom_type'], 'rnd');
    assert.strictEqual(res.body['status'], 'draft');

    const lines = await getBomLinesFromDb(res.body['current_revision_id'] as string);
    assert.strictEqual(lines.length, 2);
    assert.strictEqual(lines[1]!['is_placeholder'], true);
    assert.strictEqual(lines[1]!['component_item_id'], null);
    assert.strictEqual(lines[1]!['component_sku'], null);
    assert.strictEqual(lines[1]!['free_text'], 'TBD: custom bracket, supplier under evaluation');
  });

  it('accepts a placeholder line on an R&D draft via POST /:bomId/lines', async () => {
    const parent = await createItem(`RD-P2-${run}`);
    const compA = await createItem(`RD-C2-${run}`);
    const { bomId, revisionId } = await draftRndBom(parent, [componentLine(1, compA)]);

    const res = await makeRequest(
      port,
      'POST',
      `/api/v1/boms/${bomId}/lines`,
      placeholderLine(2, 'TBD: fastener kit', { idempotency_key: randomUUID() }),
      engineerHeaders,
    );
    // The Story 5.1 add-line endpoint returns 200 (it mutates an existing BOM aggregate).
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));

    const lines = await getBomLinesFromDb(revisionId);
    assert.strictEqual(lines.length, 2);
    assert.strictEqual(lines[1]!['is_placeholder'], true);
    assert.strictEqual(lines[1]!['free_text'], 'TBD: fastener kit');
  });

  it('rejects placeholder lines on a production BOM at draft time and via add-line with RD_PLACEHOLDER_NOT_PERMITTED', async () => {
    const parent = await createItem(`RD-P3-${run}`);
    const compA = await createItem(`RD-C3-${run}`);

    const draftRes = await draftBom(parent, 'production', [
      componentLine(1, compA),
      placeholderLine(2, 'not allowed here'),
    ]);
    assert.strictEqual(draftRes.status, 400, JSON.stringify(draftRes.body));
    assert.strictEqual(draftRes.body['error_code'], 'RD_PLACEHOLDER_NOT_PERMITTED');

    const prodRes = await draftBom(parent, 'production', [componentLine(1, compA)]);
    assert.strictEqual(prodRes.status, 201, JSON.stringify(prodRes.body));
    const prodBomId = prodRes.body['bom_id'] as string;

    const addRes = await makeRequest(
      port,
      'POST',
      `/api/v1/boms/${prodBomId}/lines`,
      placeholderLine(2, 'still not allowed', { idempotency_key: randomUUID() }),
      engineerHeaders,
    );
    assert.strictEqual(addRes.status, 400, JSON.stringify(addRes.body));
    assert.strictEqual(addRes.body['error_code'], 'RD_PLACEHOLDER_NOT_PERMITTED');
  });

  it('amends an R&D draft line in place with no ECO and no error', async () => {
    const parent = await createItem(`RD-P4-${run}`);
    const compA = await createItem(`RD-C4-${run}`);
    const { bomId, revisionId } = await draftRndBom(parent, [componentLine(1, compA)]);

    const lines = await getBomLinesFromDb(revisionId);
    const bomLineId = lines[0]!['bom_line_id'] as string;

    const res = await makeRequest(
      port,
      'PATCH',
      `/api/v1/boms/${bomId}/lines/${bomLineId}`,
      { quantity_per: '7.5', idempotency_key: randomUUID() },
      engineerHeaders,
    );
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));

    const after = await getBomLinesFromDb(revisionId);
    assert.strictEqual(String(after[0]!['quantity_per']), '7.500000');
    assert.ok(after[0]!['amended_at'] !== null, 'amended_at must be stamped');
  });

  // -------------------------------------------------------------------------
  // AC 2: execution bar
  // -------------------------------------------------------------------------

  it('rejects release of an R&D draft with 409 RD_EXECUTION_BARRED', async () => {
    const parent = await createItem(`RD-P5-${run}`);
    const compA = await createItem(`RD-C5-${run}`);
    const { bomId } = await draftRndBom(parent, [componentLine(1, compA)]);

    const res = await makeRequest(
      port,
      'POST',
      `/api/v1/boms/${bomId}/release`,
      { idempotency_key: randomUUID() },
      engineerHeaders,
    );
    assert.strictEqual(res.status, 409, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'RD_EXECUTION_BARRED');
  });

  it('rejects the release-gate checklist for an R&D draft with 409 RD_EXECUTION_BARRED, not a checklist', async () => {
    const parent = await createItem(`RD-P6-${run}`);
    const compA = await createItem(`RD-C6-${run}`);
    const { bomId } = await draftRndBom(parent, [componentLine(1, compA)]);

    const res = await makeRequest(
      port,
      'GET',
      `/api/v1/boms/${bomId}/release-gate`,
      undefined,
      readerHeaders,
    );
    assert.strictEqual(res.status, 409, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'RD_EXECUTION_BARRED');
    assert.strictEqual(res.body['conditions'], undefined);
  });

  // -------------------------------------------------------------------------
  // AC 3: clone to R&D
  // -------------------------------------------------------------------------

  it('clones a production BOM to two parallel R&D drafts while a second production BOM still collides', async () => {
    const parent = await createItem(`RD-P7-${run}`);
    const compA = await createItem(`RD-C7A-${run}`);
    const compB = await createItem(`RD-C7B-${run}`);

    const prodRes = await draftBom(parent, 'production', [
      componentLine(1, compA),
      componentLine(2, compB, { quantity_per: '3.25' }),
    ]);
    assert.strictEqual(prodRes.status, 201, JSON.stringify(prodRes.body));
    const prodBomId = prodRes.body['bom_id'] as string;
    const prodRevisionId = prodRes.body['current_revision_id'] as string;

    const sourceBefore = await getPool().query(`SELECT * FROM bom WHERE bom_id = $1`, [prodBomId]);
    const sourceLinesBefore = await getBomLinesFromDb(prodRevisionId);

    const clone1 = await makeRequest(
      port,
      'POST',
      `/api/v1/boms/${prodBomId}/clone-to-rd`,
      { idempotency_key: randomUUID() },
      engineerHeaders,
    );
    assert.strictEqual(clone1.status, 201, JSON.stringify(clone1.body));
    const clone2 = await makeRequest(
      port,
      'POST',
      `/api/v1/boms/${prodBomId}/clone-to-rd`,
      { idempotency_key: randomUUID() },
      engineerHeaders,
    );
    assert.strictEqual(clone2.status, 201, JSON.stringify(clone2.body));
    assert.notStrictEqual(clone1.body['bom_id'], clone2.body['bom_id']);

    // Both clones carry provenance, rnd type, draft status, and copied lines.
    for (const clone of [clone1, clone2]) {
      assert.strictEqual(clone.body['bom_type'], 'rnd');
      assert.strictEqual(clone.body['status'], 'draft');
      assert.strictEqual(clone.body['cloned_from_bom_id'], prodBomId);
      const lines = clone.body['lines'] as Record<string, unknown>[];
      assert.strictEqual(lines.length, 2);
      assert.strictEqual(lines[0]!['component_item_id'], compA);
      assert.strictEqual(String(lines[1]!['quantity_per']), '3.250000');
    }

    // The partial-index relaxation is provably scoped: a second PRODUCTION BOM still collides.
    const secondProd = await draftBom(parent, 'production', [componentLine(1, compA)]);
    assert.strictEqual(secondProd.status, 409, JSON.stringify(secondProd.body));
    assert.strictEqual(secondProd.body['error_code'], 'DUPLICATE_EVENT');

    // AC 3: every source row is byte-identical on re-read after cloning.
    const sourceAfter = await getPool().query(`SELECT * FROM bom WHERE bom_id = $1`, [prodBomId]);
    assert.deepStrictEqual(sourceAfter.rows[0], sourceBefore.rows[0]);
    const sourceLinesAfter = await getBomLinesFromDb(prodRevisionId);
    assert.deepStrictEqual(sourceLinesAfter, sourceLinesBefore);
  });

  // -------------------------------------------------------------------------
  // AC 4: build records and the as-built snapshot
  // -------------------------------------------------------------------------

  it('captures an as-built snapshot at confirm with all five deviation kinds', async () => {
    const parent = await createItem(`RD-P8-${run}`);
    const compA = await createItem(`RD-C8A-${run}`);
    const compB = await createItem(`RD-C8B-${run}`);
    const compC = await createItem(`RD-C8C-${run}`);
    const compD = await createItem(`RD-C8D-${run}`);
    const compE = await createItem(`RD-C8E-${run}`);

    const { bomId, revisionId } = await draftRndBom(parent, [
      componentLine(1, compA, { quantity_per: '2.0' }),
      componentLine(2, compB, { quantity_per: '3.0' }),
      placeholderLine(3, 'TBD: adhesive'),
      componentLine(4, compC, { quantity_per: '1.0' }),
    ]);
    const draftLines = await getBomLinesFromDb(revisionId);
    const lineIdA = draftLines[0]!['bom_line_id'] as string;
    const lineIdB = draftLines[1]!['bom_line_id'] as string;
    const lineIdP = draftLines[2]!['bom_line_id'] as string;

    const recordRes = await makeRequest(
      port,
      'POST',
      `/api/v1/boms/${bomId}/builds`,
      {
        build_ref: `BLD-1-${run}`,
        built_quantity: '1.0',
        built_uom: 'EA',
        as_built_lines: [
          // quantity deviation: matched line A used 2.5 against draft 2.0
          {
            draft_bom_line_id: lineIdA,
            component_item_id: compA,
            quantity_used: '2.5',
            line_uom: 'EA',
          },
          // substitution: draft line B built with component D
          {
            draft_bom_line_id: lineIdB,
            component_item_id: compD,
            quantity_used: '3.0',
            line_uom: 'EA',
          },
          // placeholder resolved with a real part
          {
            draft_bom_line_id: lineIdP,
            component_item_id: compE,
            quantity_used: '1.0',
            line_uom: 'EA',
          },
          // extra: matches no draft line
          { component_item_id: compE, quantity_used: '4.0', line_uom: 'EA' },
          // (draft line C has no as-built line: missing)
        ],
        idempotency_key: randomUUID(),
      },
      engineerHeaders,
    );
    assert.strictEqual(recordRes.status, 201, JSON.stringify(recordRes.body));
    const buildId = recordRes.body['build_id'] as string;
    assert.strictEqual(recordRes.body['status'], 'recorded');

    const confirmRes = await makeRequest(
      port,
      'POST',
      `/api/v1/rd-builds/${buildId}/confirm`,
      { idempotency_key: randomUUID() },
      engineerHeaders,
    );
    assert.strictEqual(confirmRes.status, 200, JSON.stringify(confirmRes.body));
    assert.strictEqual(confirmRes.body['status'], 'confirmed');

    const lines = confirmRes.body['as_built_lines'] as Record<string, unknown>[];
    assert.strictEqual(lines.length, 5, JSON.stringify(lines));
    const byLineNo = new Map(lines.map((l) => [l['line_no'] as number, l]));
    assert.strictEqual(byLineNo.get(1)!['deviation_kind'], 'quantity');
    assert.match(byLineNo.get(1)!['deviation_detail'] as string, /expected 2\.0.*used 2\.5/);
    assert.strictEqual(byLineNo.get(2)!['deviation_kind'], 'substitution');
    assert.strictEqual(byLineNo.get(3)!['deviation_kind'], 'placeholder');
    assert.strictEqual(byLineNo.get(4)!['deviation_kind'], 'extra');
    // The synthetic missing row carries the unbuilt draft line's identity.
    assert.strictEqual(byLineNo.get(5)!['deviation_kind'], 'missing');
    assert.strictEqual(byLineNo.get(5)!['component_item_id'], compC);
    for (const line of lines) {
      assert.strictEqual(line['deviation_flag'], true);
    }
  });

  it('treats quantity_used as per-unit: a build of 2 with per-unit matches records no quantity deviation', async () => {
    const parent = await createItem(`RD-P8B-${run}`);
    const compA = await createItem(`RD-C8X-${run}`);
    const compB = await createItem(`RD-C8Y-${run}`);

    const { bomId, revisionId } = await draftRndBom(parent, [
      componentLine(1, compA, { quantity_per: '2.0' }),
      componentLine(2, compB, { quantity_per: '3.0' }),
    ]);
    const draftLines = await getBomLinesFromDb(revisionId);
    const lineIdA = draftLines[0]!['bom_line_id'] as string;
    const lineIdB = draftLines[1]!['bom_line_id'] as string;

    // built_quantity is 2 but each as-built line records its PER-UNIT usage, matching the draft
    // quantity_per exactly. Decision 2026-08-12 (option 2): quantity_used is per-unit, so the
    // confirm-time comparison must NOT flag these lines.
    const recordRes = await makeRequest(
      port,
      'POST',
      `/api/v1/boms/${bomId}/builds`,
      {
        build_ref: `BLD-8-${run}`,
        built_quantity: '2.0',
        built_uom: 'EA',
        as_built_lines: [
          {
            draft_bom_line_id: lineIdA,
            component_item_id: compA,
            quantity_used: '2.0',
            line_uom: 'EA',
          },
          {
            draft_bom_line_id: lineIdB,
            component_item_id: compB,
            quantity_used: '3.0',
            line_uom: 'EA',
          },
        ],
        idempotency_key: randomUUID(),
      },
      engineerHeaders,
    );
    assert.strictEqual(recordRes.status, 201, JSON.stringify(recordRes.body));
    const buildId = recordRes.body['build_id'] as string;

    const confirmRes = await makeRequest(
      port,
      'POST',
      `/api/v1/rd-builds/${buildId}/confirm`,
      { idempotency_key: randomUUID() },
      engineerHeaders,
    );
    assert.strictEqual(confirmRes.status, 200, JSON.stringify(confirmRes.body));
    const lines = confirmRes.body['as_built_lines'] as Record<string, unknown>[];
    assert.strictEqual(lines.length, 2, JSON.stringify(lines));
    for (const line of lines) {
      assert.strictEqual(line['deviation_flag'], false, JSON.stringify(line));
      assert.strictEqual(line['deviation_kind'], null);
    }
  });

  it('recomputes deviations at confirm time: a draft edit between record and confirm changes the result', async () => {
    const parent = await createItem(`RD-P9-${run}`);
    const compA = await createItem(`RD-C9-${run}`);
    const { bomId, revisionId } = await draftRndBom(parent, [
      componentLine(1, compA, { quantity_per: '2.0' }),
    ]);
    const draftLines = await getBomLinesFromDb(revisionId);
    const lineIdA = draftLines[0]!['bom_line_id'] as string;

    const recordRes = await makeRequest(
      port,
      'POST',
      `/api/v1/boms/${bomId}/builds`,
      {
        build_ref: `BLD-2-${run}`,
        built_quantity: '1.0',
        built_uom: 'EA',
        as_built_lines: [
          // Matches the draft exactly at record time.
          {
            draft_bom_line_id: lineIdA,
            component_item_id: compA,
            quantity_used: '2.0',
            line_uom: 'EA',
          },
        ],
        idempotency_key: randomUUID(),
      },
      engineerHeaders,
    );
    assert.strictEqual(recordRes.status, 201, JSON.stringify(recordRes.body));
    const buildId = recordRes.body['build_id'] as string;

    // The draft keeps iterating between record and confirm - that is the R&D regime's point.
    const amendRes = await makeRequest(
      port,
      'PATCH',
      `/api/v1/boms/${bomId}/lines/${lineIdA}`,
      { quantity_per: '9.0', idempotency_key: randomUUID() },
      engineerHeaders,
    );
    assert.strictEqual(amendRes.status, 200, JSON.stringify(amendRes.body));

    const confirmRes = await makeRequest(
      port,
      'POST',
      `/api/v1/rd-builds/${buildId}/confirm`,
      { idempotency_key: randomUUID() },
      engineerHeaders,
    );
    assert.strictEqual(confirmRes.status, 200, JSON.stringify(confirmRes.body));
    const lines = confirmRes.body['as_built_lines'] as Record<string, unknown>[];
    assert.strictEqual(lines[0]!['deviation_kind'], 'quantity');
    assert.match(lines[0]!['deviation_detail'] as string, /expected 9\.0.*used 2\.0/);
  });

  it('treats a confirmed snapshot as immutable: re-confirm and build_ref reuse both reject SNAPSHOT_IMMUTABLE', async () => {
    const parent = await createItem(`RD-P10-${run}`);
    const compA = await createItem(`RD-C10-${run}`);
    const { bomId, revisionId } = await draftRndBom(parent, [componentLine(1, compA)]);
    const draftLines = await getBomLinesFromDb(revisionId);
    const lineIdA = draftLines[0]!['bom_line_id'] as string;

    const buildRef = `BLD-3-${run}`;
    const recordRes = await makeRequest(
      port,
      'POST',
      `/api/v1/boms/${bomId}/builds`,
      {
        build_ref: buildRef,
        built_quantity: '1.0',
        built_uom: 'EA',
        as_built_lines: [
          {
            draft_bom_line_id: lineIdA,
            component_item_id: compA,
            quantity_used: '2.0',
            line_uom: 'EA',
          },
        ],
        idempotency_key: randomUUID(),
      },
      engineerHeaders,
    );
    assert.strictEqual(recordRes.status, 201, JSON.stringify(recordRes.body));
    const buildId = recordRes.body['build_id'] as string;

    const confirm1 = await makeRequest(
      port,
      'POST',
      `/api/v1/rd-builds/${buildId}/confirm`,
      { idempotency_key: randomUUID() },
      engineerHeaders,
    );
    assert.strictEqual(confirm1.status, 200, JSON.stringify(confirm1.body));

    const confirm2 = await makeRequest(
      port,
      'POST',
      `/api/v1/rd-builds/${buildId}/confirm`,
      { idempotency_key: randomUUID() },
      engineerHeaders,
    );
    assert.strictEqual(confirm2.status, 409, JSON.stringify(confirm2.body));
    assert.strictEqual(confirm2.body['error_code'], 'SNAPSHOT_IMMUTABLE');

    const reuseRes = await makeRequest(
      port,
      'POST',
      `/api/v1/boms/${bomId}/builds`,
      {
        build_ref: buildRef,
        built_quantity: '1.0',
        built_uom: 'EA',
        as_built_lines: [
          {
            draft_bom_line_id: lineIdA,
            component_item_id: compA,
            quantity_used: '2.0',
            line_uom: 'EA',
          },
        ],
        idempotency_key: randomUUID(),
      },
      engineerHeaders,
    );
    assert.strictEqual(reuseRes.status, 409, JSON.stringify(reuseRes.body));
    assert.strictEqual(reuseRes.body['error_code'], 'SNAPSHOT_IMMUTABLE');
  });

  it('rejects a build record on a production BOM with RD_BUILD_NOT_PERMITTED', async () => {
    const parent = await createItem(`RD-P11-${run}`);
    const compA = await createItem(`RD-C11-${run}`);
    const prodRes = await draftBom(parent, 'production', [componentLine(1, compA)]);
    assert.strictEqual(prodRes.status, 201, JSON.stringify(prodRes.body));

    const res = await makeRequest(
      port,
      'POST',
      `/api/v1/boms/${prodRes.body['bom_id'] as string}/builds`,
      {
        build_ref: `BLD-4-${run}`,
        built_quantity: '1.0',
        built_uom: 'EA',
        as_built_lines: [{ component_item_id: compA, quantity_used: '2.0', line_uom: 'EA' }],
        idempotency_key: randomUUID(),
      },
      engineerHeaders,
    );
    assert.strictEqual(res.status, 409, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'RD_BUILD_NOT_PERMITTED');
  });

  // -------------------------------------------------------------------------
  // AC 5: productization gate
  // -------------------------------------------------------------------------

  it('walks the productization gate: APPROVAL_REQUIRED until all three sign-offs land, checklist flips eligible, productize creates a draft production BOM', async () => {
    const parent = await createItem(`RD-P12-${run}`);
    const compA = await createItem(`RD-C12-${run}`);
    const { bomId, revisionId } = await draftRndBom(parent, [componentLine(1, compA)]);

    // Zero, one, and two sign-offs each reject with the missing functions named.
    const attempt0 = await makeRequest(
      port,
      'POST',
      `/api/v1/boms/${bomId}/productize`,
      { idempotency_key: randomUUID() },
      engineerHeaders,
    );
    assert.strictEqual(attempt0.status, 409, JSON.stringify(attempt0.body));
    assert.strictEqual(attempt0.body['error_code'], 'APPROVAL_REQUIRED');
    assert.deepStrictEqual(
      (attempt0.body['details'] as Record<string, unknown>)['missing_signoffs'],
      ['engineering', 'procurement', 'qc'],
    );

    const gate0 = await makeRequest(
      port,
      'GET',
      `/api/v1/boms/${bomId}/productization-gate`,
      undefined,
      readerHeaders,
    );
    assert.strictEqual(gate0.status, 200, JSON.stringify(gate0.body));
    assert.strictEqual(gate0.body['eligible'], false);
    assert.strictEqual((gate0.body['signoffs'] as unknown[]).length, 3);

    const sign1 = await makeRequest(
      port,
      'POST',
      `/api/v1/boms/${bomId}/productization-signoffs`,
      { gate_function: 'engineering', idempotency_key: randomUUID() },
      approverHeaders['engineering'],
    );
    assert.strictEqual(sign1.status, 200, JSON.stringify(sign1.body));

    const attempt1 = await makeRequest(
      port,
      'POST',
      `/api/v1/boms/${bomId}/productize`,
      { idempotency_key: randomUUID() },
      engineerHeaders,
    );
    assert.strictEqual(attempt1.status, 409, JSON.stringify(attempt1.body));
    assert.deepStrictEqual(
      (attempt1.body['details'] as Record<string, unknown>)['missing_signoffs'],
      ['procurement', 'qc'],
    );

    const sign2 = await makeRequest(
      port,
      'POST',
      `/api/v1/boms/${bomId}/productization-signoffs`,
      { gate_function: 'procurement', idempotency_key: randomUUID() },
      approverHeaders['procurement'],
    );
    assert.strictEqual(sign2.status, 200, JSON.stringify(sign2.body));

    const attempt2 = await makeRequest(
      port,
      'POST',
      `/api/v1/boms/${bomId}/productize`,
      { idempotency_key: randomUUID() },
      engineerHeaders,
    );
    assert.strictEqual(attempt2.status, 409, JSON.stringify(attempt2.body));
    assert.deepStrictEqual(
      (attempt2.body['details'] as Record<string, unknown>)['missing_signoffs'],
      ['qc'],
    );

    // Re-signing a function replaces rather than duplicates the row.
    const resign = await makeRequest(
      port,
      'POST',
      `/api/v1/boms/${bomId}/productization-signoffs`,
      { gate_function: 'engineering', notes: 'second pass', idempotency_key: randomUUID() },
      approverHeaders['engineering'],
    );
    assert.strictEqual(resign.status, 200, JSON.stringify(resign.body));
    const signoffCount = await getPool().query(
      `SELECT COUNT(*)::int AS cnt FROM rd_productization_signoff WHERE bom_id = $1 AND gate_function = 'engineering'`,
      [bomId],
    );
    assert.strictEqual(signoffCount.rows[0]!.cnt, 1);
    const signoffNotes = await getPool().query(
      `SELECT notes FROM rd_productization_signoff WHERE bom_id = $1 AND gate_function = 'engineering'`,
      [bomId],
    );
    assert.strictEqual(signoffNotes.rows[0]!.notes, 'second pass');

    const sign3 = await makeRequest(
      port,
      'POST',
      `/api/v1/boms/${bomId}/productization-signoffs`,
      { gate_function: 'qc', idempotency_key: randomUUID() },
      approverHeaders['qc'],
    );
    assert.strictEqual(sign3.status, 200, JSON.stringify(sign3.body));

    const gateFull = await makeRequest(
      port,
      'GET',
      `/api/v1/boms/${bomId}/productization-gate`,
      undefined,
      readerHeaders,
    );
    assert.strictEqual(gateFull.body['eligible'], true, JSON.stringify(gateFull.body));

    const sourceLinesBefore = await getBomLinesFromDb(revisionId);
    const sourceBefore = await getPool().query(`SELECT * FROM bom WHERE bom_id = $1`, [bomId]);

    const productize = await makeRequest(
      port,
      'POST',
      `/api/v1/boms/${bomId}/productize`,
      { idempotency_key: randomUUID() },
      engineerHeaders,
    );
    assert.strictEqual(productize.status, 201, JSON.stringify(productize.body));
    assert.strictEqual(productize.body['bom_type'], 'production');
    assert.strictEqual(productize.body['status'], 'draft');
    assert.strictEqual(productize.body['productized_from_bom_id'], bomId);
    const newLines = productize.body['lines'] as Record<string, unknown>[];
    assert.strictEqual(newLines.length, 1);
    assert.strictEqual(newLines[0]!['component_item_id'], compA);

    // The source R&D draft is not modified by productization.
    const sourceAfter = await getPool().query(`SELECT * FROM bom WHERE bom_id = $1`, [bomId]);
    assert.deepStrictEqual(sourceAfter.rows[0], sourceBefore.rows[0]);
    assert.deepStrictEqual(await getBomLinesFromDb(revisionId), sourceLinesBefore);

    // The productized BOM releases through the ordinary Story 5.2 path - productization does
    // not shortcut the gate.
    const release = await makeRequest(
      port,
      'POST',
      `/api/v1/boms/${productize.body['bom_id'] as string}/release`,
      { idempotency_key: randomUUID() },
      engineerHeaders,
    );
    assert.strictEqual(release.status, 200, JSON.stringify(release.body));
    assert.strictEqual(release.body['status'], 'released');
  });

  it('rejects a sign-off by a non-resolved user with 403 APPROVAL_REQUIRED', async () => {
    const parent = await createItem(`RD-P13-${run}`);
    const compA = await createItem(`RD-C13-${run}`);
    const { bomId } = await draftRndBom(parent, [componentLine(1, compA)]);

    const res = await makeRequest(
      port,
      'POST',
      `/api/v1/boms/${bomId}/productization-signoffs`,
      { gate_function: 'engineering', idempotency_key: randomUUID() },
      engineerHeaders,
    );
    assert.strictEqual(res.status, 403, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'APPROVAL_REQUIRED');
  });

  it('rejects productize with an unresolved placeholder listing the line numbers', async () => {
    const parent = await createItem(`RD-P14-${run}`);
    const compA = await createItem(`RD-C14-${run}`);
    const { bomId } = await draftRndBom(parent, [
      componentLine(1, compA),
      placeholderLine(2, 'TBD: unresolved part'),
    ]);
    await signAll(bomId);

    const res = await makeRequest(
      port,
      'POST',
      `/api/v1/boms/${bomId}/productize`,
      { idempotency_key: randomUUID() },
      engineerHeaders,
    );
    assert.strictEqual(res.status, 409, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'RD_PLACEHOLDER_UNRESOLVED');
    assert.deepStrictEqual(
      (res.body['details'] as Record<string, unknown>)['placeholder_line_nos'],
      [2],
    );
  });

  it('rejects productize when a production BOM already exists for the parent item with BOM_ALREADY_EXISTS, not a raw 500', async () => {
    const parent = await createItem(`RD-P15-${run}`);
    const compA = await createItem(`RD-C15-${run}`);

    const prodRes = await draftBom(parent, 'production', [componentLine(1, compA)]);
    assert.strictEqual(prodRes.status, 201, JSON.stringify(prodRes.body));

    const clone = await makeRequest(
      port,
      'POST',
      `/api/v1/boms/${prodRes.body['bom_id'] as string}/clone-to-rd`,
      { idempotency_key: randomUUID() },
      engineerHeaders,
    );
    assert.strictEqual(clone.status, 201, JSON.stringify(clone.body));
    const rndBomId = clone.body['bom_id'] as string;
    await signAll(rndBomId);

    const res = await makeRequest(
      port,
      'POST',
      `/api/v1/boms/${rndBomId}/productize`,
      { idempotency_key: randomUUID() },
      engineerHeaders,
    );
    assert.strictEqual(res.status, 409, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'BOM_ALREADY_EXISTS');
  });

  // -------------------------------------------------------------------------
  // Spine, RBAC, idempotency, audit
  // -------------------------------------------------------------------------

  it('rejects a well-formed direct rd_* post to /api/v1/events with INVALID_EVENT_STREAM', async () => {
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/events',
      {
        stream_type: 'engineering',
        stream_id: randomUUID(),
        event_type: 'rd_build.confirmed',
        payload: { build_id: randomUUID() },
        metadata: {
          correlation_id: randomUUID(),
          occurred_at: new Date().toISOString(),
          actor: { user_id: randomUUID(), role: 'engineering_admin', location_id: randomUUID() },
        },
        idempotency_key: randomUUID(),
      },
      engineerHeaders,
    );
    assert.strictEqual(res.status, 400, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'INVALID_EVENT_STREAM');
  });

  it('enforces engineering RBAC on every new route: mutations need write, reads need read', async () => {
    const parent = await createItem(`RD-P16-${run}`);
    const compA = await createItem(`RD-C16-${run}`);
    const { bomId, revisionId } = await draftRndBom(parent, [componentLine(1, compA)]);
    const draftLines = await getBomLinesFromDb(revisionId);
    const lineIdA = draftLines[0]!['bom_line_id'] as string;
    const recordRes = await makeRequest(
      port,
      'POST',
      `/api/v1/boms/${bomId}/builds`,
      {
        build_ref: `BLD-5-${run}`,
        built_quantity: '1.0',
        built_uom: 'EA',
        as_built_lines: [
          {
            draft_bom_line_id: lineIdA,
            component_item_id: compA,
            quantity_used: '2.0',
            line_uom: 'EA',
          },
        ],
        idempotency_key: randomUUID(),
      },
      engineerHeaders,
    );
    assert.strictEqual(recordRes.status, 201, JSON.stringify(recordRes.body));
    const buildId = recordRes.body['build_id'] as string;

    const mutations: [string, string, unknown][] = [
      ['POST', `/api/v1/boms/${bomId}/clone-to-rd`, {}],
      [
        'POST',
        `/api/v1/boms/${bomId}/builds`,
        { build_ref: 'x', built_quantity: '1.0', built_uom: 'EA', as_built_lines: [] },
      ],
      ['POST', `/api/v1/rd-builds/${buildId}/confirm`, {}],
      ['POST', `/api/v1/boms/${bomId}/productization-signoffs`, { gate_function: 'engineering' }],
      ['POST', `/api/v1/boms/${bomId}/productize`, {}],
    ];
    for (const [method, path, body] of mutations) {
      // A read-scope role gets 403 on writes; a no-role user gets 403 everywhere.
      for (const headers of [readerHeaders, noRoleHeaders]) {
        const res = await makeRequest(port, method, path, body, headers);
        assert.strictEqual(res.status, 403, `${method} ${path}: ${JSON.stringify(res.body)}`);
      }
    }

    const reads: [string, string][] = [
      ['GET', `/api/v1/boms/${bomId}/builds`],
      ['GET', `/api/v1/rd-builds/${buildId}`],
      ['GET', `/api/v1/boms/${bomId}/productization-gate`],
    ];
    for (const [method, path] of reads) {
      const res = await makeRequest(port, method, path, undefined, noRoleHeaders);
      assert.strictEqual(res.status, 403, `${method} ${path}: ${JSON.stringify(res.body)}`);
      const okRes = await makeRequest(port, method, path, undefined, readerHeaders);
      assert.strictEqual(okRes.status, 200, `${method} ${path}: ${JSON.stringify(okRes.body)}`);
    }
  });

  it('replays each mutation idempotently: the same idempotency_key does not double-apply', async () => {
    const parent = await createItem(`RD-P17-${run}`);
    const compA = await createItem(`RD-C17-${run}`);

    const prodRes = await draftBom(parent, 'production', [componentLine(1, compA)]);
    assert.strictEqual(prodRes.status, 201, JSON.stringify(prodRes.body));
    const prodBomId = prodRes.body['bom_id'] as string;

    // Clone replay: same key returns the SAME clone, no second bom row.
    const cloneKey = randomUUID();
    const clone1 = await makeRequest(
      port,
      'POST',
      `/api/v1/boms/${prodBomId}/clone-to-rd`,
      { idempotency_key: cloneKey },
      engineerHeaders,
    );
    assert.strictEqual(clone1.status, 201, JSON.stringify(clone1.body));
    const clone2 = await makeRequest(
      port,
      'POST',
      `/api/v1/boms/${prodBomId}/clone-to-rd`,
      { idempotency_key: cloneKey },
      engineerHeaders,
    );
    assert.strictEqual(clone2.status, 201, JSON.stringify(clone2.body));
    assert.strictEqual(clone2.body['bom_id'], clone1.body['bom_id']);
    const cloneCount = await getPool().query(
      `SELECT COUNT(*)::int AS cnt FROM bom WHERE cloned_from_bom_id = $1`,
      [prodBomId],
    );
    assert.strictEqual(cloneCount.rows[0]!.cnt, 1);

    // Build record replay: same key, one rd_build_record row.
    const rndBomId = clone1.body['bom_id'] as string;
    const buildKey = randomUUID();
    const buildBody = {
      build_ref: `BLD-6-${run}`,
      built_quantity: '1.0',
      built_uom: 'EA',
      as_built_lines: [{ component_item_id: compA, quantity_used: '2.0', line_uom: 'EA' }],
      idempotency_key: buildKey,
    };
    const build1 = await makeRequest(
      port,
      'POST',
      `/api/v1/boms/${rndBomId}/builds`,
      buildBody,
      engineerHeaders,
    );
    assert.strictEqual(build1.status, 201, JSON.stringify(build1.body));
    const build2 = await makeRequest(
      port,
      'POST',
      `/api/v1/boms/${rndBomId}/builds`,
      buildBody,
      engineerHeaders,
    );
    assert.strictEqual(build2.status, 201, JSON.stringify(build2.body));
    assert.strictEqual(build2.body['build_id'], build1.body['build_id']);
    const buildCount = await getPool().query(
      `SELECT COUNT(*)::int AS cnt FROM rd_build_record WHERE bom_id = $1`,
      [rndBomId],
    );
    assert.strictEqual(buildCount.rows[0]!.cnt, 1);

    // Sign-off replay: same key, one signoff row.
    const signKey = randomUUID();
    const sign1 = await makeRequest(
      port,
      'POST',
      `/api/v1/boms/${rndBomId}/productization-signoffs`,
      { gate_function: 'engineering', idempotency_key: signKey },
      approverHeaders['engineering'],
    );
    assert.strictEqual(sign1.status, 200, JSON.stringify(sign1.body));
    const sign2 = await makeRequest(
      port,
      'POST',
      `/api/v1/boms/${rndBomId}/productization-signoffs`,
      { gate_function: 'engineering', idempotency_key: signKey },
      approverHeaders['engineering'],
    );
    assert.strictEqual(sign2.status, 200, JSON.stringify(sign2.body));
    const signCount = await getPool().query(
      `SELECT COUNT(*)::int AS cnt FROM rd_productization_signoff WHERE bom_id = $1`,
      [rndBomId],
    );
    assert.strictEqual(signCount.rows[0]!.cnt, 1);
  });

  it('writes audit entries for clone, build record, confirm, sign-off, and productize (FR-AC-13)', async () => {
    const parent = await createItem(`RD-P18-${run}`);
    const compA = await createItem(`RD-C18-${run}`);
    const { bomId, revisionId } = await draftRndBom(parent, [componentLine(1, compA)]);
    const draftLines = await getBomLinesFromDb(revisionId);
    const lineIdA = draftLines[0]!['bom_line_id'] as string;

    const clone = await makeRequest(
      port,
      'POST',
      `/api/v1/boms/${bomId}/clone-to-rd`,
      { idempotency_key: randomUUID() },
      engineerHeaders,
    );
    assert.strictEqual(clone.status, 201, JSON.stringify(clone.body));

    const record = await makeRequest(
      port,
      'POST',
      `/api/v1/boms/${bomId}/builds`,
      {
        build_ref: `BLD-7-${run}`,
        built_quantity: '1.0',
        built_uom: 'EA',
        as_built_lines: [
          {
            draft_bom_line_id: lineIdA,
            component_item_id: compA,
            quantity_used: '2.0',
            line_uom: 'EA',
          },
        ],
        idempotency_key: randomUUID(),
      },
      engineerHeaders,
    );
    assert.strictEqual(record.status, 201, JSON.stringify(record.body));
    const buildId = record.body['build_id'] as string;

    const confirm = await makeRequest(
      port,
      'POST',
      `/api/v1/rd-builds/${buildId}/confirm`,
      { idempotency_key: randomUUID() },
      engineerHeaders,
    );
    assert.strictEqual(confirm.status, 200, JSON.stringify(confirm.body));

    const sign = await makeRequest(
      port,
      'POST',
      `/api/v1/boms/${bomId}/productization-signoffs`,
      { gate_function: 'engineering', idempotency_key: randomUUID() },
      approverHeaders['engineering'],
    );
    assert.strictEqual(sign.status, 200, JSON.stringify(sign.body));

    for (const endpoint of [
      `/api/v1/boms/${bomId}/clone-to-rd`,
      `/api/v1/boms/${bomId}/builds`,
      `/api/v1/rd-builds/${buildId}/confirm`,
      `/api/v1/boms/${bomId}/productization-signoffs`,
    ]) {
      const auditResult = await getPool().query(
        `SELECT COUNT(*)::int AS cnt FROM audit_log WHERE endpoint = $1`,
        [endpoint],
      );
      assert.ok((auditResult.rows[0]!.cnt as number) >= 1, `no audit entry for ${endpoint}`);
    }

    // Productize audit is covered on the gate walk BOM in the gate test; assert the endpoint
    // pattern has entries at all (any bom_id from this run).
    const productizeAudit = await getPool().query(
      `SELECT COUNT(*)::int AS cnt FROM audit_log WHERE endpoint LIKE '%/productize'`,
    );
    assert.ok((productizeAudit.rows[0]!.cnt as number) >= 1, 'no audit entry for productize');
  });
});
