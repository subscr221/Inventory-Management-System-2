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
import { toIstCalendarDate } from '../../src/lib/business-days.js';

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
 * Exact decimal comparison through PostgreSQL NUMERIC - the codebase's own `numericEqual` idiom.
 * Never parseFloat: an IEEE 754 round trip is exactly the defect this assertion exists to catch.
 * The typeof guard proves the value left the DB as a string.
 */
async function assertNumericEqual(
  actual: unknown,
  expected: string,
  message: string,
): Promise<void> {
  assert.strictEqual(typeof actual, 'string', `${message}: cost must travel as a string`);
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

interface RollupLine {
  rollup_line_id: string;
  depth: number;
  path: string;
  line_no: number;
  component_sku: string | null;
  effective_quantity_per: string;
  scrap_percent: string | null;
  unit_cost: string | null;
  extended_cost: string;
  rate_missing: boolean;
  via_phantom: boolean;
  has_child_bom: boolean;
}

interface LineDelta {
  path: string;
  line_no: number;
  status: string;
  base_extended_cost: string | null;
  compare_extended_cost: string | null;
  extended_cost_delta: string;
}

describe('Story 5.6 Cost Rollups, Job-Work Kit Tagging, and ERP Outbound Sync', () => {
  let server: Server;
  let port: number;
  let engineerHeaders: Record<string, string>;
  let readerHeaders: Record<string, string>;
  let noRoleHeaders: Record<string, string>;
  let erpHeaders: Record<string, string>;

  // The two-level draft fixture built once in before() and shared by the AC 1/AC 2 tests.
  const fx: {
    parentBomId: string;
    parentRevisionId: string;
    childBomId: string;
    itemC1: string;
    itemMid: string;
    itemLeaf: string;
    itemPhantom: string;
    itemPhantomChild: string;
    lines: Record<number, string>;
  } = {
    parentBomId: '',
    parentRevisionId: '',
    childBomId: '',
    itemC1: '',
    itemMid: '',
    itemLeaf: '',
    itemPhantom: '',
    itemPhantomChild: '',
    lines: {},
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
        // A usable Ind AS 2 rate by default; the standard_cost_amount pairing constraint means
        // the designation must travel with it. Tests that want a rate-less component pass
        // { standard_cost_designation: null, standard_cost_amount: null }.
        standard_cost_designation: 'ind_as_2_para_21_measurement_technique',
        standard_cost_amount: 10,
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
    bomType: 'production' | 'rnd' | 'job_work_kit' = 'production',
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

  async function runRollup(bomId: string, headers = engineerHeaders): Promise<HttpResult> {
    return makeRequest(
      port,
      'POST',
      `/api/v1/boms/${bomId}/cost-rollups`,
      { idempotency_key: randomUUID() },
      headers,
    );
  }

  async function releaseBom(bomId: string, headers = engineerHeaders): Promise<HttpResult> {
    return makeRequest(
      port,
      'POST',
      `/api/v1/boms/${bomId}/release`,
      { idempotency_key: randomUUID() },
      headers,
    );
  }

  async function draftAndRelease(
    parentItemId: string,
    lines: Record<string, unknown>[],
  ): Promise<{ bomId: string; revisionId: string }> {
    const draft = await draftBom(parentItemId, lines);
    assert.strictEqual(draft.status, 201, `draft failed: ${JSON.stringify(draft.body)}`);
    const bomId = draft.body['bom_id'] as string;
    const rollup = await runRollup(bomId);
    assert.strictEqual(rollup.status, 201, `rollup failed: ${JSON.stringify(rollup.body)}`);
    const release = await releaseBom(bomId);
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

  function lineAt(body: Record<string, unknown>, path: string): RollupLine {
    const lines = body['lines'] as RollupLine[];
    const found = lines.find((l) => l.path === path);
    assert.ok(found, `no rollup line at path ${path}: ${JSON.stringify(lines)}`);
    return found;
  }

  /** Snapshot of the whole BOM family for the AC 5 non-mutation assertions. A row-level md5 of
   *  every row (including updated_at) so any mutation to any row is detected, not just a
   *  MAX(updated_at) clock. */
  async function bomFamilySnapshot(): Promise<string> {
    const result = await getPool().query(
      `SELECT
         (SELECT md5(COALESCE(string_agg(row_to_json(x)::text, '' ORDER BY x.bom_id), '')) FROM bom x) AS bom_hash,
         (SELECT md5(COALESCE(string_agg(row_to_json(x)::text, '' ORDER BY x.revision_id), '')) FROM bom_revision x) AS revision_hash,
         (SELECT md5(COALESCE(string_agg(row_to_json(x)::text, '' ORDER BY x.bom_line_id), '')) FROM bom_line x) AS line_hash`,
    );
    return JSON.stringify(result.rows[0]);
  }

  async function postErpSync(body: Record<string, unknown>): Promise<HttpResult> {
    return makeRequest(port, 'POST', '/api/v1/erp/sync', body, erpHeaders);
  }

  async function openBomExceptions(): Promise<Record<string, unknown>[]> {
    const result = await getPool().query(
      `SELECT exception_id, source_record_ref, error_code, reason, details, status, raised_at
         FROM integration_exception WHERE record_type = 'bom' AND status = 'open'
         ORDER BY raised_at DESC`,
    );
    return result.rows as Record<string, unknown>[];
  }

  async function syncConflictEventCount(sourceRecordRef: string): Promise<number> {
    const result = await getPool().query(
      `SELECT COUNT(*)::int AS cnt FROM domain_events
        WHERE event_type = 'bom.sync_conflict_raised'
          AND payload ->> 'source_record_ref' = $1`,
      [sourceRecordRef],
    );
    return Number(result.rows[0]!.cnt);
  }

  before(async () => {
    const pool = getPool();
    await pool.query('SET search_path TO public');

    const adminPool = getAdminPool();
    for (const sqlFile of [
      'read/projections/item_master.sql',
      'read/projections/business_stream_config.sql',
      'read/projections/integration_exception.sql',
      'read/projections/bom.sql',
      'read/projections/bom_revision.sql',
      'read/projections/bom_line.sql',
      'read/projections/bom_structure.sql',
      'read/projections/bom_cost_rollup.sql',
      'read/projections/bom_cost_rollup_line.sql',
      'read/projections/bom_outbound_message.sql',
    ]) {
      const sql = readFileSync(resolve(__dirname, `../../${sqlFile}`), 'utf-8');
      await adminPool.query(sql);
    }

    server = createAppServer(createAppRouter());
    await new Promise<void>((resolvePromise) => {
      server.listen(0, () => resolvePromise());
    });
    port = (server.address() as AddressInfo).port;

    await provisionUser(port, `engineer56-${run}@test.com`, [
      { role: 'engineering_admin', module: 'engineering', functionScope: 'write', locationId: '*' },
      {
        role: 'inventory_controller',
        module: 'inventory',
        functionScope: 'write',
        locationId: '*',
      },
    ]);
    await provisionUser(port, `reader56-${run}@test.com`, [
      { role: 'bom_viewer', module: 'engineering', functionScope: 'read', locationId: '*' },
    ]);
    await provisionUser(port, `norole56-${run}@test.com`, [
      { role: 'nothing_56', module: 'unrelated_module', functionScope: 'read', locationId: '*' },
    ]);
    await provisionUser(port, `erp56-${run}@test.com`, [
      { role: 'svc_erp_adapter', module: 'inventory', functionScope: 'write', locationId: '*' },
      { role: 'engineering_admin', module: 'engineering', functionScope: 'write', locationId: '*' },
    ]);
    engineerHeaders = await authFor(port, `engineer56-${run}@test.com`);
    readerHeaders = await authFor(port, `reader56-${run}@test.com`);
    noRoleHeaders = await authFor(port, `norole56-${run}@test.com`);
    erpHeaders = await authFor(port, `erp56-${run}@test.com`);

    // ---------------------------------------------------------------------
    // Two-level DRAFT fixture (AC 1). The parent stays draft on purpose: a rollup is a
    // release-gate input, so it must run before the BOM can ever reach 'released'.
    //   parent line 1  C1        rate 2, qty 2, scrap 5%   -> leaf, costed
    //   parent line 2  MID       has its own RELEASED child BOM -> parent node, costs nothing
    //   parent line 3  PHANTOM   phantom pass-through -> never itself a costed line
    //   parent line 4  COP       co_product output -> never costed
    // ---------------------------------------------------------------------
    fx.itemC1 = await createItem(`B56-C1-${run}`, { standard_cost_amount: 2 });
    fx.itemLeaf = await createItem(`B56-LEAF-${run}`, { standard_cost_amount: 5 });
    fx.itemMid = await createItem(`B56-MID-${run}`, { standard_cost_amount: 999 });
    fx.itemPhantom = await createItem(`B56-PH-${run}`, { standard_cost_amount: 777 });
    fx.itemPhantomChild = await createItem(`B56-PHC-${run}`, { standard_cost_amount: 4 });
    const itemCoProduct = await createItem(`B56-COP-${run}`);
    const parentItem = await createItem(`B56-PARENT-${run}`);

    const child = await draftAndRelease(fx.itemMid, [
      componentLine(1, fx.itemLeaf, { quantity_per: '3.0' }),
    ]);
    fx.childBomId = child.bomId;
    const phantomSource = await draftAndRelease(fx.itemPhantom, [
      componentLine(1, fx.itemPhantomChild, { quantity_per: '4.0' }),
    ]);

    const parent = await draftBom(parentItem, [
      componentLine(1, fx.itemC1, { quantity_per: '2.0', scrap_percent: '5.0' }),
      componentLine(2, fx.itemMid, { quantity_per: '1.0' }),
      componentLine(3, fx.itemPhantom, {
        quantity_per: '1.0',
        is_phantom: true,
        phantom_source_bom_id: phantomSource.bomId,
      }),
      componentLine(4, itemCoProduct, {
        quantity_per: '1.0',
        output_class: 'co_product',
        expected_yield_percent: '90.0',
      }),
    ]);
    assert.strictEqual(parent.status, 201, JSON.stringify(parent.body));
    fx.parentBomId = parent.body['bom_id'] as string;
    fx.parentRevisionId = parent.body['current_revision_id'] as string;
    fx.lines = await lineIdsByLineNo(fx.parentRevisionId);
  });

  after(async () => {
    server.close();
    const admin = await getAdminPool().connect();
    try {
      await admin.query(
        'TRUNCATE TABLE bom_cost_rollup_line, bom_cost_rollup, bom_outbound_message, integration_exception, bom_explosion_line, bom_explosion, bom_alternate, bom_line, bom_revision, bom_structure, bom, doa_vacation_delegations, doa_registry_entries, user_role_assignments, users RESTART IDENTITY CASCADE',
      );
    } finally {
      admin.release();
    }
    await closePool();
    await closeAdminPool();
  });

  // -------------------------------------------------------------------------
  // AC 1: dated snapshots, exact NUMERIC costs, no double counting
  // -------------------------------------------------------------------------

  it('rolls up a two-level Draft BOM into a dated snapshot with exact costs and no double counting', async () => {
    const res = await runRollup(fx.parentBomId);
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    assert.strictEqual(res.body['bom_id'], fx.parentBomId);
    assert.strictEqual(res.body['revision_id'], fx.parentRevisionId);
    assert.strictEqual(res.body['rate_basis'], 'item_master_standard_cost');
    assert.strictEqual(res.body['rollup_date'], toIstCalendarDate(new Date()));
    assert.strictEqual(res.body['missing_rate_count'], 0);
    assert.strictEqual(res.body['depth_truncated'], false);

    // The phantom line itself and the co_product line are never costed lines.
    const lines = res.body['lines'] as RollupLine[];
    assert.deepStrictEqual(
      lines.map((l) => l.path),
      ['/1', '/2', '/2/1', '/3/1'],
    );
    assert.strictEqual(res.body['line_count'], 4);

    // C1 is a leaf: 1 * 2 * (1 + 5/100) = 2.1 at rate 2 -> 4.2 exactly.
    const c1 = lineAt(res.body, '/1');
    await assertNumericEqual(c1.effective_quantity_per, '2.1', 'C1 scrap-adjusted quantity');
    await assertNumericEqual(c1.unit_cost, '2', 'C1 unit cost');
    await assertNumericEqual(c1.extended_cost, '4.2', 'C1 extended cost');
    assert.strictEqual(c1.rate_missing, false);
    assert.strictEqual(c1.has_child_bom, false);
    assert.strictEqual(c1.via_phantom, false);

    // MID has a costed child, so it contributes ZERO itself even though it carries a rate of 999.
    // This is the double-counting defense; a regression here shows up as a 999-sized total.
    const mid = lineAt(res.body, '/2');
    assert.strictEqual(mid.has_child_bom, true);
    assert.strictEqual(mid.unit_cost, null);
    await assertNumericEqual(mid.extended_cost, '0', 'parent node contributes nothing');
    assert.strictEqual(mid.rate_missing, false, 'a parent node is never a missing rate');

    // The child's leaf: 1 * 3 * 1 = 3 at rate 5 -> 15.
    const leaf = lineAt(res.body, '/2/1');
    assert.strictEqual(leaf.depth, 1);
    await assertNumericEqual(leaf.extended_cost, '15', 'child leaf extended cost');

    // Phantom pass-through: the phantom's CHILD is costed and flagged via_phantom.
    const phantomChild = lineAt(res.body, '/3/1');
    assert.strictEqual(phantomChild.via_phantom, true);
    await assertNumericEqual(phantomChild.effective_quantity_per, '4', 'phantom child quantity');
    await assertNumericEqual(phantomChild.extended_cost, '16', 'phantom child extended cost');

    // Hand-computed leaf sum: 4.2 + 15 + 16 = 35.2. Counted exactly once.
    await assertNumericEqual(res.body['total_cost'], '35.2', 'total_cost');

    // Durable state, not just the response body.
    const persisted = await getPool().query(
      'SELECT total_cost, line_count, missing_rate_count, rollup_date::text AS rollup_date FROM bom_cost_rollup WHERE rollup_id = $1',
      [res.body['rollup_id']],
    );
    assert.strictEqual(persisted.rows.length, 1);
    await assertNumericEqual(persisted.rows[0]!.total_cost, '35.2', 'persisted total_cost');
    const persistedLines = await getPool().query(
      'SELECT COUNT(*)::int AS cnt FROM bom_cost_rollup_line WHERE rollup_id = $1',
      [res.body['rollup_id']],
    );
    assert.strictEqual(persistedLines.rows[0]!.cnt, 4);
  });

  it('leaves every prior snapshot intact when a second rollup runs on the same BOM', async () => {
    const first = await runRollup(fx.parentBomId);
    assert.strictEqual(first.status, 201, JSON.stringify(first.body));
    const firstId = first.body['rollup_id'] as string;
    const firstLines = await getPool().query(
      'SELECT rollup_line_id, extended_cost, created_at FROM bom_cost_rollup_line WHERE rollup_id = $1 ORDER BY rollup_line_id',
      [firstId],
    );

    const second = await runRollup(fx.parentBomId);
    assert.strictEqual(second.status, 201, JSON.stringify(second.body));
    const secondId = second.body['rollup_id'] as string;
    assert.notStrictEqual(firstId, secondId, 'each run mints its own rollup_id');

    const survivors = await getPool().query(
      'SELECT rollup_id FROM bom_cost_rollup WHERE rollup_id = ANY($1::uuid[])',
      [[firstId, secondId]],
    );
    assert.strictEqual(survivors.rows.length, 2, 'both snapshots survive');

    const firstLinesAfter = await getPool().query(
      'SELECT rollup_line_id, extended_cost, created_at FROM bom_cost_rollup_line WHERE rollup_id = $1 ORDER BY rollup_line_id',
      [firstId],
    );
    assert.deepStrictEqual(
      firstLinesAfter.rows,
      firstLines.rows,
      'the earlier snapshot rows are byte-unchanged',
    );

    const listed = await makeRequest(
      port,
      'GET',
      `/api/v1/boms/${fx.parentBomId}/cost-rollups`,
      undefined,
      readerHeaders,
    );
    assert.strictEqual(listed.status, 200, JSON.stringify(listed.body));
    const listedIds = (listed.body['cost_rollups'] as { rollup_id: string }[]).map(
      (r) => r.rollup_id,
    );
    assert.ok(
      listedIds.includes(firstId) && listedIds.includes(secondId),
      'the list returns both snapshots',
    );
    assert.ok(
      listedIds.indexOf(secondId) < listedIds.indexOf(firstId),
      'the newer snapshot is listed before the earlier one',
    );
  });

  it('records a missing rate instead of failing, on both a rate-less and a designation-less component', async () => {
    // standard_cost_amount cannot exist without the Ind AS designation (the item_master pairing
    // constraint), so "amount with no designation" is unrepresentable - the reachable shapes are
    // no amount at all, which is what this fixture uses.
    const noRate = await createItem(`B56-NORATE-${run}`, {
      standard_cost_designation: null,
      standard_cost_amount: null,
    });
    const parent = await createItem(`B56-NORATE-P-${run}`);
    const draft = await draftBom(parent, [
      componentLine(1, fx.itemC1, { quantity_per: '1.0' }),
      componentLine(2, noRate, { quantity_per: '1.0' }),
    ]);
    assert.strictEqual(draft.status, 201, JSON.stringify(draft.body));

    const res = await runRollup(draft.body['bom_id'] as string);
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    assert.strictEqual(res.body['missing_rate_count'], 1);
    const missing = lineAt(res.body, '/2');
    assert.strictEqual(missing.unit_cost, null);
    assert.strictEqual(missing.rate_missing, true);
    await assertNumericEqual(missing.extended_cost, '0', 'a rate-less line costs zero');
    // The rated sibling still costs normally: 1 * 1 * 1 * 2 = 2.
    await assertNumericEqual(res.body['total_cost'], '2', 'total over the rated line only');
  });

  // -------------------------------------------------------------------------
  // AC 2: comparison across snapshots
  // -------------------------------------------------------------------------

  it('compares two snapshots with per-line deltas and a total delta that equals their sum', async () => {
    const componentASku = `B56-CMP-A-${run}`;
    const componentA = await createItem(componentASku, { standard_cost_amount: 3 });
    const componentB = await createItem(`B56-CMP-B-${run}`, { standard_cost_amount: 7 });
    const parent = await createItem(`B56-CMP-P-${run}`);
    const draft = await draftBom(parent, [
      componentLine(1, componentA, { quantity_per: '1.0' }),
      componentLine(2, componentB, { quantity_per: '1.0' }),
    ]);
    const bomId = draft.body['bom_id'] as string;
    const revisionId = draft.body['current_revision_id'] as string;

    const base = await runRollup(bomId);
    assert.strictEqual(base.status, 201, JSON.stringify(base.body));

    // Change component A's rate, then amend line 2's quantity: one 'changed' line by cost and one
    // by quantity, so the comparison is exercised on both axes.
    const rateChange = await makeRequest(
      port,
      'PATCH',
      `/api/v1/items/${componentASku}`,
      { standard_cost_amount: 6 },
      engineerHeaders,
    );
    assert.strictEqual(rateChange.status, 200, JSON.stringify(rateChange.body));
    const lineIds = await lineIdsByLineNo(revisionId);
    const amend = await makeRequest(
      port,
      'PATCH',
      `/api/v1/boms/${bomId}/lines/${lineIds[2]!}`,
      { quantity_per: '2.0', idempotency_key: randomUUID() },
      engineerHeaders,
    );
    assert.strictEqual(amend.status, 200, JSON.stringify(amend.body));

    const compare = await runRollup(bomId);
    assert.strictEqual(compare.status, 201, JSON.stringify(compare.body));

    const res = await makeRequest(
      port,
      'GET',
      `/api/v1/bom-cost-rollups/compare?base=${base.body['rollup_id'] as string}&compare=${compare.body['rollup_id'] as string}`,
      undefined,
      readerHeaders,
    );
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    const deltas = res.body['line_deltas'] as LineDelta[];
    assert.strictEqual(deltas.length, 2, JSON.stringify(deltas));
    for (const delta of deltas) {
      assert.strictEqual(delta.status, 'changed', JSON.stringify(delta));
    }
    // Line 1: 3 -> 6 (delta 3). Line 2: 7 -> 14 (delta 7). Total 10.
    await assertNumericEqual(deltas[0]!.extended_cost_delta, '3', 'line 1 delta');
    await assertNumericEqual(deltas[1]!.extended_cost_delta, '7', 'line 2 delta');
    const sum = await getPool().query(
      'SELECT COALESCE(SUM(v::numeric), 0)::text AS total FROM unnest($1::text[]) AS v',
      [deltas.map((d) => d.extended_cost_delta)],
    );
    await assertNumericEqual(
      res.body['total_delta'],
      sum.rows[0]!.total as string,
      'total_delta equals the sum of line deltas',
    );
  });

  it('reports added, removed and unchanged line statuses across snapshots', async () => {
    const keep = await createItem(`B56-KEEP-${run}`, { standard_cost_amount: 1 });
    const drop = await createItem(`B56-DROP-${run}`, { standard_cost_amount: 1 });
    const add = await createItem(`B56-ADD-${run}`, { standard_cost_amount: 1 });
    const parent = await createItem(`B56-STAT-P-${run}`);
    const draft = await draftBom(parent, [
      componentLine(1, keep, { quantity_per: '1.0' }),
      componentLine(2, drop, { quantity_per: '1.0', effective_to: '2030-01-01' }),
    ]);
    const bomId = draft.body['bom_id'] as string;
    const revisionId = draft.body['current_revision_id'] as string;
    const base = await runRollup(bomId);

    // Close line 2's effectivity in the past (it drops out of the walk) and add a new line 3.
    const lineIds = await lineIdsByLineNo(revisionId);
    const closed = await makeRequest(
      port,
      'PATCH',
      `/api/v1/boms/${bomId}/lines/${lineIds[2]!}`,
      { effective_to: '2020-01-02', idempotency_key: randomUUID() },
      engineerHeaders,
    );
    assert.strictEqual(closed.status, 200, JSON.stringify(closed.body));
    const added = await makeRequest(
      port,
      'POST',
      `/api/v1/boms/${bomId}/lines`,
      { ...componentLine(3, add, { quantity_per: '1.0' }), idempotency_key: randomUUID() },
      engineerHeaders,
    );
    assert.strictEqual(added.status, 200, JSON.stringify(added.body));

    const compare = await runRollup(bomId);
    const res = await makeRequest(
      port,
      'GET',
      `/api/v1/bom-cost-rollups/compare?base=${base.body['rollup_id'] as string}&compare=${compare.body['rollup_id'] as string}`,
      undefined,
      readerHeaders,
    );
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    const byPath = new Map((res.body['line_deltas'] as LineDelta[]).map((d) => [d.path, d.status]));
    assert.strictEqual(byPath.get('/1'), 'unchanged', JSON.stringify(res.body['line_deltas']));
    assert.strictEqual(byPath.get('/2'), 'removed', JSON.stringify(res.body['line_deltas']));
    assert.strictEqual(byPath.get('/3'), 'added', JSON.stringify(res.body['line_deltas']));
  });

  it('rejects a cross-BOM comparison and a self comparison with COST_ROLLUP_COMPARE_INVALID', async () => {
    const mine = await runRollup(fx.parentBomId);
    const otherParent = await createItem(`B56-OTHER-${run}`);
    const otherComponent = await createItem(`B56-OTHERC-${run}`);
    const otherDraft = await draftBom(otherParent, [componentLine(1, otherComponent)]);
    const theirs = await runRollup(otherDraft.body['bom_id'] as string);

    const cross = await makeRequest(
      port,
      'GET',
      `/api/v1/bom-cost-rollups/compare?base=${mine.body['rollup_id'] as string}&compare=${theirs.body['rollup_id'] as string}`,
      undefined,
      readerHeaders,
    );
    assert.strictEqual(cross.status, 400, JSON.stringify(cross.body));
    assert.strictEqual(cross.body['error_code'], 'COST_ROLLUP_COMPARE_INVALID');

    const self = await makeRequest(
      port,
      'GET',
      `/api/v1/bom-cost-rollups/compare?base=${mine.body['rollup_id'] as string}&compare=${mine.body['rollup_id'] as string}`,
      undefined,
      readerHeaders,
    );
    assert.strictEqual(self.status, 400, JSON.stringify(self.body));
    assert.strictEqual(self.body['error_code'], 'COST_ROLLUP_COMPARE_INVALID');

    const missing = await makeRequest(
      port,
      'GET',
      `/api/v1/bom-cost-rollups/compare?base=${randomUUID()}&compare=${mine.body['rollup_id'] as string}`,
      undefined,
      readerHeaders,
    );
    assert.strictEqual(missing.status, 404, JSON.stringify(missing.body));
    assert.strictEqual(missing.body['error_code'], 'COST_ROLLUP_NOT_FOUND');
  });

  it('compares snapshots taken against two DIFFERENT revisions of the same BOM (FR-B-15 "across versions")', async () => {
    const componentId = await createItem(`B56-REV-C-${run}`, { standard_cost_amount: 2 });
    const parentId = await createItem(`B56-REV-P-${run}`);
    const { bomId } = await draftAndRelease(parentId, [componentLine(1, componentId)]);
    const firstRevisionRollup = await runRollup(bomId);
    assert.strictEqual(firstRevisionRollup.status, 201, JSON.stringify(firstRevisionRollup.body));

    // A second revision arrives through an ECO; the rollup taken against it belongs to the same
    // BOM but a different revision, which the comparison must accept.
    const second = await getPool().query(
      `INSERT INTO bom_revision (revision_id, bom_id, revision_code, revision_status, drafted_by, drafted_at, source_event_id)
       SELECT gen_random_uuid(), bom_id, 'B', 'draft', drafted_by, now(), source_event_id
         FROM bom_revision WHERE bom_id = $1 LIMIT 1 RETURNING revision_id`,
      [bomId],
    );
    const newRevisionId = second.rows[0]!.revision_id as string;
    await getPool().query(
      `INSERT INTO bom_line (bom_line_id, revision_id, bom_id, line_no, component_item_id, component_sku, output_class, quantity_per, line_uom, uom_conversion_factor, base_quantity_per, scrap_percent, is_phantom, effective_from, source_event_id)
       SELECT gen_random_uuid(), $2, bom_id, line_no, component_item_id, component_sku, output_class, quantity_per, line_uom, uom_conversion_factor, base_quantity_per, scrap_percent, is_phantom, effective_from, source_event_id
         FROM bom_line WHERE revision_id = (SELECT current_revision_id FROM bom WHERE bom_id = $1)`,
      [bomId, newRevisionId],
    );
    await getPool().query('UPDATE bom SET current_revision_id = $2 WHERE bom_id = $1', [
      bomId,
      newRevisionId,
    ]);

    const secondRevisionRollup = await runRollup(bomId);
    assert.strictEqual(secondRevisionRollup.status, 201, JSON.stringify(secondRevisionRollup.body));
    assert.notStrictEqual(
      secondRevisionRollup.body['revision_id'],
      firstRevisionRollup.body['revision_id'],
    );

    const res = await makeRequest(
      port,
      'GET',
      `/api/v1/bom-cost-rollups/compare?base=${firstRevisionRollup.body['rollup_id'] as string}&compare=${secondRevisionRollup.body['rollup_id'] as string}`,
      undefined,
      readerHeaders,
    );
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    await assertNumericEqual(res.body['total_delta'], '0', 'identical structure, zero delta');
  });

  // -------------------------------------------------------------------------
  // AC 3: the completed-cost-rollup release gate
  // -------------------------------------------------------------------------

  it('blocks release with RELEASE_GATE_UNMET until a COMPLETE and FRESH rollup exists', async () => {
    const rated = await createItem(`B56-GATE-C-${run}`, { standard_cost_amount: 4 });
    const unratedSku = `B56-GATE-U-${run}`;
    const unrated = await createItem(unratedSku, {
      standard_cost_designation: null,
      standard_cost_amount: null,
    });
    const parentId = await createItem(`B56-GATE-P-${run}`);
    const draft = await draftBom(parentId, [componentLine(1, rated), componentLine(2, unrated)]);
    const bomId = draft.body['bom_id'] as string;
    const revisionId = draft.body['current_revision_id'] as string;

    // (a) no snapshot at all
    const noRollup = await releaseBom(bomId);
    assert.strictEqual(noRollup.status, 409, JSON.stringify(noRollup.body));
    assert.strictEqual(noRollup.body['error_code'], 'RELEASE_GATE_UNMET');
    let details = noRollup.body['details'] as Record<string, unknown>;
    assert.ok(
      (details['unmet_conditions'] as string[]).includes('cost_rollup_complete'),
      JSON.stringify(details),
    );
    assert.deepStrictEqual(details['cost_rollup_complete'], {
      rollup_id: null,
      missing_rate_count: null,
      stale: false,
    });

    // (b) an INCOMPLETE snapshot is a valid simulation but does not satisfy the gate
    const incomplete = await runRollup(bomId);
    assert.strictEqual(incomplete.status, 201, JSON.stringify(incomplete.body));
    assert.strictEqual(incomplete.body['missing_rate_count'], 1);
    const stillBlocked = await releaseBom(bomId);
    assert.strictEqual(stillBlocked.status, 409, JSON.stringify(stillBlocked.body));
    details = stillBlocked.body['details'] as Record<string, unknown>;
    assert.ok((details['unmet_conditions'] as string[]).includes('cost_rollup_complete'));
    assert.strictEqual(
      (details['cost_rollup_complete'] as Record<string, unknown>)['missing_rate_count'],
      1,
    );

    // The checklist agrees with the gate, and reports the condition as ENFORCED.
    const blockedChecklist = await makeRequest(
      port,
      'GET',
      `/api/v1/boms/${bomId}/release-gate`,
      undefined,
      readerHeaders,
    );
    assert.strictEqual(blockedChecklist.status, 200, JSON.stringify(blockedChecklist.body));
    const blockedCondition = (
      blockedChecklist.body['conditions'] as Record<string, unknown>[]
    ).find((c) => c['condition'] === 'cost_rollup_complete');
    assert.deepStrictEqual(blockedCondition, {
      condition: 'cost_rollup_complete',
      met: false,
      enforced: true,
      blocking_lines: [],
    });
    assert.strictEqual(blockedChecklist.body['ready_to_release'], false);

    // (c) give the unrated component a rate and re-run: the gate opens
    const rate = await makeRequest(
      port,
      'PATCH',
      `/api/v1/items/${unratedSku}`,
      {
        standard_cost_designation: 'ind_as_2_para_21_measurement_technique',
        standard_cost_amount: 9,
      },
      engineerHeaders,
    );
    assert.strictEqual(rate.status, 200, JSON.stringify(rate.body));
    const complete = await runRollup(bomId);
    assert.strictEqual(complete.body['missing_rate_count'], 0);

    const okChecklist = await makeRequest(
      port,
      'GET',
      `/api/v1/boms/${bomId}/release-gate`,
      undefined,
      readerHeaders,
    );
    const okCondition = (okChecklist.body['conditions'] as Record<string, unknown>[]).find(
      (c) => c['condition'] === 'cost_rollup_complete',
    );
    assert.strictEqual((okCondition as Record<string, unknown>)['met'], true);
    assert.strictEqual(okChecklist.body['ready_to_release'], true);

    const released = await releaseBom(bomId);
    assert.strictEqual(released.status, 200, JSON.stringify(released.body));
    assert.strictEqual(released.body['status'], 'released');
    assert.ok(revisionId);
  });

  it('invalidates a complete rollup when a line changes afterwards, and reports stale: true', async () => {
    const componentId = await createItem(`B56-STALE-C-${run}`, { standard_cost_amount: 4 });
    const extraId = await createItem(`B56-STALE-X-${run}`, { standard_cost_amount: 4 });
    const parentId = await createItem(`B56-STALE-P-${run}`);
    const draft = await draftBom(parentId, [componentLine(1, componentId)]);
    const bomId = draft.body['bom_id'] as string;

    const first = await runRollup(bomId);
    assert.strictEqual(first.body['missing_rate_count'], 0);

    // A line added after the rollup invalidates it: the costed structure no longer matches.
    const added = await makeRequest(
      port,
      'POST',
      `/api/v1/boms/${bomId}/lines`,
      { ...componentLine(2, extraId), idempotency_key: randomUUID() },
      engineerHeaders,
    );
    assert.strictEqual(added.status, 200, JSON.stringify(added.body));

    const blocked = await releaseBom(bomId);
    assert.strictEqual(blocked.status, 409, JSON.stringify(blocked.body));
    const details = blocked.body['details'] as Record<string, unknown>;
    assert.ok((details['unmet_conditions'] as string[]).includes('cost_rollup_complete'));
    const costDetail = details['cost_rollup_complete'] as Record<string, unknown>;
    assert.strictEqual(costDetail['stale'], true, JSON.stringify(costDetail));
    assert.strictEqual(costDetail['rollup_id'], first.body['rollup_id']);

    const fresh = await runRollup(bomId);
    assert.strictEqual(fresh.status, 201, JSON.stringify(fresh.body));
    const released = await releaseBom(bomId);
    assert.strictEqual(released.status, 200, JSON.stringify(released.body));
  });

  it('invalidates a complete rollup when a line is AMENDED afterwards, and reports stale: true', async () => {
    const componentId = await createItem(`B56-STALE-AM-C-${run}`, { standard_cost_amount: 4 });
    const parentId = await createItem(`B56-STALE-AM-P-${run}`);
    const draft = await draftBom(parentId, [componentLine(1, componentId)]);
    const bomId = draft.body['bom_id'] as string;
    const revisionId = draft.body['current_revision_id'] as string;

    const first = await runRollup(bomId);
    assert.strictEqual(first.status, 201, JSON.stringify(first.body));
    assert.strictEqual(first.body['missing_rate_count'], 0);

    // Amending a line (not adding one) bumps bom_line.updated_at and invalidates the rollup.
    const lineId = (await lineIdsByLineNo(revisionId))[1]!;
    const amended = await makeRequest(
      port,
      'PATCH',
      `/api/v1/boms/${bomId}/lines/${lineId}`,
      { quantity_per: '3.5', idempotency_key: randomUUID() },
      engineerHeaders,
    );
    assert.strictEqual(amended.status, 200, JSON.stringify(amended.body));

    const blocked = await releaseBom(bomId);
    assert.strictEqual(blocked.status, 409, JSON.stringify(blocked.body));
    const details = blocked.body['details'] as Record<string, unknown>;
    assert.ok((details['unmet_conditions'] as string[]).includes('cost_rollup_complete'));
    const costDetail = details['cost_rollup_complete'] as Record<string, unknown>;
    assert.strictEqual(costDetail['stale'], true, JSON.stringify(costDetail));

    const fresh = await runRollup(bomId);
    assert.strictEqual(fresh.status, 201, JSON.stringify(fresh.body));
    const released = await releaseBom(bomId);
    assert.strictEqual(released.status, 200, JSON.stringify(released.body));
  });

  it('still skips the full gate on an on_hold reinstatement (existing behaviour must not regress)', async () => {
    const componentId = await createItem(`B56-HOLD-C-${run}`, { standard_cost_amount: 4 });
    const parentId = await createItem(`B56-HOLD-P-${run}`);
    const { bomId } = await draftAndRelease(parentId, [componentLine(1, componentId)]);

    const held = await makeRequest(
      port,
      'POST',
      `/api/v1/boms/${bomId}/hold`,
      { idempotency_key: randomUUID() },
      engineerHeaders,
    );
    assert.strictEqual(held.status, 200, JSON.stringify(held.body));

    // The revision is immutable and already passed the gate, so reinstatement needs no new rollup
    // even though the earlier snapshot is now older than the release-time blocking-flag writes.
    const reinstated = await releaseBom(bomId);
    assert.strictEqual(reinstated.status, 200, JSON.stringify(reinstated.body));
    assert.strictEqual(reinstated.body['status'], 'released');
  });

  // -------------------------------------------------------------------------
  // AC 4: job-work kit supply-source tagging
  // -------------------------------------------------------------------------

  it('tags every kit BOM line by supply source and surfaces it on the line read model', async () => {
    const a = await createItem(`B56-KIT-A-${run}`, { standard_cost_amount: 1 });
    const b = await createItem(`B56-KIT-B-${run}`, { standard_cost_amount: 1 });
    const c = await createItem(`B56-KIT-C-${run}`, { standard_cost_amount: 1 });
    const parentId = await createItem(`B56-KIT-P-${run}`);
    const draft = await draftBom(
      parentId,
      [componentLine(1, a), componentLine(2, b), componentLine(3, c)],
      'job_work_kit',
    );
    assert.strictEqual(draft.status, 201, JSON.stringify(draft.body));
    const bomId = draft.body['bom_id'] as string;
    const revisionId = draft.body['current_revision_id'] as string;
    const lineIds = await lineIdsByLineNo(revisionId);

    const res = await makeRequest(
      port,
      'POST',
      `/api/v1/boms/${bomId}/job-work-kit-tags`,
      {
        tags: [
          { bom_line_id: lineIds[1]!, supply_source: 'company' },
          { bom_line_id: lineIds[2]!, supply_source: 'customer' },
          { bom_line_id: lineIds[3]!, supply_source: 'job_worker' },
        ],
        idempotency_key: randomUUID(),
      },
      engineerHeaders,
    );
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    const returned = res.body['lines'] as { line_no: number; supply_source: string | null }[];
    assert.deepStrictEqual(
      returned.map((l) => l.supply_source),
      ['company', 'customer', 'job_worker'],
    );

    const durable = await getPool().query(
      'SELECT line_no, supply_source FROM bom_line WHERE revision_id = $1 ORDER BY line_no',
      [revisionId],
    );
    assert.deepStrictEqual(
      durable.rows.map((r) => (r as { supply_source: string }).supply_source),
      ['company', 'customer', 'job_worker'],
    );
  });

  it('rejects an out-of-vocabulary supply_source, an unknown line, and tagging a production BOM', async () => {
    const componentId = await createItem(`B56-KITV-C-${run}`, { standard_cost_amount: 1 });
    const kitParent = await createItem(`B56-KITV-P-${run}`);
    const kitDraft = await draftBom(kitParent, [componentLine(1, componentId)], 'job_work_kit');
    const kitBomId = kitDraft.body['bom_id'] as string;
    const kitLines = await lineIdsByLineNo(kitDraft.body['current_revision_id'] as string);

    const badVocabulary = await makeRequest(
      port,
      'POST',
      `/api/v1/boms/${kitBomId}/job-work-kit-tags`,
      {
        tags: [{ bom_line_id: kitLines[1]!, supply_source: 'supplier' }],
        idempotency_key: randomUUID(),
      },
      engineerHeaders,
    );
    assert.strictEqual(badVocabulary.status, 400, JSON.stringify(badVocabulary.body));
    assert.strictEqual(badVocabulary.body['error_code'], 'INVALID_PARAMS');

    const unknownLine = await makeRequest(
      port,
      'POST',
      `/api/v1/boms/${kitBomId}/job-work-kit-tags`,
      {
        tags: [{ bom_line_id: randomUUID(), supply_source: 'company' }],
        idempotency_key: randomUUID(),
      },
      engineerHeaders,
    );
    assert.strictEqual(unknownLine.status, 404, JSON.stringify(unknownLine.body));
    assert.strictEqual(unknownLine.body['error_code'], 'BOM_LINE_NOT_FOUND');

    const productionLines = await lineIdsByLineNo(fx.parentRevisionId);
    const notAKit = await makeRequest(
      port,
      'POST',
      `/api/v1/boms/${fx.parentBomId}/job-work-kit-tags`,
      {
        tags: [{ bom_line_id: productionLines[1]!, supply_source: 'company' }],
        idempotency_key: randomUUID(),
      },
      engineerHeaders,
    );
    assert.strictEqual(notAKit.status, 409, JSON.stringify(notAKit.body));
    assert.strictEqual(notAKit.body['error_code'], 'BOM_NOT_JOB_WORK_KIT');
  });

  it('blocks a kit BOM release while any component line is untagged, and leaves production BOMs unaffected', async () => {
    const a = await createItem(`B56-KITR-A-${run}`, { standard_cost_amount: 1 });
    const b = await createItem(`B56-KITR-B-${run}`, { standard_cost_amount: 1 });
    const parentId = await createItem(`B56-KITR-P-${run}`);
    const draft = await draftBom(
      parentId,
      [componentLine(1, a), componentLine(2, b)],
      'job_work_kit',
    );
    const bomId = draft.body['bom_id'] as string;
    const lineIds = await lineIdsByLineNo(draft.body['current_revision_id'] as string);

    // Partial tagging is a legitimate authoring step and is accepted at tag time...
    const partial = await makeRequest(
      port,
      'POST',
      `/api/v1/boms/${bomId}/job-work-kit-tags`,
      {
        tags: [{ bom_line_id: lineIds[1]!, supply_source: 'customer' }],
        idempotency_key: randomUUID(),
      },
      engineerHeaders,
    );
    assert.strictEqual(partial.status, 201, JSON.stringify(partial.body));

    // ...and rejected at RELEASE, which is the enforcement point for AC 4.
    await runRollup(bomId);
    const blocked = await releaseBom(bomId);
    assert.strictEqual(blocked.status, 409, JSON.stringify(blocked.body));
    assert.strictEqual(blocked.body['error_code'], 'RELEASE_GATE_UNMET');
    const details = blocked.body['details'] as Record<string, unknown>;
    assert.ok(
      (details['unmet_conditions'] as string[]).includes('supply_source_missing'),
      JSON.stringify(details),
    );
    const blockingLines = (details['supply_source_missing'] as Record<string, unknown>)[
      'blocking_lines'
    ] as { bom_line_id: string }[];
    assert.deepStrictEqual(
      blockingLines.map((l) => l.bom_line_id),
      [lineIds[2]!],
    );

    // Tag the remaining line and the kit releases.
    const rest = await makeRequest(
      port,
      'POST',
      `/api/v1/boms/${bomId}/job-work-kit-tags`,
      {
        tags: [{ bom_line_id: lineIds[2]!, supply_source: 'job_worker' }],
        idempotency_key: randomUUID(),
      },
      engineerHeaders,
    );
    assert.strictEqual(rest.status, 201, JSON.stringify(rest.body));
    await runRollup(bomId);
    const released = await releaseBom(bomId);
    assert.strictEqual(released.status, 200, JSON.stringify(released.body));

    // A production BOM is untouched by the kit-only condition (no supply_source anywhere).
    const prodComponent = await createItem(`B56-PRODR-C-${run}`, { standard_cost_amount: 1 });
    const prodParent = await createItem(`B56-PRODR-P-${run}`);
    const prod = await draftAndRelease(prodParent, [componentLine(1, prodComponent)]);
    assert.ok(prod.bomId);
  });

  it('rejects tagging on a Released kit revision with IMMUTABLE_REVISION', async () => {
    const a = await createItem(`B56-KITI-A-${run}`, { standard_cost_amount: 1 });
    const parentId = await createItem(`B56-KITI-P-${run}`);
    const draft = await draftBom(parentId, [componentLine(1, a)], 'job_work_kit');
    const bomId = draft.body['bom_id'] as string;
    const lineIds = await lineIdsByLineNo(draft.body['current_revision_id'] as string);
    await makeRequest(
      port,
      'POST',
      `/api/v1/boms/${bomId}/job-work-kit-tags`,
      {
        tags: [{ bom_line_id: lineIds[1]!, supply_source: 'company' }],
        idempotency_key: randomUUID(),
      },
      engineerHeaders,
    );
    await runRollup(bomId);
    assert.strictEqual((await releaseBom(bomId)).status, 200);

    const retag = await makeRequest(
      port,
      'POST',
      `/api/v1/boms/${bomId}/job-work-kit-tags`,
      {
        tags: [{ bom_line_id: lineIds[1]!, supply_source: 'customer' }],
        idempotency_key: randomUUID(),
      },
      engineerHeaders,
    );
    assert.strictEqual(retag.status, 409, JSON.stringify(retag.body));
    assert.strictEqual(retag.body['error_code'], 'IMMUTABLE_REVISION');
  });

  // -------------------------------------------------------------------------
  // AC 5: outbound publication and unconditional inbound rejection
  // -------------------------------------------------------------------------

  it('records exactly one outbound message when a production BOM releases, and none for a kit BOM', async () => {
    const componentId = await createItem(`B56-OUT-C-${run}`, { standard_cost_amount: 3 });
    const parentId = await createItem(`B56-OUT-P-${run}`);
    const { bomId, revisionId } = await draftAndRelease(parentId, [componentLine(1, componentId)]);

    const messages = await getPool().query(
      'SELECT message_id, bom_id, revision_id, payload FROM bom_outbound_message WHERE bom_id = $1',
      [bomId],
    );
    assert.strictEqual(messages.rows.length, 1, JSON.stringify(messages.rows));
    const row = messages.rows[0] as { revision_id: string; payload: Record<string, unknown> };
    assert.strictEqual(row.revision_id, revisionId);
    assert.strictEqual(row.payload['bom_type'], 'production');
    assert.strictEqual(row.payload['lifecycle_state'], 'released');
    assert.strictEqual(row.payload['revision_status'], 'released');
    const payloadLines = row.payload['lines'] as Record<string, unknown>[];
    assert.strictEqual(payloadLines.length, 1);
    const line = payloadLines[0]!;
    assert.strictEqual(line['line_no'], 1);
    assert.strictEqual(typeof line['quantity_per'], 'string');
    assert.strictEqual(line['component_sku'], `B56-OUT-C-${run}`);
    assert.strictEqual(line['supply_method'], 'directed_issue');
    assert.strictEqual(line['supply_source'], null);
    assert.strictEqual(line['effective_from'], '2020-01-01');
    assert.strictEqual(line['effective_to'], null);

    // A kit release is internal to job work and publishes nothing.
    const kitComponent = await createItem(`B56-OUTK-C-${run}`, { standard_cost_amount: 1 });
    const kitParent = await createItem(`B56-OUTK-P-${run}`);
    const kitDraft = await draftBom(kitParent, [componentLine(1, kitComponent)], 'job_work_kit');
    const kitBomId = kitDraft.body['bom_id'] as string;
    const kitLines = await lineIdsByLineNo(kitDraft.body['current_revision_id'] as string);
    await makeRequest(
      port,
      'POST',
      `/api/v1/boms/${kitBomId}/job-work-kit-tags`,
      {
        tags: [{ bom_line_id: kitLines[1]!, supply_source: 'company' }],
        idempotency_key: randomUUID(),
      },
      engineerHeaders,
    );
    await runRollup(kitBomId);
    assert.strictEqual((await releaseBom(kitBomId)).status, 200);
    const kitMessages = await getPool().query(
      'SELECT 1 FROM bom_outbound_message WHERE bom_id = $1',
      [kitBomId],
    );
    assert.strictEqual(kitMessages.rows.length, 0, 'a job_work_kit release publishes nothing');
  });

  it('rejects an inbound BOM record for an EXISTING BOM without mutating bom, bom_revision or bom_line', async () => {
    const before = await bomFamilySnapshot();
    const res = await postErpSync({
      boms: [
        {
          bom_ref: fx.parentBomId,
          parent_sku: 'ERP-CLAIMED-PARENT',
          lines: [{ line_no: 1, sku: 'ERP-CLAIMED-COMPONENT', quantity_per: '99' }],
        },
      ],
    });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    const boms = res.body['boms'] as { applied: number; failed: number };
    assert.strictEqual(boms.applied, 0);
    assert.strictEqual(boms.failed, 1);

    const exceptions = await openBomExceptions();
    const found = exceptions.find((e) => e['source_record_ref'] === fx.parentBomId);
    assert.ok(found, `no exception queued: ${JSON.stringify(exceptions)}`);
    assert.strictEqual(found['error_code'], 'BOM_INBOUND_SYNC_REJECTED');
    assert.strictEqual(found['status'], 'open');
    const snapshot = (found['details'] as Record<string, unknown>)['source_snapshot'] as Record<
      string,
      unknown
    >;
    assert.strictEqual(snapshot['parent_sku'], 'ERP-CLAIMED-PARENT');

    assert.strictEqual(
      await bomFamilySnapshot(),
      before,
      'the BOM family must be byte-identical after an inbound sync',
    );
  });

  it('rejects an inbound record naming an UNKNOWN BOM with a null bom_id and creates no BOM rows', async () => {
    const before = await bomFamilySnapshot();
    const ref = `ERP-UNKNOWN-${run}`;
    const res = await postErpSync({ boms: [{ bom_ref: ref, parent_sku: 'GHOST' }] });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    const rejected = (res.body['boms'] as Record<string, unknown>)['rejected'] as Record<
      string,
      unknown
    >[];
    assert.strictEqual(rejected.length, 1);
    assert.strictEqual(rejected[0]!['bom_id'], null);

    const exceptions = await openBomExceptions();
    assert.ok(exceptions.some((e) => e['source_record_ref'] === ref));
    assert.strictEqual(await bomFamilySnapshot(), before);
  });

  it('dedupes a poll storm: three identical batches leave ONE open exception and ONE conflict event', async () => {
    const ref = `ERP-STORM-${run}`;
    const batch = { boms: [{ bom_ref: ref, parent_sku: 'STORM' }] };

    const first = await postErpSync(batch);
    assert.strictEqual(first.status, 200, JSON.stringify(first.body));
    const firstRaisedAt = (await openBomExceptions()).find((e) => e['source_record_ref'] === ref)![
      'raised_at'
    ] as Date;

    await postErpSync(batch);
    await postErpSync(batch);

    const open = (await openBomExceptions()).filter((e) => e['source_record_ref'] === ref);
    assert.strictEqual(open.length, 1, `exactly one open row survives: ${JSON.stringify(open)}`);
    assert.ok(
      new Date(open[0]!['raised_at'] as Date).getTime() > new Date(firstRaisedAt).getTime(),
      'the surviving row is refreshed, not stacked',
    );
    assert.strictEqual(
      await syncConflictEventCount(ref),
      1,
      'a re-sent unresolved conflict must not emit a second event',
    );
  });

  it('re-raises after resolution: a recurring conflict opens a NEW exception and emits a SECOND event', async () => {
    const ref = `ERP-REOPEN-${run}`;
    const batch = { boms: [{ bom_ref: ref, parent_sku: 'REOPEN' }] };
    await postErpSync(batch);

    const open = (await openBomExceptions()).find((e) => e['source_record_ref'] === ref)!;
    const exceptionId = open['exception_id'] as string;

    const listed = await makeRequest(
      port,
      'GET',
      '/api/v1/erp/bom-sync-exceptions?status=open',
      undefined,
      readerHeaders,
    );
    assert.strictEqual(listed.status, 200, JSON.stringify(listed.body));
    assert.ok(
      (listed.body['exceptions'] as Record<string, unknown>[]).some(
        (e) => e['exception_id'] === exceptionId,
      ),
      'the queue route lists the open row',
    );

    const resolved = await makeRequest(
      port,
      'POST',
      `/api/v1/erp/bom-sync-exceptions/${exceptionId}/resolve`,
      {},
      engineerHeaders,
    );
    assert.strictEqual(resolved.status, 200, JSON.stringify(resolved.body));
    const afterResolve = await getPool().query(
      'SELECT status FROM integration_exception WHERE exception_id = $1',
      [exceptionId],
    );
    assert.strictEqual(afterResolve.rows[0]!.status, 'resolved');

    // The partial unique index is WHERE status = 'open', so the resolved row does not block a
    // fresh one - and the RANDOM idempotency key lets the audit event fire again.
    await postErpSync(batch);
    const reopened = (await openBomExceptions()).filter((e) => e['source_record_ref'] === ref);
    assert.strictEqual(reopened.length, 1);
    assert.notStrictEqual(reopened[0]!['exception_id'], exceptionId, 'a NEW open row was created');
    assert.strictEqual(
      await syncConflictEventCount(ref),
      2,
      'a post-resolution recurrence must emit a second event',
    );
  });

  // -------------------------------------------------------------------------
  // Platform gates: direct-event rejection, RBAC, idempotent replay
  // -------------------------------------------------------------------------

  it('rejects a WELL-FORMED direct POST /api/v1/events for each new engineering event type', async () => {
    for (const eventType of [
      'bom.cost_rollup_snapshotted',
      'bom.job_work_kit_tagged',
      'bom.sync_conflict_raised',
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

  it('denies every new route to a user outside the engineering module', async () => {
    const cases: [string, string, unknown][] = [
      ['POST', `/api/v1/boms/${fx.parentBomId}/cost-rollups`, {}],
      ['GET', `/api/v1/boms/${fx.parentBomId}/cost-rollups`, undefined],
      [
        'GET',
        `/api/v1/bom-cost-rollups/compare?base=${randomUUID()}&compare=${randomUUID()}`,
        undefined,
      ],
      ['GET', `/api/v1/bom-cost-rollups/${randomUUID()}`, undefined],
      [
        'POST',
        `/api/v1/boms/${fx.parentBomId}/job-work-kit-tags`,
        { tags: [{ bom_line_id: fx.lines[1]!, supply_source: 'company' }] },
      ],
      ['GET', '/api/v1/erp/bom-sync-exceptions', undefined],
      ['POST', `/api/v1/erp/bom-sync-exceptions/${randomUUID()}/resolve`, {}],
    ];
    for (const [method, path, body] of cases) {
      const res = await makeRequest(port, method, path, body, noRoleHeaders);
      assert.strictEqual(res.status, 403, `${method} ${path}: ${JSON.stringify(res.body)}`);
      assert.strictEqual(res.body['error_code'], 'MODULE_ACCESS_DENIED', `${method} ${path}`);
    }

    // A read-only engineer may read but not mutate.
    const write = await makeRequest(
      port,
      'POST',
      `/api/v1/boms/${fx.parentBomId}/cost-rollups`,
      {},
      readerHeaders,
    );
    assert.strictEqual(write.status, 403, JSON.stringify(write.body));
    assert.strictEqual(write.body['error_code'], 'FUNCTION_ACCESS_DENIED');
  });

  it('returns the ORIGINAL snapshot on an idempotent replay and persists exactly one rollup row', async () => {
    const componentId = await createItem(`B56-IDEM-C-${run}`, { standard_cost_amount: 2 });
    const parentId = await createItem(`B56-IDEM-P-${run}`);
    const draft = await draftBom(parentId, [componentLine(1, componentId)]);
    const bomId = draft.body['bom_id'] as string;
    const key = randomUUID();

    const first = await makeRequest(
      port,
      'POST',
      `/api/v1/boms/${bomId}/cost-rollups`,
      { idempotency_key: key },
      engineerHeaders,
    );
    assert.strictEqual(first.status, 201, JSON.stringify(first.body));
    const second = await makeRequest(
      port,
      'POST',
      `/api/v1/boms/${bomId}/cost-rollups`,
      { idempotency_key: key },
      engineerHeaders,
    );
    assert.strictEqual(second.status, 201, JSON.stringify(second.body));
    assert.deepStrictEqual(second.body, first.body, 'the replay returns the original snapshot');

    const rows = await getPool().query(
      'SELECT COUNT(*)::int AS cnt FROM bom_cost_rollup WHERE bom_id = $1',
      [bomId],
    );
    assert.strictEqual(rows.rows[0]!.cnt, 1, 'a replay persists no second snapshot');
  });

  it('404s an unknown rollup id and 404s a rollup against an unknown BOM', async () => {
    const missing = await makeRequest(
      port,
      'GET',
      `/api/v1/bom-cost-rollups/${randomUUID()}`,
      undefined,
      readerHeaders,
    );
    assert.strictEqual(missing.status, 404, JSON.stringify(missing.body));
    assert.strictEqual(missing.body['error_code'], 'COST_ROLLUP_NOT_FOUND');

    const unknownBom = await runRollup(randomUUID());
    assert.strictEqual(unknownBom.status, 404, JSON.stringify(unknownBom.body));
    assert.strictEqual(unknownBom.body['error_code'], 'BOM_NOT_FOUND');
  });

  it('bars a rollup against an R&D draft BOM with RD_EXECUTION_BARRED', async () => {
    const componentId = await createItem(`B56-RD-C-${run}`, { standard_cost_amount: 1 });
    const parentId = await createItem(`B56-RD-P-${run}`);
    const draft = await draftBom(parentId, [componentLine(1, componentId)], 'rnd');
    assert.strictEqual(draft.status, 201, JSON.stringify(draft.body));

    const res = await runRollup(draft.body['bom_id'] as string);
    assert.strictEqual(res.status, 409, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'RD_EXECUTION_BARRED');
  });
});
