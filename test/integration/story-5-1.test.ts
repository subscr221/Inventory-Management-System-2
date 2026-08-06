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
  assert.ok(res.status >= 200 && res.status < 300, `dev-token ${sub} failed: ${JSON.stringify(res.body)}`);
  return { Authorization: `Bearer ${res.body['token'] as string}` };
}

describe('Story 5.1 BOM Management Integration Tests', () => {
  let server: Server;
  let port: number;
  let engineerHeaders: Record<string, string>;
  let parentItemId: string;
  let componentItemId1: string;
  let componentItemId2: string;

  before(async () => {
    const pool = getPool();
    await pool.query(`SET search_path TO public`);

    const adminPool = getAdminPool();
    for (const sqlFile of [
      'read/projections/item_master.sql',
      'read/projections/business_stream_config.sql',
    ]) {
      const sql = readFileSync(resolve(__dirname, `../../${sqlFile}`), 'utf-8');
      await adminPool.query(sql);
    }

    const app = createAppRouter();
    server = await createAppServer(app);
    port = (server.address() as AddressInfo).port;

    await makeRequest(port, 'POST', '/api/v1/scim/v2/Users', {
      externalId: `engineer-${run}@test.com`,
      email: `engineer-${run}@test.com`,
      displayName: `Engineer ${run}`,
      roles: [
        { role: 'engineering_admin', module: 'engineering', functionScope: 'write', locationId: '*' },
      ],
    });

    const itemRes1 = await makeRequest(port, 'POST', '/api/v1/items', {
      sku: `BOM-PARENT-${run}`,
      description: 'Test Parent Item',
      uom: 'EA',
      business_stream: 'production',
      category: 'finished_goods',
    });
    assert.strictEqual(itemRes1.status, 201);
    parentItemId = (itemRes1.body as Record<string, string>)['item_id']!;

    const itemRes2 = await makeRequest(port, 'POST', '/api/v1/items', {
      sku: `BOM-COMP1-${run}`,
      description: 'Test Component 1',
      uom: 'KG',
      business_stream: 'production',
      category: 'raw_materials',
    });
    assert.strictEqual(itemRes2.status, 201);
    componentItemId1 = (itemRes2.body as Record<string, string>)['item_id']!;

    const itemRes3 = await makeRequest(port, 'POST', '/api/v1/items', {
      sku: `BOM-COMP2-${run}`,
      description: 'Test Component 2',
      uom: 'EA',
      business_stream: 'production',
      category: 'raw_materials',
    });
    assert.strictEqual(itemRes3.status, 201);
    componentItemId2 = (itemRes3.body as Record<string, string>)['item_id']!;

    engineerHeaders = await authFor(port, `engineer-${run}@test.com`);
  });

  after(async () => {
    server.close();
    await closePool();
    await closeAdminPool();
  });

  it('creates a draft BOM with lines', async () => {
    const draftRes = await makeRequest(
      port,
      'POST',
      '/api/v1/boms',
      {
        parent_item_id: parentItemId,
        revision_code: 'A',
        bom_type: 'production',
        lines: [
          {
            line_no: 1,
            component_item_id: componentItemId1,
            output_class: 'component',
            quantity_per: '2.5',
            line_uom: 'KG',
            uom_conversion_factor: '1.0',
            scrap_percent: '5.0',
            is_phantom: false,
            effective_from: '2026-01-01',
          },
          {
            line_no: 2,
            component_item_id: componentItemId2,
            output_class: 'component',
            quantity_per: '1.0',
            line_uom: 'EA',
            uom_conversion_factor: '1.0',
            is_phantom: false,
            effective_from: '2026-01-01',
          },
        ],
        correlation_id: randomUUID(),
      },
      engineerHeaders,
    );

    assert.strictEqual(draftRes.status, 201, `BOM draft failed: ${JSON.stringify(draftRes.body)}`);
    const bom = draftRes.body as Record<string, unknown>;
    assert.ok(bom['bom_id'], 'BOM should have bom_id');
    assert.strictEqual(bom['status'], 'draft', 'BOM status should be draft');
    assert.strictEqual(bom['parent_item_id'], parentItemId, 'Parent item should match');
    assert.strictEqual(bom['blocking_line_count'], 0, 'Blocking count should be 0 for active items');
  });

  it('rejects BOM creation with inactive component', async () => {
    const inactiveItemRes = await makeRequest(port, 'POST', '/api/v1/items', {
      sku: `BOM-INACTIVE-${run}`,
      description: 'Inactive Component',
      uom: 'EA',
      business_stream: 'production',
      category: 'raw_materials',
      status: 'inactive',
    });
    const inactiveItemId = (inactiveItemRes.body as Record<string, string>)['item_id']!;

    const draftRes = await makeRequest(
      port,
      'POST',
      '/api/v1/boms',
      {
        parent_item_id: parentItemId,
        revision_code: 'B',
        lines: [
          {
            line_no: 1,
            component_item_id: inactiveItemId,
            output_class: 'component',
            quantity_per: '1.0',
            line_uom: 'EA',
            uom_conversion_factor: '1.0',
            is_phantom: false,
            effective_from: '2026-01-01',
          },
        ],
      },
      engineerHeaders,
    );

    assert.strictEqual(draftRes.status, 201, 'BOM with inactive component should be created (line is blocked)');
    const bom = draftRes.body as Record<string, unknown>;
    assert.strictEqual(bom['blocking_line_count'], 1, 'Blocking count should be 1 for inactive component');
  });

  it('rejects BOM creation with missing lines', async () => {
    const draftRes = await makeRequest(
      port,
      'POST',
      '/api/v1/boms',
      {
        parent_item_id: parentItemId,
        revision_code: 'C',
        lines: [],
      },
      engineerHeaders,
    );

    assert.strictEqual(draftRes.status, 400, 'Empty lines should be rejected');
    assert.strictEqual((draftRes.body as Record<string, string>)['error_code'], 'BOM_LINE_REQUIRED');
  });

  it('rejects BOM creation with invalid scrap percent', async () => {
    const draftRes = await makeRequest(
      port,
      'POST',
      '/api/v1/boms',
      {
        parent_item_id: parentItemId,
        revision_code: 'D',
        lines: [
          {
            line_no: 1,
            component_item_id: componentItemId1,
            output_class: 'component',
            quantity_per: '1.0',
            line_uom: 'KG',
            uom_conversion_factor: '1.0',
            scrap_percent: '150.0',
            is_phantom: false,
            effective_from: '2026-01-01',
          },
        ],
      },
      engineerHeaders,
    );

    assert.strictEqual(draftRes.status, 400, 'Invalid scrap percent should be rejected');
  });

  it('rejects co-product without yield', async () => {
    const draftRes = await makeRequest(
      port,
      'POST',
      '/api/v1/boms',
      {
        parent_item_id: parentItemId,
        revision_code: 'E',
        lines: [
          {
            line_no: 1,
            component_item_id: componentItemId1,
            output_class: 'co_product',
            quantity_per: '1.0',
            line_uom: 'KG',
            uom_conversion_factor: '1.0',
            is_phantom: false,
            effective_from: '2026-01-01',
          },
        ],
      },
      engineerHeaders,
    );

    assert.strictEqual(draftRes.status, 400, 'Co-product without yield should be rejected');
    assert.strictEqual((draftRes.body as Record<string, string>)['error_code'], 'BOM_YIELD_REQUIRED');
  });

  it('accepts co-product with yield', async () => {
    const draftRes = await makeRequest(
      port,
      'POST',
      '/api/v1/boms',
      {
        parent_item_id: parentItemId,
        revision_code: 'F',
        lines: [
          {
            line_no: 1,
            component_item_id: componentItemId1,
            output_class: 'co_product',
            quantity_per: '0.5',
            line_uom: 'KG',
            uom_conversion_factor: '1.0',
            expected_yield_percent: '95.0',
            is_phantom: false,
            effective_from: '2026-01-01',
          },
        ],
      },
      engineerHeaders,
    );

    assert.strictEqual(draftRes.status, 201, `Co-product with yield failed: ${JSON.stringify(draftRes.body)}`);
  });

  it('lists BOMs', async () => {
    const listRes = await makeRequest(port, 'GET', '/api/v1/boms', undefined, engineerHeaders);

    assert.strictEqual(listRes.status, 200, 'List BOMs should succeed');
    const data = listRes.body as Record<string, unknown>;
    assert.ok(Array.isArray(data['data']), 'data should be an array');
    assert.ok(typeof data['total'] === 'number', 'total should be a number');
  });

  it('retrieves a single BOM', async () => {
    const draftRes = await makeRequest(port, 'POST', '/api/v1/boms', {
      parent_item_id: parentItemId,
      revision_code: 'G',
      lines: [
        {
          line_no: 1,
          component_item_id: componentItemId1,
          output_class: 'component',
          quantity_per: '1.0',
          line_uom: 'KG',
          uom_conversion_factor: '1.0',
          is_phantom: false,
          effective_from: '2026-01-01',
        },
      ],
    }, engineerHeaders);

    assert.strictEqual(draftRes.status, 201);
    const bomId = (draftRes.body as Record<string, string>)['bom_id'];

    const getRes = await makeRequest(port, 'GET', `/api/v1/boms/${bomId}`, undefined, engineerHeaders);

    assert.strictEqual(getRes.status, 200, 'Get BOM should succeed');
    const bom = getRes.body as Record<string, unknown>;
    assert.strictEqual(bom['bom_id'], bomId);
  });

  it('retrieves BOM structure', async () => {
    const draftRes = await makeRequest(port, 'POST', '/api/v1/boms', {
      parent_item_id: parentItemId,
      revision_code: 'H',
      lines: [
        {
          line_no: 1,
          component_item_id: componentItemId1,
          output_class: 'component',
          quantity_per: '2.0',
          line_uom: 'KG',
          uom_conversion_factor: '1.0',
          scrap_percent: '10.0',
          is_phantom: false,
          effective_from: '2026-01-01',
        },
      ],
    }, engineerHeaders);

    assert.strictEqual(draftRes.status, 201);
    const bomId = (draftRes.body as Record<string, string>)['bom_id'];

    const structRes = await makeRequest(port, 'GET', `/api/v1/boms/${bomId}/structure`, undefined, engineerHeaders);

    assert.strictEqual(structRes.status, 200, 'Get BOM structure should succeed');
    const structure = structRes.body as Record<string, unknown>;
    assert.ok(Array.isArray(structure['lines']), 'lines should be an array');
    assert.ok(Array.isArray(structure['revisions']), 'revisions should be an array');
  });

  it('adds a line to draft BOM', async () => {
    const draftRes = await makeRequest(port, 'POST', '/api/v1/boms', {
      parent_item_id: parentItemId,
      revision_code: 'I',
      lines: [
        {
          line_no: 1,
          component_item_id: componentItemId1,
          output_class: 'component',
          quantity_per: '1.0',
          line_uom: 'KG',
          uom_conversion_factor: '1.0',
          is_phantom: false,
          effective_from: '2026-01-01',
        },
      ],
    }, engineerHeaders);

    assert.strictEqual(draftRes.status, 201);
    const bomId = (draftRes.body as Record<string, string>)['bom_id'];

    const addLineRes = await makeRequest(port, 'POST', `/api/v1/boms/${bomId}/lines`, {
      line_no: 2,
      component_item_id: componentItemId2,
      output_class: 'component',
      quantity_per: '3.0',
      line_uom: 'EA',
      uom_conversion_factor: '1.0',
      is_phantom: false,
      effective_from: '2026-01-01',
    }, engineerHeaders);

    assert.strictEqual(addLineRes.status, 200, `Add line failed: ${JSON.stringify(addLineRes.body)}`);
  });

  it('amends a line on draft BOM', async () => {
    const draftRes = await makeRequest(port, 'POST', '/api/v1/boms', {
      parent_item_id: parentItemId,
      revision_code: 'J',
      lines: [
        {
          line_no: 1,
          component_item_id: componentItemId1,
          output_class: 'component',
          quantity_per: '1.0',
          line_uom: 'KG',
          uom_conversion_factor: '1.0',
          scrap_percent: '5.0',
          is_phantom: false,
          effective_from: '2026-01-01',
        },
      ],
    }, engineerHeaders);

    assert.strictEqual(draftRes.status, 201);
    const bom = draftRes.body as Record<string, unknown>;
    const bomId = bom['bom_id'] as string;

    const linesRes = await makeRequest(port, 'GET', `/api/v1/boms/${bomId}/structure`, undefined, engineerHeaders);
    const structure = linesRes.body as Record<string, unknown>;
    const lineId = (structure['lines'] as Record<string, unknown>[])[0]!['bom_line_id'] as string;

    const amendRes = await makeRequest(port, 'PATCH', `/api/v1/boms/${bomId}/lines/${lineId}`, {
      scrap_percent: '10.0',
      quantity_per: '2.0',
    }, engineerHeaders);

    assert.strictEqual(amendRes.status, 200, `Amend line failed: ${JSON.stringify(amendRes.body)}`);
  });

  it('rejects direct POST to events with engineering stream', async () => {
    const eventRes = await makeRequest(port, 'POST', '/api/v1/events', {
      stream_type: 'engineering',
      stream_id: randomUUID(),
      event_type: 'bom.drafted',
      payload: {
        bom_id: randomUUID(),
        parent_item_id: parentItemId,
        revision_code: 'X',
        lines: [],
      },
      metadata: {
        correlation_id: randomUUID(),
        actor: { user_id: `engineer-${run}@test.com`, role: 'engineering_admin', location_id: '*' },
      },
    }, engineerHeaders);

    assert.strictEqual(eventRes.status, 400, 'Direct event POST should be rejected');
  });
});
