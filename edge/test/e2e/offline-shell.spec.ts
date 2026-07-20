import { test, expect, type Page } from '@playwright/test';

async function provision(page: Page) {
  await page.addInitScript(() => {
    const nativeFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith('/api/v1/edge/bootstrap')) {
        if (!navigator.onLine) throw new TypeError('offline');
        return new Response(
          JSON.stringify({
            user_id: '11111111-1111-4111-8111-111111111111',
            user_name: 'Asha Offline Officer',
            site_id: '55555555-5555-4555-8555-555555555555',
            site_name: 'North Gate',
            role: 'gate_officer',
            navigation: ['Dashboard', 'Frontline'],
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
      return nativeFetch(input, init);
    };
  });
}

test('installed shell loads offline with cached user and site context', async ({
  page,
  context,
}) => {
  await provision(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Inventory Edge Shell' })).toBeVisible();
  await expect(page.getByText('Asha Offline Officer')).toBeVisible();
  await expect(page.getByText('North Gate')).toBeVisible();
  await page.waitForFunction(async () => {
    await navigator.serviceWorker.ready;
    return navigator.serviceWorker.controller !== null;
  });
  await page.reload();

  await context.setOffline(true);
  const start = Date.now();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'Inventory Edge Shell' })).toBeVisible();
  await expect(page.getByText('Asha Offline Officer')).toBeVisible();
  await expect(page.getByText('North Gate')).toBeVisible();
  expect(Date.now() - start).toBeLessThan(5000);
  await context.setOffline(false);
});

test('test capture inserts locally and updates pending state', async ({ page }) => {
  await provision(page);
  await page.goto('/');
  await expect(page.getByRole('navigation', { name: 'Primary navigation' })).toBeVisible();
  await page.getByRole('button', { name: 'Capture Shell Test Event' }).click();
  await expect(page.getByText('Pending sync').locator('..').getByRole('definition')).toHaveText('1');
  await expect(page.getByRole('status', { name: 'Synchronization status' })).toContainText(
    'Captured - pending sync',
  );
});

test('keyboard navigation reaches role navigation and capture action', async ({ page }) => {
  await provision(page);
  await page.goto('/');
  await expect(page.getByRole('navigation', { name: 'Primary navigation' })).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(page.getByText('Skip to content')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Dashboard' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Frontline' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Capture Shell Test Event' })).toBeFocused();
});

test('never-provisioned device shows first sync state', async ({ page }) => {
  await page.goto('/first-sync');
  await expect(page.getByRole('heading', { name: 'Waiting for first sync.' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Check Connection' })).toBeVisible();
});

test('failure inspection and retry are keyboard operable', async ({ page }) => {
  await page.goto('/sync-error');
  await expect(page.getByRole('status', { name: 'Synchronization status' })).toContainText(
    'Sync Error',
  );
  await expect(page.getByRole('heading', { name: 'Sync failed - needs attention' })).toBeVisible();
  await expect(page.getByText('UNTAGGED_TRANSACTION')).toBeVisible();
  await page.getByRole('button', { name: 'Retry Sync' }).focus();
  await expect(page.getByRole('button', { name: 'Retry Sync' })).toBeFocused();
  await page.keyboard.press('Enter');
});
