import type { Page } from '@playwright/test';

/**
 * Story 3.16: the fetch stub behind the floor task inbox and pick-line specs. The real
 * authorization, read-contract and inline-finalization rules live in test/integration/story-3-16
 * and story-3-6; this only shapes the two list reads, the task detail and the bootstrap nav.
 */
export const FLOOR_SITE_ID = '66666666-6666-4666-8666-666666666661';
export const FLOOR_USER_ID = '66666666-6666-4666-8666-666666666662';
export const TASK_ID = '77777777-7777-4777-8777-777777777781';
export const TASK_ID_2 = '77777777-7777-4777-8777-777777777782';
export const BIN_CODE = 'BIN-F-01';
export const LOT_CODE = 'LOT-F-01';
export const FLOOR_NAVIGATION = ['Dashboard', 'Frontline', 'Floor tasks'];

export interface FloorStubOptions {
  navigation?: string[];
  /** null hides the task from both status lists (empty inbox). */
  task?: 'one-line' | 'two-line' | null;
}

export async function provisionFloor(page: Page, options: FloorStubOptions = {}) {
  const config = {
    navigation: options.navigation ?? FLOOR_NAVIGATION,
    task: options.task === undefined ? 'one-line' : options.task,
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
          user_id: '66666666-6666-4666-8666-666666666662',
          user_name: 'Pavi Picker',
          site_id: '66666666-6666-4666-8666-666666666661',
          site_name: 'North Site',
          site_code_ext: 'site-A',
          gate_id: 'GATE-01',
          inspection_bay_code: 'IB-01',
          role: 'warehouse_operator',
          navigation: cfg.navigation,
        });
      }
      if (path.pathname === '/api/v1/edge/powersync-credentials') {
        return json({ endpoint: 'http://127.0.0.1:1', token: 'test-token' });
      }
      if (path.pathname === '/api/v1/edge/events') throw new TypeError('offline');
      if (path.pathname === '/api/v1/pick-tasks') {
        const status = path.searchParams.get('status');
        if (cfg.task === null) return json({ pick_tasks: [] });
        const base = (id: string, so: string, picked: number, total: number) => ({
          pick_task_id: id,
          dispatch_order_id: 'order-1',
          so_number_ext: so,
          status: picked === 0 ? 'pending' : 'in_progress',
          assigned_to: '66666666-6666-4666-8666-666666666662',
          confirmed_line_count: picked,
          line_count: total,
        });
        const rows =
          status === 'pending'
            ? [base('77777777-7777-4777-8777-777777777781', 'SO-316-1', 0, 1)]
            : [];
        return json({ pick_tasks: rows });
      }
      if (path.pathname === `/api/v1/pick-tasks/${'77777777-7777-4777-8777-777777777781'}`) {
        return json({
          task: {
            pick_task_id: '77777777-7777-4777-8777-777777777781',
            dispatch_order_id: 'order-1',
            sku: 'SKU-F-1',
            status: 'pending',
            so_number_ext: 'SO-316-1',
          },
          lines: [
            {
              pick_line_id: '88888888-8888-4888-8888-888888888891',
              pick_task_id: '77777777-7777-4777-8777-777777777781',
              dispatch_order_line_id: '88888888-8888-4888-8888-888888888892',
              sku: 'SKU-F-1',
              directed_lot_id: '99999999-9999-4999-8999-999999999991',
              confirmed_lot_id: null,
              directed_quantity: '10.000',
              confirmed_quantity: null,
              location_id: '99999999-9999-4999-8999-999999999992',
              pick_sequence: 1,
              status: 'pending',
              capture_method: null,
              location_code: 'BIN-F-01',
              directed_lot_number: 'LOT-F-01',
              uom: 'EA',
            },
          ],
        });
      }
      return nativeFetch(input, init);
    };
  }, config);
}
