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
      if (url.includes('/api/v1/cross-dock-tasks/') && (!init?.method || init.method === 'GET')) {
        return new Response(
          JSON.stringify({
            task: {
              cross_dock_task_id: '11111111-1111-4111-8111-111111111111',
              grn_line_id: '22222222-2222-4222-8222-222222222222',
              grn_line_no: 1,
              po_ref_ext: 'GRN-2026-0042',
              sku: 'SKU-EDGE-01',
              lot_number: 'LOT-EDGE-01',
              quantity: '10.000',
              uom: 'EA',
              dispatch_order_line_id: '33333333-3333-4333-8333-333333333333',
              sales_order_number: 'SO-2026-0091',
              sales_order_line_no: 1,
              staging_zone_id: '44444444-4444-4444-8444-444444444444',
              staging_zone_code: 'OUTBOUND-STAGING',
              correlation_id: '55555555-5555-4555-8555-555555555555',
            },
          }),
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
  // Wait for bootstrap to finish before Tab-ing: the shell renders the user and site names in the
  // same setState that populates userId/siteId, so once they are visible the shell (and the capture
  // action later in the tab order) is ready. Tab-ing during hydration was the CI flake.
  await expect(page.getByText('Asha Offline Officer')).toBeVisible();
  await expect(page.getByText('North Gate')).toBeVisible();
  // The frontline shell deliberately auto-focuses the indent SKU field on load, so a bare first
  // Tab would start past the skip-link and nav. Establish focus at the document top (the skip-link
  // is the first focusable element) before walking the tab order forward, so the assertions read a
  // deterministic sequence regardless of the autofocus.
  await page.getByText('Skip to content').focus();
  await expect(page.getByText('Skip to content')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Dashboard' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Frontline' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByLabel('Cross-dock task ID')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Load known task' })).toBeFocused();
  // The frontline view stacks several capture forms (cross-dock, then indent with seven inputs)
  // ahead of the test-capture button, so the number of Tabs to reach it is not a fixed constant.
  // Tab forward until the button is reached, proving it is keyboard-reachable in order, but cap the
  // walk so a regression fails loudly instead of hanging.
  const captureButton = page.getByRole('button', { name: 'Capture Shell Test Event' });
  await expect(async () => {
    for (let i = 0; i < 20; i++) {
      if (await captureButton.evaluate((el) => el === document.activeElement)) return;
      await page.keyboard.press('Tab');
    }
    throw new Error('Capture Shell Test Event was not reached within 20 Tabs');
  }).toPass();
  await expect(captureButton).toBeFocused();
});

test('known cross-dock task capture displays context and scan-first pending result', async ({ page }) => {
  await provision(page);
  await page.goto('/');
  await expect(page.getByRole('navigation', { name: 'Primary navigation' })).toBeVisible();
  // Wait for bootstrap to finish before capturing: confirmCrossDock guards on userId/siteId, which
  // are populated in the same setState that renders the user and site names. Acting before that
  // state lands was the CI flake ("Database or authentication state not available").
  await expect(page.getByText('Asha Offline Officer')).toBeVisible();
  await expect(page.getByText('North Gate')).toBeVisible();
  await page.getByLabel('Cross-dock task ID').focus();
  await expect(page.getByLabel('Cross-dock task ID')).toBeFocused();
  await page.getByLabel('Cross-dock task ID').fill('11111111-1111-4111-8111-111111111111');
  await page.getByRole('button', { name: 'Load known task' }).click();
  await expect(page.getByText('22222222-2222-4222-8222-222222222222 / 1')).toBeVisible();
  await expect(page.getByText('SKU-EDGE-01')).toBeVisible();
  await expect(page.getByText('LOT-EDGE-01')).toBeVisible();
  await expect(page.getByText('10.000 EA')).toBeVisible();
  await expect(page.getByText('SO-2026-0091 / 1')).toBeVisible();
  await expect(page.getByText('OUTBOUND-STAGING')).toBeVisible();
  await expect(page.getByText('Cross-dock task duration')).toBeVisible();
  await expect(page.getByText('Receipt confirmation to staging confirmation')).toBeVisible();
  await expect(page.getByLabel('Scan staging bin')).toBeFocused();
  await page.getByLabel('Scan staging bin').fill('STAGE-BIN-01');
  await page.getByRole('button', { name: 'Confirm staging' }).click();
  await expect(page.getByRole('status', { name: 'Cross-dock capture result' })).toContainText('pending sync');
  await expect(page.getByRole('status', { name: 'Cross-dock capture result' })).toContainText('STAGE-BIN-01');
  await expect(page.getByRole('status', { name: 'Synchronization status' })).toBeVisible();
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
