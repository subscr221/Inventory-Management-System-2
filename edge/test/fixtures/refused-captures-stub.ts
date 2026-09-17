import type { Page } from '@playwright/test';

/**
 * Story 1.14: the fetch stub behind the refused-captures e2e and accessibility specs, in the
 * pattern of test/e2e/offline-shell.spec.ts. Bootstrap, PowerSync credentials and the three Story
 * 1.13 routes are answered in the page; the list state is kept in the page so a resolve moves the
 * row from the open list to the resolved list exactly as the server would.
 */
export const SITE_ID = '55555555-5555-4555-8555-555555555555';
export const USER_ID = '11111111-1111-4111-8111-111111111111';
export const TECHNICIAN_ID = '22222222-2222-4222-8222-222222222222';
export const NEWEST_REFUSAL_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const OLDER_REFUSAL_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
export const RESOLVED_REFUSAL_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

export interface RefusedCapturesStubOptions {
  /** The bootstrap `navigation` array; the default advertises the screen. */
  navigation?: string[];
  /** 403 makes every list call answer MODULE_ACCESS_DENIED. */
  listStatus?: 200 | 403;
  /** When set, every resolve answers this error envelope instead of resolving. */
  resolveError?: { status: number; error_code: string; details?: Record<string, unknown> };
}

export async function provisionRefusedCaptures(page: Page, options: RefusedCapturesStubOptions = {}) {
  const config = {
    navigation: options.navigation ?? ['Dashboard', 'Frontline', 'Refused captures'],
    listStatus: options.listStatus ?? 200,
    resolveError: options.resolveError ?? null,
    siteId: SITE_ID,
    userId: USER_ID,
    technicianId: TECHNICIAN_ID,
    newestId: NEWEST_REFUSAL_ID,
    olderId: OLDER_REFUSAL_ID,
    resolvedId: RESOLVED_REFUSAL_ID,
  };
  await page.addInitScript((cfg) => {
    interface Row {
      refusal_id: string;
      event_id: string;
      stream_type: string;
      event_type: string | null;
      device_id: string | null;
      captured_by: string;
      captured_role: string | null;
      location_id: string | null;
      error_code: string;
      refused_at: string;
      status: 'open' | 'resolved';
      resolved_by: string | null;
      resolved_at: string | null;
      resolution_note: string | null;
    }
    const state: { open: Row[]; resolved: Row[] } = {
      open: [
        {
          refusal_id: cfg.newestId,
          event_id: '11111111-aaaa-4aaa-8aaa-111111111111',
          stream_type: 'maintenance',
          event_type: 'maintenance.fault_reported',
          device_id: 'TABLET-07',
          captured_by: cfg.technicianId,
          captured_role: 'maintenance_technician',
          location_id: cfg.siteId,
          error_code: 'ASSET_NOT_FOUND',
          refused_at: '2026-09-17T06:52:00.000Z',
          status: 'open',
          resolved_by: null,
          resolved_at: null,
          resolution_note: null,
        },
        {
          refusal_id: cfg.olderId,
          event_id: '22222222-bbbb-4bbb-8bbb-222222222222',
          stream_type: 'inventory',
          event_type: 'stock.moved',
          device_id: 'TABLET-03',
          captured_by: cfg.technicianId,
          captured_role: null,
          location_id: cfg.siteId,
          error_code: 'MODULE_ACCESS_DENIED',
          refused_at: '2026-09-16T10:15:00.000Z',
          status: 'open',
          resolved_by: null,
          resolved_at: null,
          resolution_note: null,
        },
      ],
      resolved: [
        {
          refusal_id: cfg.resolvedId,
          event_id: '33333333-cccc-4ccc-8ccc-333333333333',
          stream_type: 'maintenance',
          event_type: 'maintenance.meter_reading_recorded',
          device_id: 'TABLET-07',
          captured_by: cfg.technicianId,
          captured_role: 'maintenance_technician',
          location_id: cfg.siteId,
          error_code: 'METER_NOT_FOUND',
          refused_at: '2026-09-16T08:00:00.000Z',
          status: 'resolved',
          resolved_by: cfg.userId,
          resolved_at: '2026-09-16T12:00:00.000Z',
          resolution_note: 'Meter re-registered; technician re-captured the reading.',
        },
      ],
    };
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    const error = (status: number, error_code: string, details: Record<string, unknown> = {}) =>
      json({ error_code, message: 'server message never shown', details, trace_id: 'trace-1-14' }, status);

    const nativeFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith('/api/v1/edge/bootstrap')) {
        if (!navigator.onLine) throw new TypeError('offline');
        return json({
          user_id: cfg.userId,
          user_name: 'Priya Site Supervisor',
          site_id: cfg.siteId,
          site_name: 'CMF Aligarh',
          role: 'department_head',
          navigation: cfg.navigation,
        });
      }
      if (url.endsWith('/api/v1/edge/powersync-credentials')) {
        return json({ endpoint: 'http://127.0.0.1:1', token: 'test-token' });
      }
      if (url.includes('/api/v1/edge/refused-captures')) {
        if (!navigator.onLine) throw new TypeError('offline');
        if (cfg.listStatus === 403) return error(403, 'MODULE_ACCESS_DENIED');
        const resolveMatch = /refused-captures\/([^/?]+)\/resolve$/.exec(url);
        if (resolveMatch && init?.method === 'POST') {
          const refusalId = decodeURIComponent(resolveMatch[1]!);
          const row = state.open.find((candidate) => candidate.refusal_id === refusalId);
          if (cfg.resolveError) {
            const details = cfg.resolveError.details ?? {};
            // As on the server: an already-resolved refusal IS resolved, so later list calls say so.
            if (row && cfg.resolveError.error_code === 'REFUSED_CAPTURE_ALREADY_RESOLVED') {
              state.open = state.open.filter((candidate) => candidate.refusal_id !== refusalId);
              state.resolved = [
                {
                  ...row,
                  status: 'resolved',
                  resolved_by: typeof details['resolved_by'] === 'string' ? details['resolved_by'] : null,
                  resolved_at: typeof details['resolved_at'] === 'string' ? details['resolved_at'] : null,
                  resolution_note: 'Resolved on another device.',
                },
                ...state.resolved,
              ];
            }
            return error(cfg.resolveError.status, cfg.resolveError.error_code, details);
          }
          if (!row) return error(404, 'REFUSED_CAPTURE_NOT_FOUND', { refusal_id: refusalId });
          const body = JSON.parse(String(init.body)) as { note?: string };
          const resolved: Row = {
            ...row,
            status: 'resolved',
            resolved_by: cfg.userId,
            resolved_at: '2026-09-17T07:30:00.000Z',
            resolution_note: body.note ?? null,
          };
          state.open = state.open.filter((candidate) => candidate.refusal_id !== refusalId);
          state.resolved = [resolved, ...state.resolved];
          return json({ event_id: '44444444-dddd-4ddd-8ddd-444444444444', refusal: resolved });
        }
        const parsed = new URL(url, window.location.origin);
        if (parsed.searchParams.get('location_id') !== cfg.siteId) return json({ refusals: [] });
        const status = parsed.searchParams.get('status') ?? 'open';
        return json({ refusals: status === 'resolved' ? state.resolved : state.open });
      }
      if (url.endsWith('/api/v1/edge/events')) {
        throw new TypeError('offline');
      }
      return nativeFetch(input, init);
    };
  }, config);
}
