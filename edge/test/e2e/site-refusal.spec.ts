import { test, expect, type Page } from '@playwright/test';

// Found by the simulated pilot on staging 2026-09-23: an account with no concrete site got
// bootstrap 403 EDGE_NO_CONCRETE_SITE and the header showed a made-up "Raman Gate Officer" at
// "Pilot Gate Site" with "Waiting for first sync". The shell must say what is actually wrong.

async function refuseBootstrap(
  page: Page,
  status: number,
  code: string,
) {
  await page.addInitScript(
    ({ status, code }) => {
      const nativeFetch = window.fetch.bind(window);
      window.fetch = async (input, init) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.endsWith('/api/v1/edge/bootstrap')) {
          return new Response(JSON.stringify({ error_code: code, message: 'refused' }), {
            status,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (url.endsWith('/api/v1/edge/events')) throw new TypeError('offline');
        return nativeFetch(input, init);
      };
    },
    { status, code },
  );
}

test('an account with no site is told so, and no made-up person is shown', async ({ page }) => {
  await refuseBootstrap(page, 403, 'EDGE_NO_CONCRETE_SITE');
  await page.goto('/');
  await expect(
    page.getByRole('heading', { name: 'No site is assigned to your account.' }),
  ).toBeVisible();
  await expect(page.getByText('Raman Gate Officer')).toHaveCount(0);
  await expect(page.getByText('Pilot Gate Site')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Waiting for first sync.' })).toHaveCount(0);
});

test('an account on more than one site is told so', async ({ page }) => {
  await refuseBootstrap(page, 409, 'EDGE_AMBIGUOUS_SITE');
  await page.goto('/');
  await expect(
    page.getByRole('heading', { name: 'Your account is assigned to more than one site.' }),
  ).toBeVisible();
});
