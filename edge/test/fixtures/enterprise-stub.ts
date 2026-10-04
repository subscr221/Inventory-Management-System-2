import type { Page } from '@playwright/test';

/**
 * Enterprise views (/workflows, /access-control, /reports) render through the EdgeClient, which
 * bootstraps before it shows any view. This stub answers bootstrap and the PowerSync credentials
 * call so the enterprise routes render their (in-EdgeClient) mock content instead of the
 * first-sync fallback. Data inside those views is in-memory mock data, so no further routes are
 * stubbed.
 */
export async function provisionEnterprise(page: Page) {
  await page.addInitScript(() => {
    const nativeFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith('/api/v1/edge/bootstrap')) {
        if (!navigator.onLine) throw new TypeError('offline');
        return new Response(
          JSON.stringify({
            user_id: '11111111-1111-4111-8111-111111111111',
            user_name: 'Asha Operations Lead',
            site_id: '55555555-5555-4555-8555-555555555555',
            site_name: 'CMF Aligarh',
            role: 'department_head',
            navigation: ['Dashboard', 'Frontline', 'Workflows', 'Access control', 'Reports'],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.endsWith('/api/v1/edge/powersync-credentials')) {
        return new Response(
          JSON.stringify({ endpoint: 'http://127.0.0.1:1', token: 'test-token' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.endsWith('/api/v1/edge/events')) {
        throw new TypeError('offline');
      }
      return nativeFetch(input, init);
    };
  });
}
