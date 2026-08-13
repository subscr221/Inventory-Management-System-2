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
    req.setTimeout(15000, () => req.destroy(new Error(`Request timed out: ${method} ${path}`)));
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
    { externalId, email: externalId, displayName: externalId, roles },
    { Authorization: 'Bearer test-only-scim-bearer-token-not-for-production-use' },
  );
  assert.strictEqual(
    res.status,
    201,
    `provision ${externalId} failed: ${JSON.stringify(res.body)}`,
  );
  return (res.body as Record<string, string>)['userId']!;
}

/**
 * Exact decimal comparison through PostgreSQL NUMERIC - the codebase's own `numericEqual` idiom
 * (src/compliance/rd-bom.ts). Never parseFloat: an IEEE 754 round trip is exactly the defect this
 * assertion exists to catch. The typeof guard proves the value left the DB as a string.
 */
async function assertNumericEqual(
  actual: unknown,
  expected: string,
  message: string,
): Promise<void> {
  assert.strictEqual(typeof actual, 'string', `${message}: quantity must travel as a string`);
  const result = await getPool().query('SELECT $1::numeric = $2::numeric AS eq', [
    actual as string,
    expected,
  ]);
  assert.strictEqual(
    result.rows[0]!.eq,
    true,
    `${message}: got ${String(actual)}, expected ${expected}`,
  );
}

interface Requirement {
  depth: number;
  path: string;
  bom_line_id: string;
  line_no: number;
  component_item_id: string;
  component_sku: string | null;
  supply_method: string;
  required_quantity: string;
  scrap_percent: string | null;
  base_quantity_per: string;
  has_child_bom: boolean;
  via_phantom: boolean;
  alternates: { alternate_item_id: string; priority: number; origin: string }[];
}

