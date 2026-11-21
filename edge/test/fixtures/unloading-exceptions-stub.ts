import type { Page } from '@playwright/test';

/**
 * Story 3.20: the fetch stub behind the unloading exceptions specs. The real merge, band and
 * command rules live in test/integration (Story 3.19); this shapes the bootstrap navigation, the
 * two list reads, the PO lookup and the three commands the edge screen performs.
 */

export const UNL_GATE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa01';
export const UNL_LINE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb01';
export const UNL_NAVIGATION = ['Dashboard', 'Frontline', 'Unloading exceptions'];

export interface UnloadingStubOptions {
  navigation?: string[];
  /** Both lists empty: the empty inbox state renders. */
  empty?: boolean;
  /** match-po answers 409 PO_NOT_OPEN. */
  matchRefused?: boolean;
}

export async function provisionUnloading(page: Page, options: UnloadingStubOptions = {}) {
  const config = {
    navigation: options.navigation ?? UNL_NAVIGATION,
    empty: options.empty ?? false,
    matchRefused: options.matchRefused ?? false,
    gateId: UNL_GATE_ID,
    lineId: UNL_LINE_ID,
    now: Date.now(),
  };
  await page.addInitScript((cfg: typeof config) => {
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    const nativeFetch = window.fetch.bind(window);
    const iso = (offsetMs: number) => new Date(cfg.now + offsetMs).toISOString();
    (window as unknown as { __posts: string[] }).__posts = [];
    const state = { gateResolved: false, lineResolved: false, sent: false };
    const gate = {
      gate_event_id: cfg.gateId,
      vehicle_reg_ext: 'UP 80 AB 1234',
      driver_name: 'Ramesh Kumar',
      challan_number_ext: 'CH-77',
      challan_photo_ref: 'photo-77.jpg',
      po_ref_ext: null,
      supplier_ref_ext: null,
      supplier_name_unlisted: 'Shree Traders',
      entered_at: '2026-11-22T08:05:00Z',
    };
    const overTolerance = (
      status: string,
      resolution: string | null,
      resolvedAt: string | null,
    ) => ({
      exception_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccc01',
      kind: 'over_tolerance',
      source_id: cfg.lineId,
      status,
      resolution,
      resolved_at: resolvedAt,
      po_ref_ext: 'PO-9',
      line_no: 1,
      sku: 'SKU-U-1',
      uom: 'EA',
      vehicle_reg_ext: null,
      ordered_qty: '100',
      already_received_qty: '90',
      tolerance_pct: '10',
      cap_qty: '20',
      counted_qty: '30',
      excess_qty: '10',
      created_at: '2026-11-22T07:40:00Z',
    });
    const resolvedRow = (id: string, resolvedAt: string) => ({
      ...overTolerance('resolved', 'matched_to_po', resolvedAt),
      exception_id: id,
      source_id: id,
      kind: 'unmatched_vehicle',
      po_ref_ext: id === 'dddddddd-dddd-4ddd-8ddd-dddddddddd01' ? 'PO-TODAY' : 'PO-YESTERDAY',
    });
    window.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const path = new URL(url, window.location.origin);
      const method = init?.method ?? 'GET';
      const name = path.pathname;
      if (method === 'POST') (window as unknown as { __posts: string[] }).__posts.push(name);
      if (name === '/api/v1/edge/bootstrap') {
        return json({
          user_id: 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1',
          user_name: 'Usha Supervisor',
          site_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
          site_name: 'North Site',
          site_code_ext: 'site-A',
          gate_id: 'GATE-01',
          inspection_bay_code: 'IB-01',
          role: 'unloading_supervisor',
          navigation: cfg.navigation,
        });
      }
      if (name === '/api/v1/edge/powersync-credentials') {
        return json({ endpoint: 'http://127.0.0.1:1', token: 'test-token' });
      }
      if (name === '/api/v1/edge/events') throw new TypeError('offline');
      if (name === '/api/v1/gate-events' && method === 'GET') {
        if (path.searchParams.get('site') !== 'site-A')
          return json({ error_code: 'INVALID_PARAMS' }, 400);
        const open = !cfg.empty && !state.gateResolved && !state.sent;
        return json({ gate_events: open ? [gate] : [] });
      }
      if (name === '/api/v1/receiving/exceptions') {
        if (path.searchParams.get('site') !== 'site-A')
          return json({ error_code: 'INVALID_PARAMS' }, 400);
        if (cfg.empty) return json({ exceptions: [] });
        const wanted = path.searchParams.get('status');
        const rows = [
          overTolerance(
            state.lineResolved ? 'resolved' : 'open',
            state.lineResolved ? 'accepted_within_band' : null,
            state.lineResolved ? iso(0) : null,
          ),
          resolvedRow('dddddddd-dddd-4ddd-8ddd-dddddddddd01', iso(0)),
          resolvedRow('dddddddd-dddd-4ddd-8ddd-dddddddddd02', iso(-3 * 24 * 3600 * 1000)),
        ];
        return json({ exceptions: rows.filter((row) => !wanted || row.status === wanted) });
      }
      if (name === `/api/v1/gate-events/${cfg.gateId}` && method === 'GET') return json(gate);
      if (name === '/api/v1/erp/purchase-orders/PO-1') {
        return json({
          po_number_ext: 'PO-1',
          supplier_ref_ext: 'SUP-1',
          expected_delivery_date: '2026-11-25',
          status: 'open',
          lines: [
            {
              line_no: 1,
              sku: 'SKU-U-1',
              ordered_qty: '100',
              open_qty: '40',
              over_receipt_tolerance_pct: '10',
            },
          ],
        });
      }
      if (name.startsWith('/api/v1/erp/purchase-orders/')) {
        return json({ error_code: 'NOT_FOUND' }, 404);
      }
      if (method === 'POST' && name === `/api/v1/gate-events/${cfg.gateId}/match-po`) {
        if (cfg.matchRefused) return json({ error_code: 'PO_NOT_OPEN' }, 409);
        state.gateResolved = true;
        return json({ gate_event: gate, exception: null });
      }
      if (method === 'POST' && name === `/api/v1/gate-events/${cfg.gateId}/send-to-procurement`) {
        state.sent = true;
        return json({ gate_event: gate, exception: null });
      }
      if (method === 'POST' && name === `/api/v1/grn-lines/${cfg.lineId}/accept-within-band`) {
        state.lineResolved = true;
        return json({ exception: null });
      }
      return nativeFetch(input, init);
    };
  }, config);
}
