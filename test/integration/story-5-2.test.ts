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

describe('Story 5.2 BOM Lifecycle and Immutability Integration Tests', () => {
  let server: Server;
  let port: number;
  let engineerHeaders: Record<string, string>;
  let readerHeaders: Record<string, string>;

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

  async function deactivateItem(sku: string): Promise<void> {
    const res = await makeRequest(
      port,
      'PATCH',
      `/api/v1/items/${sku}`,
      { status: 'inactive' },
      engineerHeaders,
    );
    assert.strictEqual(res.status, 200, `deactivate ${sku} failed: ${JSON.stringify(res.body)}`);
  }

  interface DraftOptions {
    scrapPercent?: string | undefined;
  }

  async function draftBom(
    parentItemId: string,
    componentItemIds: string[],
    options: DraftOptions = {},
  ): Promise<Record<string, unknown>> {
    const res = await makeRequest(
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
    assert.strictEqual(res.status, 201, `draft failed: ${JSON.stringify(res.body)}`);
    return res.body;
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

    const scimHeaders = {
      Authorization: 'Bearer test-only-scim-bearer-token-not-for-production-use',
    };
    const engineerRes = await makeRequest(
      port,
      'POST',
      '/api/v1/scim/v2/Users',
      {
        externalId: `engineer52-${run}@test.com`,
        email: `engineer52-${run}@test.com`,
        displayName: `Engineer52 ${run}`,
        roles: [
          {
            role: 'engineering_admin',
            module: 'engineering',
            functionScope: 'write',
            locationId: '*',
          },
          {
            role: 'inventory_controller',
            module: 'inventory',
            functionScope: 'write',
            locationId: '*',
          },
        ],
      },
      scimHeaders,
    );
    assert.strictEqual(engineerRes.status, 201, JSON.stringify(engineerRes.body));

    const readerRes = await makeRequest(
      port,
      'POST',
      '/api/v1/scim/v2/Users',
      {
        externalId: `reader52-${run}@test.com`,
        email: `reader52-${run}@test.com`,
        displayName: `Reader52 ${run}`,
        roles: [
          { role: 'bom_viewer', module: 'engineering', functionScope: 'read', locationId: '*' },
        ],
      },
      scimHeaders,
    );
    assert.strictEqual(readerRes.status, 201, JSON.stringify(readerRes.body));

    engineerHeaders = await authFor(port, `engineer52-${run}@test.com`);
    readerHeaders = await authFor(port, `reader52-${run}@test.com`);
  });

  after(async () => {
    server.close();
    const admin = await getAdminPool().connect();
    try {
      await admin.query(
        'TRUNCATE TABLE bom_line, bom_revision, bom_structure, bom RESTART IDENTITY CASCADE',
      );
    } finally {
      admin.release();
    }
    await closePool();
    await closeAdminPool();
  });

  it('releases a clean draft BOM and writes an audit entry', async () => {
    const parentId = await createItem(`R1-PARENT-${run}`, { category: 'finished_goods' });
    const componentId = await createItem(`R1-COMP-${run}`);
    const bom = await draftBom(parentId, [componentId]);
    const bomId = bom['bom_id'] as string;

    const releaseRes = await makeRequest(
      port,
      'POST',
      `/api/v1/boms/${bomId}/release`,
      { idempotency_key: randomUUID() },
      engineerHeaders,
    );
    assert.strictEqual(releaseRes.status, 200, JSON.stringify(releaseRes.body));
    assert.strictEqual(releaseRes.body['status'], 'released');
    assert.ok(releaseRes.body['status_changed_at'], 'status_changed_at should be set');
    assert.ok(releaseRes.body['status_changed_by'], 'status_changed_by should be set');

    const pool = getPool();
    const audit = await pool.query(
      `SELECT 1 FROM audit_log WHERE endpoint = $1 AND http_status = 200 LIMIT 1`,
      [`/api/v1/boms/${bomId}/release`],
    );
    assert.ok(audit.rows.length > 0, 'release should write an audit entry');

    const revisions = await pool.query(
      `SELECT revision_status, released_at, released_by FROM bom_revision WHERE bom_id = $1`,
      [bomId],
    );
    assert.strictEqual(revisions.rows[0]!.revision_status, 'released');
    assert.ok(revisions.rows[0]!.released_at, 'released_at should be set');
  });

  it('blocks release when scrap percent is missing and names the condition', async () => {
    const parentId = await createItem(`R2-PARENT-${run}`, { category: 'finished_goods' });
    const componentId = await createItem(`R2-COMP-${run}`);
    const bom = await draftBom(parentId, [componentId], { scrapPercent: undefined });
    const bomId = bom['bom_id'] as string;

    const releaseRes = await makeRequest(
      port,
      'POST',
      `/api/v1/boms/${bomId}/release`,
      {},
      engineerHeaders,
    );
    assert.strictEqual(releaseRes.status, 409, JSON.stringify(releaseRes.body));
    assert.strictEqual(releaseRes.body['error_code'], 'RELEASE_GATE_UNMET');
    const details = releaseRes.body['details'] as Record<string, unknown>;
    assert.ok(
      (details['unmet_conditions'] as string[]).includes('scrap_percent_missing'),
      `unmet_conditions should name scrap_percent_missing: ${JSON.stringify(details)}`,
    );
    const scrapLines =
      ((details['scrap_percent_missing'] as Record<string, unknown>)['lines'] as Record<
        string,
        unknown
      >[]) ?? [];
    assert.ok(
      scrapLines.length > 0,
      'scrap_percent_missing.lines should list the offending line: ' + JSON.stringify(details),
    );
    assert.ok(
      scrapLines.every((l) => l['condition'] === 'scrap_percent_missing' || l['bom_line_id']),
      'scrap lines should carry bom_line_id: ' + JSON.stringify(details),
    );
    const staged = details['staged_conditions'] as Record<string, unknown>[];
    assert.ok(
      staged.some((c) => c['condition'] === 'approved_eco' && c['enforced'] === false),
      'staged_conditions should list approved_eco with enforced false',
    );
    assert.ok(
      staged.some((c) => c['condition'] === 'cost_rollup_complete' && c['enforced'] === false),
      'staged_conditions should list cost_rollup_complete with enforced false',
    );
  });

  it('blocks release when a component was deactivated after its line was added', async () => {
    const parentId = await createItem(`R3-PARENT-${run}`, { category: 'finished_goods' });
    const componentSku = `R3-COMP-${run}`;
    const componentId = await createItem(componentSku);
    const bom = await draftBom(parentId, [componentId]);
    const bomId = bom['bom_id'] as string;
    assert.strictEqual(bom['blocking_line_count'], 0, 'line was added while item was active');

    await deactivateItem(componentSku);

    const releaseRes = await makeRequest(
      port,
      'POST',
      `/api/v1/boms/${bomId}/release`,
      {},
      engineerHeaders,
    );
    assert.strictEqual(releaseRes.status, 409, JSON.stringify(releaseRes.body));
    assert.strictEqual(releaseRes.body['error_code'], 'RELEASE_GATE_UNMET');
    const details = releaseRes.body['details'] as Record<string, unknown>;
    assert.ok(
      (details['unmet_conditions'] as string[]).includes('component_item_masters_released'),
      `release-time re-evaluation should catch the stale flag: ${JSON.stringify(details)}`,
    );
    const blockingLines =
      ((details['component_item_masters_released'] as Record<string, unknown>)[
        'blocking_lines'
      ] as Record<string, unknown>[]) ?? [];
    assert.ok(
      blockingLines.length > 0,
      'component_item_masters_released.blocking_lines should list the offending line: ' +
        JSON.stringify(details),
    );
    assert.ok(
      blockingLines.every((b) => typeof b['bom_line_id'] === 'string'),
      'blocking_lines should carry bom_line_id: ' + JSON.stringify(details),
    );

    const checklist = await makeRequest(
      port,
      'GET',
      `/api/v1/boms/${bomId}/release-gate`,
      undefined,
      engineerHeaders,
    );
    assert.strictEqual(checklist.status, 200);
    const conditions = checklist.body['conditions'] as Record<string, unknown>[];
    const componentCondition = conditions.find(
      (c) => c['condition'] === 'component_item_masters_released',
    );
    assert.strictEqual(componentCondition?.['met'], false, 'checklist agrees with the gate');
    assert.strictEqual(checklist.body['ready_to_release'], false);
  });

  it('blocks release with both missing scrap and inactive component in one gate', async () => {
    const parentId = await createItem(`R3A-PARENT-${run}`, { category: 'finished_goods' });
    const componentSku = `R3A-COMP-${run}`;
    const componentId = await createItem(componentSku);
    const bom = await draftBom(parentId, [componentId], { scrapPercent: undefined });
    const bomId = bom['bom_id'] as string;

    await deactivateItem(componentSku);

    const releaseRes = await makeRequest(
      port,
      'POST',
      `/api/v1/boms/${bomId}/release`,
      {},
      engineerHeaders,
    );
    assert.strictEqual(releaseRes.status, 409, JSON.stringify(releaseRes.body));
    assert.strictEqual(releaseRes.body['error_code'], 'RELEASE_GATE_UNMET');
    const details = releaseRes.body['details'] as Record<string, unknown>;
    const unmet = details['unmet_conditions'] as string[];
    assert.ok(
      unmet.includes('scrap_percent_missing') && unmet.includes('component_item_masters_released'),
      `both conditions should be unmet: ${JSON.stringify(details)}`,
    );
    const scrapBlockers = (
      ((details['scrap_percent_missing'] as Record<string, unknown>)['lines'] as Record<
        string,
        unknown
      >[]) ?? []
    ).length;
    const componentBlockers = (
      ((details['component_item_masters_released'] as Record<string, unknown>)[
        'blocking_lines'
      ] as Record<string, unknown>[]) ?? []
    ).length;
    assert.strictEqual(
      scrapBlockers + componentBlockers,
      2,
      'one blocking line per failed condition',
    );
  });

  it('reports ready_to_release true on a clean draft', async () => {
    const parentId = await createItem(`R3B-PARENT-${run}`, { category: 'finished_goods' });
    const componentId = await createItem(`R3B-COMP-${run}`);
    const bom = await draftBom(parentId, [componentId]);
    const bomId = bom['bom_id'] as string;

    const checklist = await makeRequest(
      port,
      'GET',
      `/api/v1/boms/${bomId}/release-gate`,
      undefined,
      engineerHeaders,
    );
    assert.strictEqual(checklist.status, 200);
    assert.strictEqual(checklist.body['ready_to_release'], true);
    const conditions = checklist.body['conditions'] as Record<string, unknown>[];
    const componentCondition = conditions.find(
      (c) => c['condition'] === 'component_item_masters_released',
    );
    assert.strictEqual(componentCondition?.['met'], true);
    assert.strictEqual(componentCondition?.['enforced'], true);
    assert.strictEqual((componentCondition?.['blocking_lines'] as unknown[]).length, 0);
    const scrapCondition = conditions.find((c) => c['condition'] === 'scrap_percent_missing');
    assert.strictEqual(scrapCondition?.['met'], true);
    assert.strictEqual(scrapCondition?.['enforced'], true);
  });

  it('rejects line add and amend on a released BOM with IMMUTABLE_REVISION', async () => {
    const parentId = await createItem(`R4-PARENT-${run}`, { category: 'finished_goods' });
    const componentId = await createItem(`R4-COMP-${run}`);
    const extraComponentId = await createItem(`R4-COMP2-${run}`);
    const bom = await draftBom(parentId, [componentId]);
    const bomId = bom['bom_id'] as string;

    const releaseRes = await makeRequest(
      port,
      'POST',
      `/api/v1/boms/${bomId}/release`,
      {},
      engineerHeaders,
    );
    assert.strictEqual(releaseRes.status, 200, JSON.stringify(releaseRes.body));

    const addRes = await makeRequest(
      port,
      'POST',
      `/api/v1/boms/${bomId}/lines`,
      {
        line_no: 2,
        component_item_id: extraComponentId,
        output_class: 'component',
        quantity_per: '1.0',
        line_uom: 'EA',
        uom_conversion_factor: '1.0',
        scrap_percent: '0.0',
        is_phantom: false,
        effective_from: '2026-01-01',
      },
      engineerHeaders,
    );
    assert.strictEqual(addRes.status, 409, JSON.stringify(addRes.body));
    assert.strictEqual(addRes.body['error_code'], 'IMMUTABLE_REVISION');

    const pool = getPool();
    const line = await pool.query(
      `SELECT bom_line_id FROM bom_line WHERE bom_id = $1 ORDER BY line_no LIMIT 1`,
      [bomId],
    );
    const lineId = line.rows[0]!.bom_line_id as string;
    const amendRes = await makeRequest(
      port,
      'PATCH',
      `/api/v1/boms/${bomId}/lines/${lineId}`,
      { quantity_per: '9.0' },
      engineerHeaders,
    );
    assert.strictEqual(amendRes.status, 409, JSON.stringify(amendRes.body));
    assert.strictEqual(amendRes.body['error_code'], 'IMMUTABLE_REVISION');
  });

  it('rejects line mutations on an on_hold BOM because the revision is still released', async () => {
    const parentId = await createItem(`R4A-PARENT-${run}`, { category: 'finished_goods' });
    const componentId = await createItem(`R4A-COMP-${run}`);
    const extraComponentId = await createItem(`R4A-COMP2-${run}`);
    const bom = await draftBom(parentId, [componentId]);
    const bomId = bom['bom_id'] as string;

    const releaseRes = await makeRequest(
      port,
      'POST',
      `/api/v1/boms/${bomId}/release`,
      {},
      engineerHeaders,
    );
    assert.strictEqual(releaseRes.status, 200, JSON.stringify(releaseRes.body));

    const holdRes = await makeRequest(
      port,
      'POST',
      `/api/v1/boms/${bomId}/hold`,
      { reason: 'quality hold' },
      engineerHeaders,
    );
    assert.strictEqual(holdRes.status, 200, JSON.stringify(holdRes.body));

    const addRes = await makeRequest(
      port,
      'POST',
      `/api/v1/boms/${bomId}/lines`,
      {
        line_no: 2,
        component_item_id: extraComponentId,
        output_class: 'component',
        quantity_per: '1.0',
        line_uom: 'EA',
        uom_conversion_factor: '1.0',
        scrap_percent: '0.0',
        is_phantom: false,
        effective_from: '2026-01-01',
      },
      engineerHeaders,
    );
    assert.strictEqual(addRes.status, 409, JSON.stringify(addRes.body));
    assert.strictEqual(addRes.body['error_code'], 'IMMUTABLE_REVISION');
  });

  it('walks released to on_hold to released to obsolete, then rejects further transitions', async () => {
    const parentId = await createItem(`R5-PARENT-${run}`, { category: 'finished_goods' });
    const componentId = await createItem(`R5-COMP-${run}`);
    const bom = await draftBom(parentId, [componentId]);
    const bomId = bom['bom_id'] as string;

    const release1 = await makeRequest(
      port,
      'POST',
      `/api/v1/boms/${bomId}/release`,
      {},
      engineerHeaders,
    );
    assert.strictEqual(release1.status, 200, JSON.stringify(release1.body));

    const hold = await makeRequest(
      port,
      'POST',
      `/api/v1/boms/${bomId}/hold`,
      { reason: 'quality investigation' },
      engineerHeaders,
    );
    assert.strictEqual(hold.status, 200, JSON.stringify(hold.body));
    assert.strictEqual(hold.body['status'], 'on_hold');

    const reinstate = await makeRequest(
      port,
      'POST',
      `/api/v1/boms/${bomId}/release`,
      { reason: 'investigation cleared - reinstatement' },
      engineerHeaders,
    );
    assert.strictEqual(reinstate.status, 200, JSON.stringify(reinstate.body));
    assert.strictEqual(reinstate.body['status'], 'released');

    const obsolete = await makeRequest(
      port,
      'POST',
      `/api/v1/boms/${bomId}/obsolete`,
      { reason: 'superseded' },
      engineerHeaders,
    );
    assert.strictEqual(obsolete.status, 200, JSON.stringify(obsolete.body));
    assert.strictEqual(obsolete.body['status'], 'obsolete');

    const pool = getPool();
    const audit = await pool.query(`SELECT COUNT(*) AS cnt FROM audit_log WHERE endpoint LIKE $1`, [
      `/api/v1/boms/${bomId}/%`,
    ]);
    assert.ok(Number(audit.rows[0]!.cnt) >= 4, 'every transition should be audit-logged');

    for (const action of ['release', 'hold', 'obsolete']) {
      const res = await makeRequest(
        port,
        'POST',
        `/api/v1/boms/${bomId}/${action}`,
        {},
        engineerHeaders,
      );
      assert.strictEqual(res.status, 409, `obsolete is terminal: ${JSON.stringify(res.body)}`);
      assert.strictEqual(res.body['error_code'], 'INVALID_STATE_TRANSITION');
    }
  });

  it('rejects on_hold to hold with INVALID_STATE_TRANSITION', async () => {
    const parentId = await createItem(`R5A-PARENT-${run}`, { category: 'finished_goods' });
    const componentId = await createItem(`R5A-COMP-${run}`);
    const bom = await draftBom(parentId, [componentId]);
    const bomId = bom['bom_id'] as string;

    const release = await makeRequest(
      port,
      'POST',
      `/api/v1/boms/${bomId}/release`,
      {},
      engineerHeaders,
    );
    assert.strictEqual(release.status, 200, JSON.stringify(release.body));

    const hold = await makeRequest(port, 'POST', `/api/v1/boms/${bomId}/hold`, {}, engineerHeaders);
    assert.strictEqual(hold.status, 200, JSON.stringify(hold.body));

    const doubleHold = await makeRequest(
      port,
      'POST',
      `/api/v1/boms/${bomId}/hold`,
      {},
      engineerHeaders,
    );
    assert.strictEqual(doubleHold.status, 409, JSON.stringify(doubleHold.body));
    assert.strictEqual(doubleHold.body['error_code'], 'INVALID_STATE_TRANSITION');
  });

  it('allows on_hold to obsolete', async () => {
    const parentId = await createItem(`R5B-PARENT-${run}`, { category: 'finished_goods' });
    const componentId = await createItem(`R5B-COMP-${run}`);
    const bom = await draftBom(parentId, [componentId]);
    const bomId = bom['bom_id'] as string;

    const release = await makeRequest(
      port,
      'POST',
      `/api/v1/boms/${bomId}/release`,
      {},
      engineerHeaders,
    );
    assert.strictEqual(release.status, 200, JSON.stringify(release.body));

    const hold = await makeRequest(port, 'POST', `/api/v1/boms/${bomId}/hold`, {}, engineerHeaders);
    assert.strictEqual(hold.status, 200, JSON.stringify(hold.body));

    const obsolete = await makeRequest(
      port,
      'POST',
      `/api/v1/boms/${bomId}/obsolete`,
      { reason: 'superseded from hold' },
      engineerHeaders,
    );
    assert.strictEqual(obsolete.status, 200, JSON.stringify(obsolete.body));
    assert.strictEqual(obsolete.body['status'], 'obsolete');
  });

  it('rejects draft to obsolete with INVALID_STATE_TRANSITION', async () => {
    const parentId = await createItem(`R5C-PARENT-${run}`, { category: 'finished_goods' });
    const componentId = await createItem(`R5C-COMP-${run}`);
    const bom = await draftBom(parentId, [componentId]);
    const bomId = bom['bom_id'] as string;

    const obsolete = await makeRequest(
      port,
      'POST',
      `/api/v1/boms/${bomId}/obsolete`,
      {},
      engineerHeaders,
    );
    assert.strictEqual(obsolete.status, 409, JSON.stringify(obsolete.body));
    assert.strictEqual(obsolete.body['error_code'], 'INVALID_STATE_TRANSITION');
  });

  it('records reinstatement reason in the audit log', async () => {
    const parentId = await createItem(`R5D-PARENT-${run}`, { category: 'finished_goods' });
    const componentId = await createItem(`R5D-COMP-${run}`);
    const bom = await draftBom(parentId, [componentId]);
    const bomId = bom['bom_id'] as string;

    const release = await makeRequest(
      port,
      'POST',
      `/api/v1/boms/${bomId}/release`,
      {},
      engineerHeaders,
    );
    assert.strictEqual(release.status, 200, JSON.stringify(release.body));

    const hold = await makeRequest(
      port,
      'POST',
      `/api/v1/boms/${bomId}/hold`,
      { reason: 'investigation' },
      engineerHeaders,
    );
    assert.strictEqual(hold.status, 200, JSON.stringify(hold.body));

    const reinstate = await makeRequest(
      port,
      'POST',
      `/api/v1/boms/${bomId}/release`,
      { reason: 'investigation cleared' },
      engineerHeaders,
    );
    assert.strictEqual(reinstate.status, 200, JSON.stringify(reinstate.body));

    const pool = getPool();
    const events = await pool.query(
      `SELECT payload FROM domain_events
       WHERE stream_id = $1 AND event_type = 'bom.released'
       ORDER BY event_version ASC`,
      [bomId],
    );
    assert.ok(events.rows.length >= 2, 'reinstatement should persist a second released event');
    const lastReleased = events.rows[events.rows.length - 1] as Record<string, unknown>;
    assert.strictEqual(
      (lastReleased.payload as Record<string, unknown>)['reason'],
      'investigation cleared',
      'reinstatement event should carry the reason in its payload',
    );
  });

  it('rejects draft to on_hold with INVALID_STATE_TRANSITION', async () => {
    const parentId = await createItem(`R6-PARENT-${run}`, { category: 'finished_goods' });
    const componentId = await createItem(`R6-COMP-${run}`);
    const bom = await draftBom(parentId, [componentId]);
    const bomId = bom['bom_id'] as string;

    const hold = await makeRequest(port, 'POST', `/api/v1/boms/${bomId}/hold`, {}, engineerHeaders);
    assert.strictEqual(hold.status, 409, JSON.stringify(hold.body));
    assert.strictEqual(hold.body['error_code'], 'INVALID_STATE_TRANSITION');
  });

  it('migrates a qualifying kit to Released with origin legacy_kit and migration-exempt audit', async () => {
    const parentId = await createItem(`R7-KITPARENT-${run}`, { category: 'finished_goods' });
    const componentId = await createItem(`R7-KITCOMP-${run}`);

    const migrateRes = await makeRequest(
      port,
      'POST',
      '/api/v1/boms/legacy-kit-migration',
      {
        kits: [
          {
            kit_ref: `KIT-R7-${run}`,
            parent_item_id: parentId,
            components: [{ component_item_id: componentId, quantity_per: '3.0', line_uom: 'EA' }],
          },
        ],
      },
      engineerHeaders,
    );
    assert.strictEqual(migrateRes.status, 200, JSON.stringify(migrateRes.body));
    const migrated = migrateRes.body['migrated'] as Record<string, unknown>[];
    assert.strictEqual(migrated.length, 1, JSON.stringify(migrateRes.body));
    assert.strictEqual(migrated[0]!['migration_exempt'], true);
    const bom = migrated[0]!['bom'] as Record<string, unknown>;
    assert.strictEqual(bom['status'], 'released');
    assert.strictEqual(bom['origin'], 'legacy_kit');
    assert.strictEqual(bom['kit_ref'], `KIT-R7-${run}`);
    assert.strictEqual(bom['remediation_flag'], false);

    const pool = getPool();
    const audit = await pool.query(
      `SELECT details FROM audit_log
       WHERE endpoint = '/api/v1/boms/legacy-kit-migration'
         AND details->>'kit_ref' = $1`,
      [`KIT-R7-${run}`],
    );
    assert.ok(audit.rows.length > 0, 'migration should write an audit entry');
    assert.strictEqual(
      (audit.rows[0]!.details as Record<string, unknown>)['migration_exempt'],
      true,
      'audit entry records the migration-exempt release',
    );

    const lines = await pool.query(
      `SELECT line_no, scrap_percent, output_class, is_phantom, uom_conversion_factor, base_quantity_per, effective_from FROM bom_line WHERE bom_id = $1`,
      [bom['bom_id']],
    );
    assert.strictEqual(
      lines.rows[0]!.scrap_percent,
      '0.0000',
      'missing scrap defaults to exact-decimal zero on the released path',
    );
    assert.strictEqual(lines.rows[0]!.line_no, 1, 'line_no is sequential from array order');
    assert.strictEqual(lines.rows[0]!.output_class, 'component');
    assert.strictEqual(lines.rows[0]!.is_phantom, false);
    assert.strictEqual(lines.rows[0]!.uom_conversion_factor, '1.00000000');
    assert.strictEqual(
      lines.rows[0]!.base_quantity_per,
      '3.000000',
      'base_quantity_per equals quantity_per when no conversion',
    );
    const effectiveFrom = new Date(lines.rows[0]!.effective_from as string | Date);
    const today = new Date();
    assert.ok(
      effectiveFrom.toDateString() === today.toDateString(),
      `effective_from should default to today, got ${effectiveFrom.toISOString()}`,
    );
  });

  it('lands a kit with an inactive component as draft remediation on the exception list', async () => {
    const parentId = await createItem(`R8-KITPARENT-${run}`, { category: 'finished_goods' });
    const inactiveSku = `R8-KITCOMP-${run}`;
    const inactiveId = await createItem(inactiveSku);
    await deactivateItem(inactiveSku);

    const migrateRes = await makeRequest(
      port,
      'POST',
      '/api/v1/boms/legacy-kit-migration',
      {
        kits: [
          {
            kit_ref: `KIT-R8-${run}`,
            parent_item_id: parentId,
            components: [{ component_item_id: inactiveId, quantity_per: '1.0', line_uom: 'EA' }],
          },
        ],
      },
      engineerHeaders,
    );
    assert.strictEqual(migrateRes.status, 200, JSON.stringify(migrateRes.body));
    const remediation = migrateRes.body['draft_remediation'] as Record<string, unknown>[];
    assert.strictEqual(remediation.length, 1, JSON.stringify(migrateRes.body));
    const bom = remediation[0]!['bom'] as Record<string, unknown>;
    assert.strictEqual(bom['status'], 'draft');
    assert.strictEqual(bom['remediation_flag'], true);
    assert.strictEqual(bom['origin'], 'legacy_kit');
    assert.strictEqual(
      remediation[0]!['migration_exempt'],
      false,
      'draft remediation is not migration-exempt',
    );

    const pool = getPool();
    const lines = await pool.query(
      `SELECT scrap_percent, blocking_release FROM bom_line WHERE bom_id = $1`,
      [bom['bom_id']],
    );
    assert.strictEqual(lines.rows[0]!.scrap_percent, null, 'draft remediation keeps null scrap');
    assert.strictEqual(lines.rows[0]!.blocking_release, true, 'blocking_release must be set');

    const bomRow = await pool.query(`SELECT blocking_line_count FROM bom WHERE bom_id = $1`, [
      bom['bom_id'],
    ]);
    assert.strictEqual(
      bomRow.rows[0]!.blocking_line_count,
      1,
      'blocking_line_count reflects the inactive component',
    );

    const exceptions = await makeRequest(
      port,
      'GET',
      '/api/v1/boms/migration-exceptions',
      undefined,
      engineerHeaders,
    );
    assert.strictEqual(exceptions.status, 200, JSON.stringify(exceptions.body));
    const data = exceptions.body['data'] as Record<string, unknown>[];
    assert.ok(
      data.some((row) => row['bom_id'] === bom['bom_id']),
      'draft-remediation BOM should appear on the exception list',
    );
  });

  it('lands a kit with an inactive parent as draft remediation, never released', async () => {
    const inactiveParentSku = `R8A-KITPARENT-${run}`;
    const inactiveParentId = await createItem(inactiveParentSku, {
      category: 'finished_goods',
    });
    await deactivateItem(inactiveParentSku);
    const componentId = await createItem(`R8A-KITCOMP-${run}`);

    const migrateRes = await makeRequest(
      port,
      'POST',
      '/api/v1/boms/legacy-kit-migration',
      {
        kits: [
          {
            kit_ref: `KIT-R8A-${run}`,
            parent_item_id: inactiveParentId,
            components: [{ component_item_id: componentId, quantity_per: '1.0', line_uom: 'EA' }],
          },
        ],
      },
      engineerHeaders,
    );
    assert.strictEqual(migrateRes.status, 200, JSON.stringify(migrateRes.body));
    const migrated = migrateRes.body['migrated'] as Record<string, unknown>[];
    assert.strictEqual(migrated.length, 0, JSON.stringify(migrateRes.body));
    const remediation = migrateRes.body['draft_remediation'] as Record<string, unknown>[];
    assert.strictEqual(remediation.length, 1, JSON.stringify(migrateRes.body));
    const bom = remediation[0]!['bom'] as Record<string, unknown>;
    assert.strictEqual(bom['status'], 'draft');
    assert.strictEqual(bom['remediation_flag'], true);
    assert.strictEqual(bom['origin'], 'legacy_kit');
    assert.strictEqual(
      remediation[0]!['migration_exempt'],
      false,
      'draft remediation is not migration-exempt',
    );

    const pool = getPool();
    const lines = await pool.query(
      `SELECT scrap_percent, blocking_release FROM bom_line WHERE bom_id = $1`,
      [bom['bom_id']],
    );
    assert.strictEqual(
      lines.rows[0]!.scrap_percent,
      null,
      'draft remediation keeps null scrap when no value supplied',
    );
    assert.strictEqual(
      lines.rows[0]!.blocking_release,
      false,
      'active components are not blocking on the line level',
    );

    const bomRow = await pool.query(`SELECT blocking_line_count FROM bom WHERE bom_id = $1`, [
      bom['bom_id'],
    ]);
    assert.strictEqual(
      bomRow.rows[0]!.blocking_line_count,
      0,
      'blocking_line_count is 0 because components are active',
    );

    const exceptions = await makeRequest(
      port,
      'GET',
      '/api/v1/boms/migration-exceptions',
      undefined,
      engineerHeaders,
    );
    assert.strictEqual(exceptions.status, 200, JSON.stringify(exceptions.body));
    const data = exceptions.body['data'] as Record<string, unknown>[];
    assert.ok(
      data.some((row) => row['bom_id'] === bom['bom_id']),
      'inactive-parent BOM should appear on the exception list',
    );
  });

  it('reports skipped bom_exists for a kit whose parent already has a BOM', async () => {
    const parentId = await createItem(`R9-KITPARENT-${run}`, { category: 'finished_goods' });
    const componentId = await createItem(`R9-KITCOMP-${run}`);
    await draftBom(parentId, [componentId]);

    const migrateRes = await makeRequest(
      port,
      'POST',
      '/api/v1/boms/legacy-kit-migration',
      {
        kits: [
          {
            kit_ref: `KIT-R9-${run}`,
            parent_item_id: parentId,
            components: [{ component_item_id: componentId, quantity_per: '1.0', line_uom: 'EA' }],
          },
        ],
      },
      engineerHeaders,
    );
    assert.strictEqual(migrateRes.status, 200, JSON.stringify(migrateRes.body));
    const skipped = migrateRes.body['skipped'] as Record<string, unknown>[];
    assert.strictEqual(skipped.length, 1, JSON.stringify(migrateRes.body));
    assert.strictEqual(skipped[0]!['skipped'], 'bom_exists');
    assert.strictEqual((migrateRes.body['migrated'] as unknown[]).length, 0);
  });

  it('rejects a migration batch larger than 500 kits', async () => {
    const parentId = await createItem(`R9A-KITPARENT-${run}`, { category: 'finished_goods' });
    const componentId = await createItem(`R9A-KITCOMP-${run}`);
    const kits = Array.from({ length: 501 }, (_, i) => ({
      kit_ref: `KIT-R9A-${run}-${i}`,
      parent_item_id: parentId,
      components: [{ component_item_id: componentId, quantity_per: '1.0', line_uom: 'EA' }],
    }));

    const migrateRes = await makeRequest(
      port,
      'POST',
      '/api/v1/boms/legacy-kit-migration',
      { kits },
      engineerHeaders,
    );
    assert.strictEqual(migrateRes.status, 400, JSON.stringify(migrateRes.body));
    assert.strictEqual(migrateRes.body['error_code'], 'INVALID_PARAMS');
  });

  it('skips a malformed kit instead of failing the whole batch', async () => {
    const parentId = await createItem(`R9B-KITPARENT-${run}`, { category: 'finished_goods' });
    const componentId = await createItem(`R9B-KITCOMP-${run}`);
    const malformedParentId = await createItem(`R9B-KITPARENT2-${run}`, {
      category: 'finished_goods',
    });

    const migrateRes = await makeRequest(
      port,
      'POST',
      '/api/v1/boms/legacy-kit-migration',
      {
        kits: [
          {
            kit_ref: `KIT-R9B-OK-${run}`,
            parent_item_id: parentId,
            components: [{ component_item_id: componentId, quantity_per: '1.0', line_uom: 'EA' }],
          },
          {
            kit_ref: `KIT-R9B-BAD-${run}`,
            parent_item_id: malformedParentId,
            components: [null],
          },
          {
            kit_ref: `KIT-R9B-BAD2-${run}`,
            parent_item_id: 'not-a-uuid',
            components: [{ component_item_id: componentId, quantity_per: '1.0', line_uom: 'EA' }],
          },
        ],
      },
      engineerHeaders,
    );
    assert.strictEqual(migrateRes.status, 200, JSON.stringify(migrateRes.body));
    const migrated = migrateRes.body['migrated'] as Record<string, unknown>[];
    assert.strictEqual(migrated.length, 1, JSON.stringify(migrateRes.body));
    const skipped = migrateRes.body['skipped'] as Record<string, unknown>[];
    assert.strictEqual(skipped.length, 2, JSON.stringify(migrateRes.body));
    for (const skip of skipped) {
      assert.strictEqual(skip['skipped'], 'invalid_kit', JSON.stringify(skip));
    }
  });

  it('reports a duplicate kit_ref in one batch as skipped with the existing bom_id, not a phantom', async () => {
    const parentOne = await createItem(`R9C-KITPARENT1-${run}`, { category: 'finished_goods' });
    const parentTwo = await createItem(`R9C-KITPARENT2-${run}`, { category: 'finished_goods' });
    const componentId = await createItem(`R9C-KITCOMP-${run}`);

    const migrateRes = await makeRequest(
      port,
      'POST',
      '/api/v1/boms/legacy-kit-migration',
      {
        kits: [
          {
            kit_ref: `KIT-R9C-DUP-${run}`,
            parent_item_id: parentOne,
            components: [{ component_item_id: componentId, quantity_per: '1.0', line_uom: 'EA' }],
          },
          {
            kit_ref: `KIT-R9C-DUP-${run}`,
            parent_item_id: parentTwo,
            components: [{ component_item_id: componentId, quantity_per: '1.0', line_uom: 'EA' }],
          },
        ],
      },
      engineerHeaders,
    );
    assert.strictEqual(migrateRes.status, 200, JSON.stringify(migrateRes.body));
    const migrated = migrateRes.body['migrated'] as Record<string, unknown>[];
    assert.strictEqual(migrated.length, 1, JSON.stringify(migrateRes.body));
    const skipped = migrateRes.body['skipped'] as Record<string, unknown>[];
    assert.strictEqual(skipped.length, 1, JSON.stringify(migrateRes.body));
    assert.strictEqual(skipped[0]!['skipped'], 'bom_exists', JSON.stringify(skipped[0]));
    assert.strictEqual(
      skipped[0]!['bom_id'],
      migrated[0]!['bom_id'],
      'duplicate kit_ref must reference the existing BOM, not a fabricated one',
    );
  });

  it('skips a kit with a non-existent parent_item_id', async () => {
    const migrateRes = await makeRequest(
      port,
      'POST',
      '/api/v1/boms/legacy-kit-migration',
      {
        kits: [
          {
            kit_ref: `KIT-R9D-${run}`,
            parent_item_id: randomUUID(),
            components: [{ component_item_id: randomUUID(), quantity_per: '1.0', line_uom: 'EA' }],
          },
        ],
      },
      engineerHeaders,
    );
    assert.strictEqual(migrateRes.status, 200, JSON.stringify(migrateRes.body));
    const skipped = migrateRes.body['skipped'] as Record<string, unknown>[];
    assert.strictEqual(skipped.length, 1, JSON.stringify(migrateRes.body));
    assert.strictEqual(skipped[0]!['skipped'], 'parent_item_not_found');
  });

  it('reports in-batch duplicate parent as bom_exists', async () => {
    const parentId = await createItem(`R9E-KITPARENT-${run}`, { category: 'finished_goods' });
    const componentId = await createItem(`R9E-KITCOMP-${run}`);

    const migrateRes = await makeRequest(
      port,
      'POST',
      '/api/v1/boms/legacy-kit-migration',
      {
        kits: [
          {
            kit_ref: `KIT-R9E-A-${run}`,
            parent_item_id: parentId,
            components: [{ component_item_id: componentId, quantity_per: '1.0', line_uom: 'EA' }],
          },
          {
            kit_ref: `KIT-R9E-B-${run}`,
            parent_item_id: parentId,
            components: [{ component_item_id: componentId, quantity_per: '1.0', line_uom: 'EA' }],
          },
        ],
      },
      engineerHeaders,
    );
    assert.strictEqual(migrateRes.status, 200, JSON.stringify(migrateRes.body));
    const migrated = migrateRes.body['migrated'] as Record<string, unknown>[];
    assert.strictEqual(migrated.length, 1, JSON.stringify(migrateRes.body));
    const skipped = migrateRes.body['skipped'] as Record<string, unknown>[];
    assert.strictEqual(skipped.length, 1, JSON.stringify(migrateRes.body));
    assert.strictEqual(skipped[0]!['skipped'], 'bom_exists');
    assert.strictEqual(skipped[0]!['parent_item_id'], parentId);
  });

  it('is idempotent across batch re-runs with the same idempotency_key', async () => {
    const parentId = await createItem(`R9F-KITPARENT-${run}`, { category: 'finished_goods' });
    const componentId = await createItem(`R9F-KITCOMP-${run}`);

    const batchKey = randomUUID();
    const first = await makeRequest(
      port,
      'POST',
      '/api/v1/boms/legacy-kit-migration',
      {
        kits: [
          {
            kit_ref: `KIT-R9F-${run}`,
            parent_item_id: parentId,
            components: [{ component_item_id: componentId, quantity_per: '2.5', line_uom: 'EA' }],
          },
        ],
        idempotency_key: batchKey,
      },
      engineerHeaders,
    );
    assert.strictEqual(first.status, 200, JSON.stringify(first.body));
    const firstBomId = (first.body['migrated'] as Record<string, unknown>[])[0]![
      'bom_id'
    ] as string;

    const replay = await makeRequest(
      port,
      'POST',
      '/api/v1/boms/legacy-kit-migration',
      {
        kits: [
          {
            kit_ref: `KIT-R9F-${run}`,
            parent_item_id: parentId,
            components: [{ component_item_id: componentId, quantity_per: '2.5', line_uom: 'EA' }],
          },
        ],
        idempotency_key: batchKey,
      },
      engineerHeaders,
    );
    assert.strictEqual(replay.status, 200, JSON.stringify(replay.body));
    assert.strictEqual(
      (replay.body['migrated'] as Record<string, unknown>[]).length,
      0,
      JSON.stringify(replay.body),
    );
    assert.strictEqual(
      (replay.body['skipped'] as Record<string, unknown>[]).length,
      1,
      JSON.stringify(replay.body),
    );
    assert.strictEqual(
      (replay.body['skipped'] as Record<string, unknown>[])[0]!['bom_id'],
      firstBomId,
      'replay must return the same bom_id in skipped',
    );
  });

  it('validates limit and offset on migration-exceptions', async () => {
    const exceptionsRes = await makeRequest(
      port,
      'GET',
      '/api/v1/boms/migration-exceptions?limit=abc',
      undefined,
      engineerHeaders,
    );
    assert.strictEqual(exceptionsRes.status, 200, JSON.stringify(exceptionsRes.body));
    assert.strictEqual(exceptionsRes.body['limit'], 200, 'invalid limit defaults to 200');

    const zeroRes = await makeRequest(
      port,
      'GET',
      '/api/v1/boms/migration-exceptions?limit=0',
      undefined,
      engineerHeaders,
    );
    assert.strictEqual(zeroRes.status, 200, JSON.stringify(zeroRes.body));
    assert.strictEqual(zeroRes.body['limit'], 0);
    assert.strictEqual((zeroRes.body['data'] as unknown[]).length, 0);

    const bigRes = await makeRequest(
      port,
      'GET',
      '/api/v1/boms/migration-exceptions?limit=500',
      undefined,
      engineerHeaders,
    );
    assert.strictEqual(bigRes.status, 200, JSON.stringify(bigRes.body));
    assert.strictEqual(bigRes.body['limit'], 200, 'limit should be clamped to 200');
  });

  it('rejects a direct bom.released post to the events API', async () => {
    const eventRes = await makeRequest(
      port,
      'POST',
      '/api/v1/events',
      {
        stream_type: 'engineering',
        stream_id: randomUUID(),
        event_type: 'bom.released',
        payload: { bom_id: randomUUID(), revision_id: randomUUID() },
        metadata: {
          correlation_id: randomUUID(),
          occurred_at: new Date().toISOString(),
          actor: { user_id: randomUUID(), role: 'engineering_admin', location_id: randomUUID() },
        },
      },
      engineerHeaders,
    );
    assert.strictEqual(eventRes.status, 400, JSON.stringify(eventRes.body));
    assert.strictEqual(eventRes.body['error_code'], 'INVALID_EVENT_STREAM');
  });

  it('returns 403 for lifecycle mutations without engineering write role', async () => {
    const parentId = await createItem(`R11-PARENT-${run}`, { category: 'finished_goods' });
    const componentId = await createItem(`R11-COMP-${run}`);
    const bom = await draftBom(parentId, [componentId]);
    const bomId = bom['bom_id'] as string;

    const release = await makeRequest(
      port,
      'POST',
      `/api/v1/boms/${bomId}/release`,
      {},
      readerHeaders,
    );
    assert.strictEqual(release.status, 403, JSON.stringify(release.body));
    assert.strictEqual(release.body['error_code'], 'FUNCTION_ACCESS_DENIED');

    const hold = await makeRequest(port, 'POST', `/api/v1/boms/${bomId}/hold`, {}, readerHeaders);
    assert.strictEqual(hold.status, 403, JSON.stringify(hold.body));
    assert.strictEqual(hold.body['error_code'], 'FUNCTION_ACCESS_DENIED');

    const obsolete = await makeRequest(
      port,
      'POST',
      `/api/v1/boms/${bomId}/obsolete`,
      {},
      readerHeaders,
    );
    assert.strictEqual(obsolete.status, 403, JSON.stringify(obsolete.body));
    assert.strictEqual(obsolete.body['error_code'], 'FUNCTION_ACCESS_DENIED');

    const migrate = await makeRequest(
      port,
      'POST',
      '/api/v1/boms/legacy-kit-migration',
      { kits: [] },
      readerHeaders,
    );
    assert.strictEqual(migrate.status, 403, JSON.stringify(migrate.body));
    assert.strictEqual(migrate.body['error_code'], 'FUNCTION_ACCESS_DENIED');

    const exceptions = await makeRequest(
      port,
      'GET',
      '/api/v1/boms/migration-exceptions',
      undefined,
      readerHeaders,
    );
    assert.strictEqual(exceptions.status, 200, JSON.stringify(exceptions.body));
  });

  it('does not double-apply a release replayed with the same idempotency_key', async () => {
    const parentId = await createItem(`R12-PARENT-${run}`, { category: 'finished_goods' });
    const componentId = await createItem(`R12-COMP-${run}`);
    const bom = await draftBom(parentId, [componentId]);
    const bomId = bom['bom_id'] as string;

    const idempotencyKey = randomUUID();
    const first = await makeRequest(
      port,
      'POST',
      `/api/v1/boms/${bomId}/release`,
      { idempotency_key: idempotencyKey },
      engineerHeaders,
    );
    assert.strictEqual(first.status, 200, JSON.stringify(first.body));

    const replay = await makeRequest(
      port,
      'POST',
      `/api/v1/boms/${bomId}/release`,
      { idempotency_key: idempotencyKey },
      engineerHeaders,
    );
    assert.strictEqual(replay.status, 200, JSON.stringify(replay.body));
    assert.strictEqual(replay.body['status'], 'released');

    const pool = getPool();
    const events = await pool.query(
      `SELECT COUNT(*) AS cnt FROM domain_events WHERE idempotency_key = $1`,
      [idempotencyKey],
    );
    assert.strictEqual(Number(events.rows[0]!.cnt), 1, 'replay must not append a second event');
  });
});
