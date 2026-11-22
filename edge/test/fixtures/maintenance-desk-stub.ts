import type { Page } from '@playwright/test';

/**
 * Story 7.11: the fetch stub behind the maintenance desk specs. The authority, DOA and state rules
 * live in test/integration (Stories 7.3 to 7.8 and 7.11); this shapes the bootstrap navigation and
 * the board reads and the four commands the desk performs.
 */

export const DESK_FAULT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa01';
export const DESK_WO_FLAGGED = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb01';
export const DESK_WO_DONE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb04';
export const DESK_CONFLICT_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccc01';
export const DESK_NAVIGATION = ['Dashboard', 'Frontline', 'Maintenance', 'Maintenance desk'];

export async function provisionDesk(page: Page, options: { navigation?: string[] } = {}) {
  const config = {
    navigation: options.navigation ?? DESK_NAVIGATION,
    faultId: DESK_FAULT_ID,
    flaggedId: DESK_WO_FLAGGED,
    doneId: DESK_WO_DONE,
    conflictId: DESK_CONFLICT_ID,
  };
  await page.addInitScript((cfg: typeof config) => {
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    const nativeFetch = window.fetch.bind(window);
    (window as unknown as { __posts: string[] }).__posts = [];
    const state = { accepted: false, overridden: false, returned: false, resolved: false };
    const workOrder = (id: string, status: string, extra: Record<string, unknown> = {}) => ({
      work_order_id: id,
      asset_id: `asset-${id}`,
      asset_tag: `TAG-${id.slice(-2)}`,
      status,
      priority: 'p2',
      warranty_flagged: false,
      status_note: null,
      fault_report_id: null,
      ...extra,
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
          user_name: 'Sam Supervisor',
          site_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
          site_name: 'North Site',
          site_code_ext: 'site-A',
          gate_id: 'GATE-01',
          inspection_bay_code: 'IB-01',
          role: 'maintenance_supervisor',
          navigation: cfg.navigation,
        });
      }
      if (name === '/api/v1/edge/powersync-credentials') {
        return json({ endpoint: 'http://127.0.0.1:1', token: 'test-token' });
      }
      if (name === '/api/v1/edge/events') throw new TypeError('offline');
      if (name === '/api/v1/maintenance/fault-reports' && method === 'GET') {
        return json({
          fault_reports: state.accepted
            ? []
            : [
                {
                  fault_report_id: cfg.faultId,
                  asset_id: 'asset-fault',
                  asset_tag: 'PRESS-01',
                  description: 'Hydraulic leak at the ram',
                  safety_flag: true,
                  status: 'reported',
                },
              ],
        });
      }
      if (name === '/api/v1/maintenance/work-orders' && method === 'GET') {
        const status = path.searchParams.get('status');
        const rows: Record<string, unknown>[] = [];
        if (status === 'open') {
          rows.push(workOrder(cfg.flaggedId, 'open', { warranty_flagged: true }));
        }
        if (status === 'in_progress')
          rows.push(workOrder('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb02', 'in_progress'));
        if (status === 'on_hold') {
          rows.push(
            workOrder('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb03', 'on_hold', {
              status_note: 'Waiting for seal kit',
            }),
          );
        }
        if (status === 'completed') rows.push(workOrder(cfg.doneId, 'completed'));
        return json({ work_orders: rows });
      }
      if (name === '/api/v1/maintenance/asset-status' && method === 'GET') {
        const status = path.searchParams.get('status');
        return json({
          asset_statuses:
            status === 'breakdown' && !state.returned
              ? [{ asset_id: `asset-${cfg.doneId}`, status: 'breakdown' }]
              : [],
        });
      }
      if (name === '/api/v1/maintenance/sync-conflicts' && method === 'GET') {
        return json({
          conflicts: state.resolved
            ? []
            : [
                {
                  conflict_id: cfg.conflictId,
                  stream_id: 'stream-1',
                  reason: 'version_conflict',
                  conflicting_event_type: 'maintenance.work_order_status_updated',
                  raised_at: '2026-11-22T08:05:00Z',
                },
              ],
        });
      }
      if (name === '/api/v1/maintenance/warranty-override-reason-codes') {
        return json({ reason_codes: ['REPAIR_IN_HOUSE', 'VENDOR_UNRESPONSIVE'] });
      }
      if (name === `/api/v1/maintenance/work-orders/${cfg.flaggedId}/warranty-overrides`) {
        if (method === 'POST') {
          state.overridden = true;
          return json({ override: null }, 201);
        }
        return json({
          override: state.overridden
            ? {
                reason_code: 'REPAIR_IN_HOUSE',
                overridden_by: 'sam',
                overridden_at: '2026-11-22T09:00:00Z',
              }
            : null,
        });
      }
      if (name.endsWith('/warranty-overrides')) return json({ override: null });
      if (method === 'POST' && name === `/api/v1/maintenance/fault-reports/${cfg.faultId}/accept`) {
        state.accepted = true;
        return json({ work_order: { priority: 'p1' } }, 201);
      }
      if (method === 'POST' && name === `/api/v1/maintenance/assets/asset-${cfg.doneId}/status`) {
        state.returned = true;
        return json({ status: { status: 'running' } });
      }
      if (
        method === 'POST' &&
        name === `/api/v1/maintenance/sync-conflicts/${cfg.conflictId}/resolve`
      ) {
        state.resolved = true;
        return json({ conflict: null });
      }
      return nativeFetch(input, init);
    };
  }, config);
}
