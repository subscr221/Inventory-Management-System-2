import type { Page } from '@playwright/test';

/**
 * Story 3.14: the fetch stub behind the stores inbox specs. The real authorization and contract
 * rules live in test/integration/story-3-14.test.ts; this only shapes the four reads and the PO.
 */
export const SITE_ID = '55555555-5555-4555-8555-555555555555';
export const STORES_NAVIGATION = ['Dashboard', 'Frontline', 'Stores', 'Stores issue'];
export const OPEN_GATE_ID = '99999999-9999-4999-8999-999999999991';
export const UNMATCHED_GATE_ID = '99999999-9999-4999-8999-999999999992';
export const PUTAWAY_TASK_ID = '77777777-7777-4777-8777-777777777771';
export const PUTAWAY_FROM_ID = '77777777-7777-4777-8777-777777777772';
export const PUTAWAY_BIN_ID = '77777777-7777-4777-8777-777777777773';
export const GRN_ID = '88888888-8888-4888-8888-888888888881';
export const GRN_LINE_ID = '88888888-8888-4888-8888-888888888882';

export interface StoresStubOptions {
  navigation?: string[];
  hasMaterialPhoto?: boolean;
  withPutaway?: boolean;
}

export async function provisionStores(page: Page, options: StoresStubOptions = {}) {
  const config = {
    navigation: options.navigation ?? STORES_NAVIGATION,
    withPutaway: options.withPutaway ?? false,
  };
  await page.addInitScript((cfg) => {
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    const nativeFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const path = new URL(url, window.location.origin);
      if (path.pathname === '/api/v1/edge/bootstrap') {
        return json({
          user_id: '66666666-6666-4666-8666-666666666666',
          user_name: 'Sam Storekeeper',
          site_id: '55555555-5555-4555-8555-555555555555',
          site_name: 'North Site',
          site_code_ext: 'site-A',
          gate_id: 'GATE-01',
          inspection_bay_code: 'IB-01',
          role: 'store_assistant',
          navigation: cfg.navigation,
        });
      }
      if (path.pathname === '/api/v1/edge/powersync-credentials') {
        return json({ endpoint: 'http://127.0.0.1:1', token: 'test-token' });
      }
      if (path.pathname === '/api/v1/receiving/arrivals') {
        return json({
          arrivals: [
            {
              gate_event_id: '99999999-9999-4999-8999-999999999992',
              challan_number_ext: 'CH-UNMATCHED',
              vehicle_reg_ext: 'KA01AB9999',
              driver_name: null,
              challan_photo_ref: 'photo-gate-2',
              entered_at: '2026-10-22T08:00:00.000Z',
              binding_status: 'unmatched',
              po_ref_ext: null,
              supplier_ref_ext: null,
              supplier_name_unlisted: null,
              supplier_unlisted: false,
              binding_token: '11111111-1111-4111-8111-111111111112',
              has_accepted_weighment: false,
              grn_id: null,
              po_summary: null,
            },
            {
              gate_event_id: '99999999-9999-4999-8999-999999999991',
              challan_number_ext: 'CH-OPEN',
              vehicle_reg_ext: 'KA01AB1234',
              driver_name: 'Ravi',
              challan_photo_ref: 'photo-gate-1',
              entered_at: '2026-10-22T09:00:00.000Z',
              binding_status: 'matched',
              po_ref_ext: 'PO-2026-01',
              supplier_ref_ext: 'SUP-1',
              supplier_name_unlisted: null,
              supplier_unlisted: false,
              binding_token: '11111111-1111-4111-8111-111111111111',
              has_accepted_weighment: true,
              grn_id: null,
              po_summary: { po_ref_ext: 'PO-2026-01', line_count: 1, open_qty: '90' },
            },
          ],
        });
      }
      if (path.pathname === '/api/v1/putaway-tasks') {
        return json({
          tasks: cfg.withPutaway
            ? [
                {
                  putaway_task_id: '77777777-7777-4777-8777-777777777771',
                  grn_line_id: '88888888-8888-4888-8888-888888888882',
                  sku: 'SKU-1',
                  lot_id: 'LOT-1',
                  quantity: '10.000',
                  from_location_id: '77777777-7777-4777-8777-777777777772',
                  site_id: '55555555-5555-4555-8555-555555555555',
                  status: 'ready',
                  directed_location_code: null,
                },
              ]
            : [],
        });
      }
      if (path.pathname === '/api/v1/putaway-tasks/77777777-7777-4777-8777-777777777771') {
        return json({
          task: {
            putaway_task_id: '77777777-7777-4777-8777-777777777771',
            grn_line_id: '88888888-8888-4888-8888-888888888882',
            sku: 'SKU-1',
            lot_id: 'LOT-1',
            quantity: '10.000',
            from_location_id: '77777777-7777-4777-8777-777777777772',
            site_id: '55555555-5555-4555-8555-555555555555',
            status: 'ready',
            directed_location_code: null,
          },
        });
      }
      if (
        path.pathname ===
        '/api/v1/putaway-tasks/77777777-7777-4777-8777-777777777771/suggestion'
      ) {
        return json({
          suggestion: {
            locationId: '77777777-7777-4777-8777-777777777773',
            locationCode: 'BIN-A-01',
            velocityClass: 'A',
          },
        });
      }
      if (
        path.pathname ===
        '/api/v1/putaway-tasks/77777777-7777-4777-8777-777777777771/complete'
      ) {
        return json({
          event_id: '99999999-9999-4999-8999-999999999999',
          task: {
            putaway_task_id: '77777777-7777-4777-8777-777777777771',
            status: 'completed',
            actual_location_code: 'BIN-A-01',
          },
        });
      }
      if (path.pathname.startsWith('/api/v1/locations/')) {
        return json({
          location_id: path.pathname.split('/').pop(),
          location_code: 'IB-01',
          level: 'zone',
          status: 'active',
        });
      }
      if (path.pathname === '/api/v1/grns/88888888-8888-4888-8888-888888888881') {
        return json({
          grn_id: '88888888-8888-4888-8888-888888888881',
          po_ref_ext: 'PO-2026-01',
          site_code_ext: 'site-A',
          status: 'posted',
          received_at: '2026-10-22T09:30:00.000Z',
          business_date: '2026-10-22',
          lines: [
            {
              grn_line_id: '88888888-8888-4888-8888-888888888882',
              po_ref_ext: 'PO-2026-01',
              line_no: 1,
              sku: 'SKU-1',
              lot_id: 'LOT-1',
              received_qty: '10.000',
              line_condition: 'GOOD',
            },
          ],
        });
      }
      if (path.pathname === '/api/v1/indents') return json({ indents: [] });
      if (path.pathname === '/api/v1/grns') return json({ grns: [] });
      if (path.pathname.startsWith('/api/v1/erp/purchase-orders/')) {
        return json({
          po_number_ext: 'PO-2026-01',
          supplier_ref_ext: 'SUP-1',
          currency: 'INR',
          status: 'open',
          lines: [
            {
              line_no: 1,
              sku: 'SKU-1',
              ordered_qty: 100,
              open_qty: 90,
              unit_price: 1,
              over_receipt_tolerance_pct: 10,
              under_receipt_tolerance_pct: 0,
            },
          ],
        });
      }
      if (path.pathname.startsWith('/api/v1/items/')) {
        return json({ item: { sku: 'SKU-1', uom: 'EA' } });
      }
      if (path.pathname.startsWith('/api/v1/lots/')) return json({ error: 'not_found' }, 404);
      return nativeFetch(input, init);
    };
  }, config);
}

export const PHOTO_FILE = {
  name: 'material.jpg',
  mimeType: 'image/jpeg',
  buffer: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
};
