import type { Page } from '@playwright/test';

/**
 * Story 3.18: the fetch stub behind the pack station list and dispatch specs. The real list/stage
 * derivation, the picked-lines read and the IRN wall live in test/integration/story-3-18; this only
 * shapes the bootstrap nav and the three reads the edge screen performs.
 */

export const PACK_SITE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
export const PACK_READY_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1';
export const PACK_BLOCKED_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2';
export const PACK_DISPATCHED_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3';
export const PACK_NAVIGATION = ['Dashboard', 'Frontline', 'Floor tasks', 'Pack and dispatch'];

export interface PackStubOptions {
  navigation?: string[];
  /** Empty list: no dispatch rows, so the empty state renders. */
  empty?: boolean;
}

interface DispatchRowStub {
  dispatch_order_id: string;
  so_number_ext: string;
  line_no: number;
  ship_to_ext: string | null;
  sku: string;
  quantity: string;
  picked_at: string;
  packed_at: string | null;
  dispatched_at: string | null;
  stage: string;
  irn_recorded: boolean;
}

function row(over: Partial<DispatchRowStub>): DispatchRowStub {
  return {
    dispatch_order_id: PACK_READY_ID,
    so_number_ext: 'SO-318-1',
    line_no: 1,
    ship_to_ext: 'Kisan Agro Equipments, Mathura',
    sku: 'SKU-P-1',
    quantity: '10',
    picked_at: '2026-11-20T08:00:00Z',
    packed_at: null,
    dispatched_at: null,
    stage: 'picked',
    irn_recorded: false,
    ...over,
  };
}

export async function provisionPack(page: Page, options: PackStubOptions = {}) {
  const config = {
    navigation: options.navigation ?? PACK_NAVIGATION,
    rows: options.empty
      ? []
      : [
          row({ dispatch_order_id: PACK_READY_ID, stage: 'picked' }),
          row({
            dispatch_order_id: PACK_BLOCKED_ID,
            so_number_ext: 'SO-318-2',
            stage: 'documents_generated',
            packed_at: '2026-11-20T09:00:00Z',
            irn_recorded: false,
          }),
          row({
            dispatch_order_id: PACK_DISPATCHED_ID,
            so_number_ext: 'SO-318-3',
            stage: 'dispatched',
            packed_at: '2026-11-20T09:00:00Z',
            dispatched_at: '2026-11-20T09:30:00Z',
            irn_recorded: true,
          }),
        ],
  };
  await page.addInitScript((cfg: typeof config) => {
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    const nativeFetch = window.fetch.bind(window);
    // The ready order's mutable flow state: packed -> documents -> irn -> dispatched.
    const ready = { packed: false, docs: false, irn: false, dispatched: false };
    window.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const path = new URL(url, window.location.origin);
      const method = init?.method ?? 'GET';
      const readyBase = '/api/v1/dispatch/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1';
      if (method === 'POST' && path.pathname === `${readyBase}/pack`) {
        ready.packed = true;
        return json({
          dispatchOrderId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1',
          packingRecords: [],
        });
      }
      if (method === 'POST' && path.pathname === `${readyBase}/generate-documents`) {
        ready.docs = true;
        return json({ dispatchOrderId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1', documents: [] });
      }
      if (method === 'POST' && path.pathname === `${readyBase}/irn`) {
        ready.irn = true;
        return json({ dispatchOrderId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1', coverage: {} });
      }
      if (method === 'POST' && path.pathname === `${readyBase}/dispatch`) {
        ready.dispatched = true;
        return json({ dispatchOrderId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1' });
      }
      if (path.pathname === `${readyBase}/documents` && method === 'GET') {
        return json({
          documents: ready.docs
            ? [
                {
                  document_id: 'ffffffff-ffff-4fff-8fff-ffffffffffff9',
                  dispatch_order_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1',
                  document_type: 'packing_slip',
                  document_content: 'PACKING SLIP SO-318-1',
                  generated_by: 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1',
                  generated_at: '2026-11-20T10:00:00Z',
                },
              ]
            : [],
        });
      }
      if (path.pathname === `${readyBase}/irn` && method === 'GET') {
        return ready.irn
          ? json({ dispatchOrderId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1', coverage: {} })
          : json({ error_code: 'DISPATCH_IRN_NOT_RECORDED' }, 404);
      }
      if (path.pathname === `${readyBase}/packing-records` && method === 'GET') {
        return json({ packingRecords: ready.packed ? [{}, {}] : [] });
      }
      if (path.pathname === '/api/v1/dispatch') {
        const rows = cfg.rows.map((r) =>
          r.dispatch_order_id === 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1'
            ? {
                ...r,
                stage: ready.dispatched
                  ? 'dispatched'
                  : ready.docs
                    ? 'documents_generated'
                    : ready.packed
                      ? 'packed'
                      : 'picked',
                packed_at: ready.packed ? '2026-11-20T09:30:00Z' : null,
                dispatched_at: ready.dispatched ? '2026-11-20T10:30:00Z' : null,
                irn_recorded: ready.irn,
              }
            : r,
        );
        return json({ dispatchOrders: rows });
      }
      if (path.pathname === '/api/v1/edge/bootstrap') {
        return json({
          user_id: 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1',
          user_name: 'Sanjay Mishra',
          site_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
          site_name: 'North Site',
          site_code_ext: 'site-A',
          gate_id: 'GATE-01',
          inspection_bay_code: 'IB-01',
          role: 'dispatch_clerk',
          navigation: cfg.navigation,
        });
      }
      if (path.pathname === '/api/v1/edge/powersync-credentials') {
        return json({ endpoint: 'http://127.0.0.1:1', token: 'test-token' });
      }
      if (path.pathname === '/api/v1/edge/events') {
        throw new TypeError('offline');
      }
      if (path.pathname === '/api/v1/dispatch/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1/picked-lines') {
        return json({
          dispatchOrderId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1',
          pickedLines: [
            {
              pick_line_id: 'dddddddd-dddd-4ddd-8ddd-ddddddddddd1',
              sku: 'SKU-P-1',
              confirmed_lot_id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1',
              confirmed_lot_number: 'L-P-1',
              confirmed_quantity: '6',
              uom: 'EA',
            },
            {
              pick_line_id: 'dddddddd-dddd-4ddd-8ddd-ddddddddddd2',
              sku: 'SKU-P-1',
              confirmed_lot_id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee2',
              confirmed_lot_number: 'L-P-2',
              confirmed_quantity: '4',
              uom: 'EA',
            },
          ],
        });
      }
      if (path.pathname === '/api/v1/dispatch/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2/picked-lines') {
        return json({ dispatchOrderId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2', pickedLines: [] });
      }
      if (path.pathname === '/api/v1/dispatch/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2/documents') {
        return json({
          documents: [
            {
              document_id: 'ffffffff-ffff-4fff-8fff-ffffffffffff1',
              dispatch_order_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2',
              document_type: 'commercial_invoice',
              document_content: 'TAX INVOICE SO-318-2',
              generated_by: 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1',
              generated_at: '2026-11-20T09:05:00Z',
            },
          ],
        });
      }
      if (
        path.pathname === '/api/v1/dispatch/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2/irn' &&
        method === 'GET'
      ) {
        return json({ error_code: 'DISPATCH_IRN_NOT_RECORDED' }, 404);
      }
      return nativeFetch(input, init);
    };
  }, config);
}