describe('Story 5.5 Approved Alternates and BOM Explosion Integration Tests', () => {
  let server: Server;
  let port: number;
  let engineerHeaders: Record<string, string>;
  let readerHeaders: Record<string, string>;
  let noRoleHeaders: Record<string, string>;
  let approverHeaders: Record<string, string>;
  let approverUserId: string;

  // The two-level Released fixture built once in before() and shared by the AC 3 contract tests.
  const fx: {
    parentBomId: string;
    parentRevisionId: string;
    lines: Record<number, string>;
    itemC1: string;
    itemC2: string;
    itemSub: string;
    itemSubChild: string;
    itemPhantom: string;
    itemPhantomChild: string;
    altA: string;
    altB: string;
  } = {
    parentBomId: '',
    parentRevisionId: '',
    lines: {},
    itemC1: '',
    itemC2: '',
    itemSub: '',
    itemSubChild: '',
    itemPhantom: '',
    itemPhantomChild: '',
    altA: '',
    altB: '',
  };

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
      scrap_percent: '0.0',
      is_phantom: false,
      effective_from: '2020-01-01',
      ...overrides,
    };
  }

  async function draftBom(
    parentItemId: string,
    lines: Record<string, unknown>[],
    bomType: 'production' | 'rnd' = 'production',
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

  async function draftAndRelease(
    parentItemId: string,
    lines: Record<string, unknown>[],
  ): Promise<{ bomId: string; revisionId: string }> {
    const draft = await draftBom(parentItemId, lines);
    assert.strictEqual(draft.status, 201, `draft failed: ${JSON.stringify(draft.body)}`);
    const bomId = draft.body['bom_id'] as string;
    const release = await makeRequest(
      port,
      'POST',
      `/api/v1/boms/${bomId}/release`,
      { idempotency_key: randomUUID() },
      engineerHeaders,
    );
    assert.strictEqual(release.status, 200, `release failed: ${JSON.stringify(release.body)}`);
    return { bomId, revisionId: draft.body['current_revision_id'] as string };
  }

  async function lineIdsByLineNo(revisionId: string): Promise<Record<number, string>> {
    const result = await getPool().query(
      'SELECT line_no, bom_line_id FROM bom_line WHERE revision_id = $1',
      [revisionId],
    );
    const map: Record<number, string> = {};
    for (const row of result.rows as { line_no: number; bom_line_id: string }[]) {
      map[row.line_no] = row.bom_line_id;
    }
    return map;
  }

  async function defineAlternate(
    bomId: string,
    body: Record<string, unknown>,
    headers = engineerHeaders,
  ): Promise<HttpResult> {
    return makeRequest(
      port,
      'POST',
      `/api/v1/boms/${bomId}/alternates`,
      { effective_from: '2020-01-01', idempotency_key: randomUUID(), ...body },
      headers,
    );
  }

  async function approveSubstitution(
    bomId: string,
    body: Record<string, unknown>,
    headers = approverHeaders,
  ): Promise<HttpResult> {
    return makeRequest(
      port,
      'POST',
      `/api/v1/boms/${bomId}/substitution-approvals`,
      { effective_from: '2020-01-01', idempotency_key: randomUUID(), ...body },
      headers,
    );
  }

  async function explode(
    bomId: string,
    body: Record<string, unknown>,
    headers = engineerHeaders,
  ): Promise<HttpResult> {
    return makeRequest(
      port,
      'POST',
      `/api/v1/boms/${bomId}/explosion`,
      { idempotency_key: randomUUID(), ...body },
      headers,
    );
  }

  function requirementFor(body: Record<string, unknown>, path: string): Requirement {
    const requirements = body['requirements'] as Requirement[];
    const found = requirements.find((r) => r.path === path);
    assert.ok(found, `no requirement at path ${path}: ${JSON.stringify(requirements)}`);
    return found;
  }

  before(async () => {
    const pool = getPool();
    await pool.query('SET search_path TO public');

    const adminPool = getAdminPool();
    for (const sqlFile of [
      'read/projections/item_master.sql',
      'read/projections/business_stream_config.sql',
      'read/projections/bom.sql',
      'read/projections/bom_revision.sql',
      'read/projections/bom_line.sql',
      'read/projections/bom_structure.sql',
      'read/projections/bom_alternate.sql',
      'read/projections/bom_explosion.sql',
      'read/projections/bom_explosion_line.sql',
    ]) {
      const sql = readFileSync(resolve(__dirname, `../../${sqlFile}`), 'utf-8');
      await adminPool.query(sql);
    }

    server = createAppServer(createAppRouter());
    await new Promise<void>((resolvePromise) => {
      server.listen(0, () => resolvePromise());
    });
    port = (server.address() as AddressInfo).port;

    await provisionUser(port, `engineer55-${run}@test.com`, [
      { role: 'engineering_admin', module: 'engineering', functionScope: 'write', locationId: '*' },
      {
        role: 'inventory_controller',
        module: 'inventory',
        functionScope: 'write',
        locationId: '*',
      },
    ]);
    await provisionUser(port, `reader55-${run}@test.com`, [
      { role: 'bom_viewer', module: 'engineering', functionScope: 'read', locationId: '*' },
    ]);
    await provisionUser(port, `norole55-${run}@test.com`, [
      { role: 'nothing_55', module: 'unrelated_module', functionScope: 'read', locationId: '*' },
    ]);
    engineerHeaders = await authFor(port, `engineer55-${run}@test.com`);
    readerHeaders = await authFor(port, `reader55-${run}@test.com`);
    noRoleHeaders = await authFor(port, `norole55-${run}@test.com`);

    // DOA registry: one unbounded bom_substitution entry, resolved to a dedicated approver role
    // and holder (AC 2, AD-3). Mirrors the Story 5.3/5.4 seeding block.
    await provisionUser(port, `doa-admin-5-5-${run}@test.com`, [
      {
        role: 'compliance_admin_5_5',
        module: 'compliance',
        functionScope: 'write',
        locationId: '*',
      },
    ]);
    const doaHeaders = await authFor(port, `doa-admin-5-5-${run}@test.com`);
    const entryRes = await makeRequest(
      port,
      'POST',
      '/api/v1/doa/entries',
      {
        transaction_type: 'bom_substitution',
        role: 'bom_substitution_approver_5_5',
        value_min: null,
        value_max: null,
      },
      doaHeaders,
    );
    assert.strictEqual(entryRes.status, 201, JSON.stringify(entryRes.body));
    approverUserId = await provisionUser(port, `sub-approver-55-${run}@test.com`, [
      {
        role: 'bom_substitution_approver_5_5',
        module: 'engineering',
        functionScope: 'write',
        locationId: '*',
      },
    ]);
    approverHeaders = await authFor(port, `sub-approver-55-${run}@test.com`);

    // ---------------------------------------------------------------------
    // Two-level Released fixture (AC 3):
    //   parent line 1  C1        component, scrap 5%,     directed_issue
    //   parent line 2  SUB       component with its OWN released child BOM (depth descent)
    //   parent line 3  PHANTOM   phantom pass-through (never itself a requirement)
    //   parent line 4  C2        component, backflush
    //   parent line 5  COP       co_product output (never a requirement)
    // ---------------------------------------------------------------------
    fx.itemC1 = await createItem(`B55-C1-${run}`);
    fx.itemC2 = await createItem(`B55-C2-${run}`);
    fx.itemSub = await createItem(`B55-SUB-${run}`);
    fx.itemSubChild = await createItem(`B55-SUBC-${run}`);
    fx.itemPhantom = await createItem(`B55-PH-${run}`);
    fx.itemPhantomChild = await createItem(`B55-PHC-${run}`);
    fx.altA = await createItem(`B55-ALTA-${run}`);
    fx.altB = await createItem(`B55-ALTB-${run}`);
    const itemCoProduct = await createItem(`B55-COP-${run}`);
    const parentItem = await createItem(`B55-PARENT-${run}`);

    const child = await draftAndRelease(fx.itemSub, [
      componentLine(1, fx.itemSubChild, { quantity_per: '3.0' }),
    ]);
    const phantom = await draftAndRelease(fx.itemPhantom, [
      componentLine(1, fx.itemPhantomChild, { quantity_per: '4.0' }),
    ]);
    assert.ok(child.bomId && phantom.bomId);

    const parent = await draftAndRelease(parentItem, [
      componentLine(1, fx.itemC1, { quantity_per: '2.0', scrap_percent: '5.0' }),
      componentLine(2, fx.itemSub, { quantity_per: '1.0' }),
      componentLine(3, fx.itemPhantom, {
        quantity_per: '1.0',
        is_phantom: true,
        phantom_source_bom_id: phantom.bomId,
      }),
      componentLine(4, fx.itemC2, { quantity_per: '1.0', supply_method: 'backflush' }),
      componentLine(5, itemCoProduct, {
        quantity_per: '1.0',
        output_class: 'co_product',
        expected_yield_percent: '90.0',
      }),
    ]);
    fx.parentBomId = parent.bomId;
    fx.parentRevisionId = parent.revisionId;
    fx.lines = await lineIdsByLineNo(parent.revisionId);
  });

  after(async () => {
    server.close();
    const admin = await getAdminPool().connect();
    try {
      await admin.query(
        'TRUNCATE TABLE bom_explosion_line, bom_explosion, bom_alternate, bom_line, bom_revision, bom_structure, bom, doa_vacation_delegations, doa_registry_entries, user_role_assignments, users RESTART IDENTITY CASCADE',
      );
    } finally {
      admin.release();
    }
    await closePool();
    await closeAdminPool();
  });

  // -------------------------------------------------------------------------
  // AC 3: explosion contract tests (input: Released BOM + quantity -> per-line requirement set)
  // -------------------------------------------------------------------------

  it('explodes a Released BOM into the exact per-line requirement set', async () => {
    const res = await explode(fx.parentBomId, { quantity: '10' });
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));

    const requirements = res.body['requirements'] as Requirement[];
    assert.strictEqual(requirements.length, 5, JSON.stringify(requirements.map((r) => r.path)));
    assert.deepStrictEqual(
      requirements.map((r) => r.path),
      ['/1', '/2', '/2/1', '/3/1', '/4'],
    );

    // Scrap-adjusted: 10 * 2 * (1 + 5/100) = 21 exactly.
    const c1 = requirementFor(res.body, '/1');
    await assertNumericEqual(c1.required_quantity, '21', 'C1 scrap-adjusted quantity');
    assert.strictEqual(c1.component_item_id, fx.itemC1);
    assert.strictEqual(c1.depth, 0);
    assert.strictEqual(c1.supply_method, 'directed_issue');
    assert.strictEqual(c1.has_child_bom, false);
    assert.strictEqual(c1.via_phantom, false);
    await assertNumericEqual(c1.base_quantity_per, '2', 'C1 base_quantity_per');

    // Sub-assembly line and its child, one level down.
    const sub = requirementFor(res.body, '/2');
    await assertNumericEqual(sub.required_quantity, '10', 'SUB quantity');
    assert.strictEqual(sub.has_child_bom, true, 'SUB has its own released BOM');
    assert.strictEqual(sub.depth, 0);

    const subChild = requirementFor(res.body, '/2/1');
    await assertNumericEqual(subChild.required_quantity, '30', 'SUB child quantity (10 * 3)');
    assert.strictEqual(subChild.component_item_id, fx.itemSubChild);
    assert.strictEqual(subChild.depth, 1);
    assert.strictEqual(subChild.via_phantom, false);

    // Phantom pass-through: the phantom itself is absent, its child carries the multiplied
    // quantity and the via_phantom flag.
    assert.ok(
      !requirements.some((r) => r.component_item_id === fx.itemPhantom),
      'the phantom line must never be a requirement',
    );
    const phantomChild = requirementFor(res.body, '/3/1');
    assert.strictEqual(phantomChild.component_item_id, fx.itemPhantomChild);
    assert.strictEqual(phantomChild.via_phantom, true);
    assert.strictEqual(phantomChild.depth, 1);
    await assertNumericEqual(phantomChild.required_quantity, '40', 'phantom child quantity');

    // supply_method propagates per line.
    const c2 = requirementFor(res.body, '/4');
    assert.strictEqual(c2.supply_method, 'backflush');
    await assertNumericEqual(c2.required_quantity, '10', 'C2 quantity');

    // co_product lines are outputs, never inputs.
    assert.ok(
      requirements.every((r) => r.line_no !== 5),
      'co_product line must not generate a requirement',
    );

    assert.strictEqual(res.body['depth_truncated'], false);
    assert.strictEqual(res.body['requirement_count'], 5);
  });

  it('persists the explosion run durably and serves it from GET /api/v1/bom-explosions/:id', async () => {
    const res = await explode(fx.parentBomId, { quantity: '7.5' });
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    const explosionId = res.body['explosion_id'] as string;

    const rows = await getPool().query(
      'SELECT * FROM bom_explosion_line WHERE explosion_id = $1 ORDER BY path',
      [explosionId],
    );
    assert.strictEqual(rows.rows.length, 5);
    // 7.5 * 2 * 1.05 = 15.75 exactly.
    await assertNumericEqual(
      (rows.rows[0] as Record<string, unknown>)['required_quantity'],
      '15.75',
      'durable C1 quantity',
    );

    const header = await getPool().query(
      'SELECT requirement_count, depth_truncated FROM bom_explosion WHERE explosion_id = $1',
      [explosionId],
    );
    assert.strictEqual(header.rows[0]!.requirement_count, 5);
    assert.strictEqual(header.rows[0]!.depth_truncated, false);

    const read = await makeRequest(
      port,
      'GET',
      `/api/v1/bom-explosions/${explosionId}`,
      undefined,
      readerHeaders,
    );
    assert.strictEqual(read.status, 200, JSON.stringify(read.body));
    assert.strictEqual((read.body['requirements'] as Requirement[]).length, 5);
  });

  // -------------------------------------------------------------------------
  // AC 1: approved alternates - priority, effectivity, priority order at execution
  // -------------------------------------------------------------------------

  it('defines two approved alternates and serves them to execution in priority order', async () => {
    const bomLineId = fx.lines[1]!;
    const first = await defineAlternate(fx.parentBomId, {
      bom_line_id: bomLineId,
      alternate_item_id: fx.altB,
      priority: 2,
    });
    assert.strictEqual(first.status, 201, JSON.stringify(first.body));
    const second = await defineAlternate(fx.parentBomId, {
      bom_line_id: bomLineId,
      alternate_item_id: fx.altA,
      priority: 1,
    });
    assert.strictEqual(second.status, 201, JSON.stringify(second.body));

    const stored = await getPool().query(
      'SELECT origin, doa_entry_id, approver_actor_id FROM bom_alternate WHERE bom_line_id = $1',
      [bomLineId],
    );
    assert.strictEqual(stored.rows.length, 2);
    for (const row of stored.rows as Record<string, unknown>[]) {
      assert.strictEqual(row['origin'], 'approved');
      assert.strictEqual(row['doa_entry_id'], null);
      assert.strictEqual(row['approver_actor_id'], null);
    }

    const res = await explode(fx.parentBomId, { quantity: '1' });
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    const c1 = requirementFor(res.body, '/1');
    assert.deepStrictEqual(
      c1.alternates.map((a) => [a.alternate_item_id, a.priority, a.origin]),
      [
        [fx.altA, 1, 'approved'],
        [fx.altB, 2, 'approved'],
      ],
    );

    const list = await makeRequest(
      port,
      'GET',
      `/api/v1/boms/${fx.parentBomId}/alternates`,
      undefined,
      readerHeaders,
    );
    assert.strictEqual(list.status, 200, JSON.stringify(list.body));
    assert.strictEqual((list.body['alternates'] as unknown[]).length, 2);
  });

  it('rejects a second open alternate holding a priority already taken on the line', async () => {
    const res = await defineAlternate(fx.parentBomId, {
      bom_line_id: fx.lines[1]!,
      alternate_item_id: fx.itemC2,
      priority: 1,
    });
    assert.strictEqual(res.status, 409, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'ALTERNATE_PRIORITY_CONFLICT');
    assert.strictEqual((res.body['details'] as Record<string, unknown>)['priority'], 1);
  });

  it('rejects an overlapping effectivity window for the same alternate item on the line', async () => {
    const res = await defineAlternate(fx.parentBomId, {
      bom_line_id: fx.lines[1]!,
      alternate_item_id: fx.altA,
      priority: 7,
      effective_from: '2021-06-01',
    });
    assert.strictEqual(res.status, 409, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'EFFECTIVITY_OVERLAP');
    assert.ok((res.body['details'] as Record<string, unknown>)['bom_alternate_id']);
  });

  it('excludes an alternate whose effectivity window is not open on the explosion business date', async () => {
    const future = await defineAlternate(fx.parentBomId, {
      bom_line_id: fx.lines[4]!,
      alternate_item_id: fx.altA,
      priority: 1,
      effective_from: '2099-01-01',
    });
    assert.strictEqual(future.status, 201, JSON.stringify(future.body));

    const res = await explode(fx.parentBomId, { quantity: '1' });
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    assert.deepStrictEqual(requirementFor(res.body, '/4').alternates, []);
  });

  it('rejects alternate definition on a draft BOM, a placeholder line, and an inactive item', async () => {
    const draftParent = await createItem(`B55-DRAFT-${run}`);
    const draftComponent = await createItem(`B55-DRAFTC-${run}`);
    const draft = await draftBom(draftParent, [componentLine(1, draftComponent)]);
    assert.strictEqual(draft.status, 201, JSON.stringify(draft.body));
    const draftBomId = draft.body['bom_id'] as string;
    const draftLines = await lineIdsByLineNo(draft.body['current_revision_id'] as string);

    const notReleased = await defineAlternate(draftBomId, {
      bom_line_id: draftLines[1]!,
      alternate_item_id: fx.altA,
      priority: 1,
    });
    assert.strictEqual(notReleased.status, 409, JSON.stringify(notReleased.body));
    assert.strictEqual(notReleased.body['error_code'], 'BOM_NOT_RELEASED');

    // Placeholder lines only exist on R&D drafts (Story 5.4); they carry no component identity.
    const rndParent = await createItem(`B55-RNDP-${run}`);
    const rnd = await draftBom(
      rndParent,
      [
        {
          line_no: 1,
          is_placeholder: true,
          free_text: 'TBD bracket',
          output_class: 'component',
          quantity_per: '1.0',
          line_uom: 'EA',
          uom_conversion_factor: '1.0',
          scrap_percent: '0.0',
          is_phantom: false,
          effective_from: '2020-01-01',
        },
      ],
      'rnd',
    );
    assert.strictEqual(rnd.status, 201, JSON.stringify(rnd.body));
    const rndLines = await lineIdsByLineNo(rnd.body['current_revision_id'] as string);
    const placeholder = await defineAlternate(rnd.body['bom_id'] as string, {
      bom_line_id: rndLines[1]!,
      alternate_item_id: fx.altA,
      priority: 1,
    });
    assert.strictEqual(placeholder.status, 400, JSON.stringify(placeholder.body));
    assert.strictEqual(placeholder.body['error_code'], 'INVALID_PARAMS');

    // An inactive alternate item master fails the shared isReleasedItemMaster predicate.
    const inactive = await createItem(`B55-INACT-${run}`);
    await getAdminPool().query(`UPDATE item_master SET status = 'inactive' WHERE item_id = $1`, [
      inactive,
    ]);
    const inactiveRes = await defineAlternate(fx.parentBomId, {
      bom_line_id: fx.lines[2]!,
      alternate_item_id: inactive,
      priority: 5,
    });
    assert.strictEqual(inactiveRes.status, 409, JSON.stringify(inactiveRes.body));
    assert.strictEqual(inactiveRes.body['error_code'], 'BOM_ITEM_NOT_ACTIVE');
  });

  // -------------------------------------------------------------------------
  // AC 2: DOA-gated ad-hoc substitution
  // -------------------------------------------------------------------------

  it('records an ad-hoc substitution by the resolved DOA approver with evidence and an edit-log row', async () => {
    const bomLineId = fx.lines[2]!;
    const res = await approveSubstitution(fx.parentBomId, {
      bom_line_id: bomLineId,
      alternate_item_id: fx.altB,
      priority: 1,
    });
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));

    const stored = await getPool().query(
      `SELECT origin, doa_entry_id, approver_actor_id FROM bom_alternate WHERE bom_line_id = $1 AND alternate_item_id = $2`,
      [bomLineId, fx.altB],
    );
    assert.strictEqual(stored.rows.length, 1);
    const row = stored.rows[0] as Record<string, unknown>;
    assert.strictEqual(row['origin'], 'ad_hoc');
    assert.ok(row['doa_entry_id'], 'doa_entry_id must be stamped from the DOA resolution');
    assert.strictEqual(row['approver_actor_id'], approverUserId);

    // FR-AC-13: the substitution is written to the edit log by persistEvent's logAuditEntry.
    const audit = await getPool().query('SELECT 1 FROM audit_log WHERE endpoint = $1', [
      `/api/v1/boms/${fx.parentBomId}/substitution-approvals`,
    ]);
    assert.ok(audit.rows.length > 0, 'substitution approval must write an edit-log entry');
  });

  it('returns 403 APPROVAL_REQUIRED when the actor is outside the resolved DOA chain', async () => {
    const res = await approveSubstitution(
      fx.parentBomId,
      { bom_line_id: fx.lines[4]!, alternate_item_id: fx.altB, priority: 3 },
      engineerHeaders,
    );
    assert.strictEqual(res.status, 403, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'APPROVAL_REQUIRED');
    assert.strictEqual(
      (res.body['details'] as Record<string, unknown>)['transaction_type'],
      'bom_substitution',
    );
  });

  it('fails closed with 409 APPROVAL_UNRESOLVED when no governing DOA entry exists', async () => {
    const admin = getAdminPool();
    await admin.query(
      `UPDATE doa_registry_entries SET active = false WHERE transaction_type = 'bom_substitution'`,
    );
    try {
      const res = await approveSubstitution(fx.parentBomId, {
        bom_line_id: fx.lines[4]!,
        alternate_item_id: fx.altA,
        priority: 4,
      });
      assert.strictEqual(res.status, 409, JSON.stringify(res.body));
      assert.strictEqual(res.body['error_code'], 'APPROVAL_UNRESOLVED');
      assert.strictEqual(
        (res.body['details'] as Record<string, unknown>)['transaction_type'],
        'bom_substitution',
      );
    } finally {
      await admin.query(
        `UPDATE doa_registry_entries SET active = true WHERE transaction_type = 'bom_substitution'`,
      );
    }
  });

  it('rejects an ad-hoc substitution for an item already on the approved alternates list', async () => {
    const res = await approveSubstitution(fx.parentBomId, {
      bom_line_id: fx.lines[1]!,
      alternate_item_id: fx.altA,
      priority: 9,
    });
    assert.strictEqual(res.status, 409, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'ALTERNATE_ALREADY_APPROVED');
  });

  // -------------------------------------------------------------------------
  // Execution bar and state guards
  // -------------------------------------------------------------------------

  it('bars an R&D draft from explosion with RD_EXECUTION_BARRED (Story 5.4 handoff, on the real service)', async () => {
    const rndParent = await createItem(`B55-RND2-${run}`);
    const rndComponent = await createItem(`B55-RND2C-${run}`);
    const rnd = await draftBom(rndParent, [componentLine(1, rndComponent)], 'rnd');
    assert.strictEqual(rnd.status, 201, JSON.stringify(rnd.body));

    const res = await explode(rnd.body['bom_id'] as string, { quantity: '1' });
    assert.strictEqual(res.status, 409, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'RD_EXECUTION_BARRED');
    assert.strictEqual((res.body['details'] as Record<string, unknown>)['bom_type'], 'rnd');
  });

  it('rejects explosion of draft, held and obsolete BOMs with BOM_NOT_RELEASED', async () => {
    const draftParent = await createItem(`B55-STATE-${run}`);
    const draftComponent = await createItem(`B55-STATEC-${run}`);
    const draft = await draftBom(draftParent, [componentLine(1, draftComponent)]);
    const draftBomId = draft.body['bom_id'] as string;

    const draftRes = await explode(draftBomId, { quantity: '1' });
    assert.strictEqual(draftRes.status, 409, JSON.stringify(draftRes.body));
    assert.strictEqual(draftRes.body['error_code'], 'BOM_NOT_RELEASED');
    assert.strictEqual((draftRes.body['details'] as Record<string, unknown>)['status'], 'draft');

    const heldParent = await createItem(`B55-HELD-${run}`);
    const heldComponent = await createItem(`B55-HELDC-${run}`);
    const held = await draftAndRelease(heldParent, [componentLine(1, heldComponent)]);
    const holdRes = await makeRequest(
      port,
      'POST',
      `/api/v1/boms/${held.bomId}/hold`,
      { reason: 'quality concern', idempotency_key: randomUUID() },
      engineerHeaders,
    );
    assert.strictEqual(holdRes.status, 200, JSON.stringify(holdRes.body));

    const heldRes = await explode(held.bomId, { quantity: '1' });
    assert.strictEqual(heldRes.status, 409, JSON.stringify(heldRes.body));
    assert.strictEqual(heldRes.body['error_code'], 'BOM_NOT_RELEASED');
    assert.strictEqual((heldRes.body['details'] as Record<string, unknown>)['status'], 'on_hold');

    const obsoleteParent = await createItem(`B55-OBS-${run}`);
    const obsoleteComponent = await createItem(`B55-OBSC-${run}`);
    const obsolete = await draftAndRelease(obsoleteParent, [
      componentLine(1, obsoleteComponent),
    ]);
    const obsoleteRes = await makeRequest(
      port,
      'POST',
      `/api/v1/boms/${obsolete.bomId}/obsolete`,
      { reason: 'superseded', idempotency_key: randomUUID() },
      engineerHeaders,
    );
    assert.strictEqual(obsoleteRes.status, 200, JSON.stringify(obsoleteRes.body));

    const obsoleteExplosion = await explode(obsolete.bomId, { quantity: '1' });
    assert.strictEqual(obsoleteExplosion.status, 409, JSON.stringify(obsoleteExplosion.body));
    assert.strictEqual(obsoleteExplosion.body['error_code'], 'BOM_NOT_RELEASED');
    assert.strictEqual(
      (obsoleteExplosion.body['details'] as Record<string, unknown>)['status'],
      'obsolete',
    );
  });

  it('rejects zero, negative and malformed explosion quantities with EXPLOSION_QUANTITY_INVALID', async () => {
    for (const quantity of ['0', '-5', 'abc', '0x10', '1e3', '', '1.1234567']) {
      const res = await explode(fx.parentBomId, { quantity });
      assert.strictEqual(res.status, 400, `quantity ${quantity}: ${JSON.stringify(res.body)}`);
      assert.strictEqual(
        res.body['error_code'],
        'EXPLOSION_QUANTITY_INVALID',
        `quantity ${quantity}`,
      );
    }
    const missing = await explode(fx.parentBomId, {});
    assert.strictEqual(missing.status, 400, JSON.stringify(missing.body));
    assert.strictEqual(missing.body['error_code'], 'EXPLOSION_QUANTITY_INVALID');
  });

  it('returns BOM_NOT_FOUND for an unknown bom_id', async () => {
    const res = await explode(randomUUID(), { quantity: '1' });
    assert.strictEqual(res.status, 404, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'BOM_NOT_FOUND');
  });

  // -------------------------------------------------------------------------
  // Platform gates: direct-event rejection, RBAC, idempotent replay
  // -------------------------------------------------------------------------

  it('rejects a WELL-FORMED direct POST /api/v1/events for each new engineering event type', async () => {
    for (const eventType of [
      'bom.alternate_defined',
      'bom.substitution_approved',
      'bom.exploded',
    ]) {
      const res = await makeRequest(
        port,
        'POST',
        '/api/v1/events',
        {
          event_id: randomUUID(),
          stream_type: 'engineering',
          stream_id: fx.parentBomId,
          event_type: eventType,
          payload: { bom_id: fx.parentBomId },
          metadata: {
            correlation_id: randomUUID(),
            occurred_at: new Date().toISOString(),
            actor: { user_id: randomUUID(), role: 'engineering_admin', location_id: randomUUID() },
          },
          idempotency_key: randomUUID(),
        },
        engineerHeaders,
      );
      assert.strictEqual(res.status, 400, `${eventType}: ${JSON.stringify(res.body)}`);
      // A malformed envelope would fail as INVALID_EVENT_ENVELOPE - i.e. for the wrong reason.
      assert.strictEqual(res.body['error_code'], 'INVALID_EVENT_STREAM', eventType);
    }
  });

  it('denies every route to a user outside the engineering module, and every mutation to a read-only engineer', async () => {
    const cases: [string, string, unknown][] = [
      [
        'POST',
        `/api/v1/boms/${fx.parentBomId}/alternates`,
        {
          bom_line_id: fx.lines[1]!,
          alternate_item_id: fx.altA,
          priority: 1,
          effective_from: '2020-01-01',
        },
      ],
      ['GET', `/api/v1/boms/${fx.parentBomId}/alternates`, undefined],
      [
        'POST',
        `/api/v1/boms/${fx.parentBomId}/substitution-approvals`,
        {
          bom_line_id: fx.lines[1]!,
          alternate_item_id: fx.altA,
          priority: 1,
          effective_from: '2020-01-01',
        },
      ],
      ['POST', `/api/v1/boms/${fx.parentBomId}/explosion`, { quantity: '1' }],
      ['GET', `/api/v1/bom-explosions/${randomUUID()}`, undefined],
    ];
    // No engineering assignment at all: the module gate fires first.
    for (const [method, path, body] of cases) {
      const res = await makeRequest(port, method, path, body, noRoleHeaders);
      assert.strictEqual(res.status, 403, `${method} ${path}: ${JSON.stringify(res.body)}`);
      assert.strictEqual(res.body['error_code'], 'MODULE_ACCESS_DENIED', `${method} ${path}`);
    }
    // Engineering READ assignment against a write route: the function-scope gate fires.
    for (const [method, path, body] of cases.filter(([m]) => m === 'POST')) {
      const res = await makeRequest(port, method, path, body, readerHeaders);
      assert.strictEqual(res.status, 403, `${method} ${path}: ${JSON.stringify(res.body)}`);
      assert.strictEqual(res.body['error_code'], 'FUNCTION_ACCESS_DENIED', `${method} ${path}`);
    }
  });

  it('returns the original explosion on an idempotent replay and persists exactly one run', async () => {
    const idempotencyKey = randomUUID();
    const first = await explode(fx.parentBomId, { quantity: '3', idempotency_key: idempotencyKey });
    assert.strictEqual(first.status, 201, JSON.stringify(first.body));
    const second = await explode(fx.parentBomId, {
      quantity: '3',
      idempotency_key: idempotencyKey,
    });
    assert.strictEqual(second.status, 201, JSON.stringify(second.body));

    assert.strictEqual(second.body['explosion_id'], first.body['explosion_id']);
    assert.deepStrictEqual(second.body['requirements'], first.body['requirements']);

    const rows = await getPool().query(
      'SELECT COUNT(*)::int AS cnt FROM bom_explosion WHERE explosion_id = $1',
      [first.body['explosion_id'] as string],
    );
    assert.strictEqual(rows.rows[0]!.cnt, 1);
  });

  it('rejects a duplicate approved alternate entry on the same line, item and effective_from', async () => {
    const bomLineId = fx.lines[4]!;
    const first = await defineAlternate(fx.parentBomId, {
      bom_line_id: bomLineId,
      alternate_item_id: fx.itemC1,
      priority: 8,
      effective_from: '2022-01-01',
      effective_to: '2022-12-31',
    });
    assert.strictEqual(first.status, 201, JSON.stringify(first.body));

    const duplicate = await defineAlternate(fx.parentBomId, {
      bom_line_id: bomLineId,
      alternate_item_id: fx.itemC1,
      priority: 11,
      effective_from: '2022-01-01',
      effective_to: '2022-12-31',
    });
    assert.strictEqual(duplicate.status, 409, JSON.stringify(duplicate.body));
    assert.strictEqual(duplicate.body['error_code'], 'EFFECTIVITY_OVERLAP');
  });

  it('allows an ad-hoc substitution whose window is disjoint from an approved alternate, and rejects an overlapping one with ALTERNATE_ALREADY_APPROVED', async () => {
    // Fresh item on purpose: fx.altA/altB already carry alternates from earlier tests.
    const disjointItem = await createItem(`B55-DISJ-${run}`);
    const bomLineId = fx.lines[4]!;
    const approved = await defineAlternate(fx.parentBomId, {
      bom_line_id: bomLineId,
      alternate_item_id: disjointItem,
      priority: 20,
      effective_from: '2020-01-01',
      effective_to: '2020-12-31',
    });
    assert.strictEqual(approved.status, 201, JSON.stringify(approved.body));

    // The approved window has closed: the item is NOT on the effective approved list, so a
    // substitution whose window never intersects it is legitimate (execution read-model
    // semantics; the ALTERNATE_ALREADY_APPROVED gate is window-aware).
    const disjoint = await approveSubstitution(fx.parentBomId, {
      bom_line_id: bomLineId,
      alternate_item_id: disjointItem,
      priority: 21,
      effective_from: '2021-01-01',
    });
    assert.strictEqual(disjoint.status, 201, JSON.stringify(disjoint.body));

    // An overlapping window still hits the governance gate: the item IS on the effective list.
    const overlapping = await approveSubstitution(fx.parentBomId, {
      bom_line_id: bomLineId,
      alternate_item_id: disjointItem,
      priority: 22,
      effective_from: '2020-06-01',
      effective_to: '2021-12-31',
    });
    assert.strictEqual(overlapping.status, 409, JSON.stringify(overlapping.body));
    assert.strictEqual(overlapping.body['error_code'], 'ALTERNATE_ALREADY_APPROVED');
  });

  it('rejects alternate definition on a phantom line with INVALID_PARAMS', async () => {
    // fx.lines[3] is the phantom pass-through line of the parent fixture: it never becomes a
    // requirement, so an alternate defined on it would be accepted but never surface at
    // execution. The seam rejects it at definition time, mirroring the placeholder guard.
    const res = await defineAlternate(fx.parentBomId, {
      bom_line_id: fx.lines[3]!,
      alternate_item_id: fx.altA,
      priority: 1,
      effective_from: '2020-01-01',
    });
    assert.strictEqual(res.status, 400, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'INVALID_PARAMS');
  });
});
