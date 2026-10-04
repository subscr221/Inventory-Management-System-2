import type { Page } from '@playwright/test';

/**
 * Story 1.15: the fetch stub behind the employee base screen specs, in the pattern of
 * refused-captures-stub.ts. Bootstrap, PowerSync credentials, the availability route and the
 * own-indent list are answered in the page. The RBAC itself is owned by
 * test/integration/story-1-15.test.ts; here each response only has to reach the person as copy.
 */
export const SITE_ID = '55555555-5555-4555-8555-555555555555';
export const USER_ID = '66666666-6666-4666-8666-666666666666';
export const KNOWN_SKU = 'GLOVE-NITRILE-M';
export const OUT_SKU = 'BOLT-M8-40';
export const BASE_NAVIGATION = [
  'Dashboard',
  'Frontline',
  'New requisition',
  'Check stock',
  'My requests',
];

export interface EmployeeBaseStubOptions {
  navigation?: string[];
  /** Number of own indents the list answers with (50 shows the truncation line). */
  indentCount?: number;
  /** 403 makes the indent list answer FUNCTION_ACCESS_DENIED. */
  indentStatus?: 200 | 403;
}

export async function provisionEmployeeBase(page: Page, options: EmployeeBaseStubOptions = {}) {
  const config = {
    navigation: options.navigation ?? BASE_NAVIGATION,
    indentCount: options.indentCount ?? 2,
    indentStatus: options.indentStatus ?? 200,
    siteId: SITE_ID,
    userId: USER_ID,
    knownSku: KNOWN_SKU,
    outSku: OUT_SKU,
  };
  await page.addInitScript((cfg) => {
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    const error = (status: number, error_code: string) =>
      json(
        { error_code, message: 'server message never shown', details: {}, trace_id: 'trace-1-15' },
        status,
      );
    const statuses = ['raised', 'approved', 'rejected', 'ordered'];
    const indents = Array.from({ length: cfg.indentCount }, (_, i) => ({
      indent_id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      indent_number_ext: `IND-2026-${String(100 - i).padStart(4, '0')}`,
      requester_user_id: cfg.userId,
      status: statuses[i % statuses.length],
      need_by_date: '2026-10-15',
      approver_actor_id: i === 0 ? '77777777-7777-4777-8777-777777777777' : null,
      created_at: new Date(Date.UTC(2026, 8, 27, 10, 0) - i * 3_600_000).toISOString(),
    }));

    const nativeFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith('/api/v1/edge/bootstrap')) {
        if (!navigator.onLine) throw new TypeError('offline');
        return json({
          user_id: cfg.userId,
          user_name: 'Arif Ansari',
          site_id: cfg.siteId,
          site_name: 'CMF Aligarh',
          role: 'employee',
          navigation: cfg.navigation,
        });
      }
      if (url.endsWith('/api/v1/edge/powersync-credentials')) {
        return json({ endpoint: 'http://127.0.0.1:1', token: 'test-token' });
      }
      const availability = /\/api\/v1\/stock\/([^/?]+)\/availability$/.exec(url);
      if (availability) {
        if (!navigator.onLine) throw new TypeError('offline');
        const sku = decodeURIComponent(availability[1]!);
        if (sku === cfg.knownSku) {
          return json({
            sku,
            uom: 'PAIR',
            in_stock: true,
            locations: [
              {
                location_id: '88888888-0000-4000-8000-000000000001',
                location_code: 'CMF-STORE-A1',
                in_stock: true,
              },
              {
                location_id: '88888888-0000-4000-8000-000000000002',
                location_code: 'CMF-STORE-B4',
                in_stock: false,
              },
            ],
          });
        }
        if (sku === cfg.outSku) {
          return json({
            sku,
            uom: 'EA',
            in_stock: false,
            locations: [
              {
                location_id: '88888888-0000-4000-8000-000000000003',
                location_code: 'CMF-STORE-C2',
                in_stock: false,
              },
            ],
          });
        }
        return error(404, 'ITEM_NOT_FOUND');
      }
      if (url.includes('/api/v1/indents?')) {
        if (!navigator.onLine) throw new TypeError('offline');
        if (cfg.indentStatus === 403) return error(403, 'FUNCTION_ACCESS_DENIED');
        // Code review 2026-09-27: honour limit like the real API does, so the truncation-boundary
        // fix (request limit+1, slice to limit) is actually exercised by this stub.
        const requestedLimit = Number(new URL(url, window.location.origin).searchParams.get('limit'));
        const limited = Number.isInteger(requestedLimit) && requestedLimit > 0
          ? indents.slice(0, requestedLimit)
          : indents;
        return json({ indents: limited });
      }
      // Story 8.9: My requests also lists the caller's damage reports; none for these specs.
      if (url.includes('/api/v1/damage-reports?')) {
        if (!navigator.onLine) throw new TypeError('offline');
        return json({ reports: [] });
      }
      if (url.endsWith('/api/v1/edge/events')) {
        throw new TypeError('offline');
      }
      return nativeFetch(input, init);
    };
  }, config);
}
