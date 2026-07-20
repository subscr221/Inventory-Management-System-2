import { test, expect } from '@playwright/test';

test('installed shell loads offline with cached user and site context', async ({
  page,
  context,
}) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Inventory Edge Shell' })).toBeVisible();
  await expect(page.getByText('Raman Gate Officer')).toBeVisible();
  await expect(page.getByText('Pilot Gate Site')).toBeVisible();
  await expect(page.getByRole('status', { name: 'Synchronization status' })).toContainText(
    'Working offline - syncing when connected',
  );

  await page.evaluate(async () => {
    await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;
  });
  await page.reload();
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);

  await context.setOffline(true);
  const start = Date.now();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'Inventory Edge Shell' })).toBeVisible();
  expect(Date.now() - start).toBeLessThan(5000);
  await context.setOffline(false);
});

test('keyboard navigation reaches skip link and capture action', async ({ page }) => {
  await page.goto('/');
  await page.keyboard.press('Tab');
  await expect(page.getByText('Skip to content')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Capture Shell Test Event' })).toBeFocused();
});

test('never-provisioned device shows first sync state', async ({ page }) => {
  await page.goto('/first-sync');
  await expect(page.getByRole('heading', { name: 'Waiting for first sync.' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Check Connection' })).toBeVisible();
});

test('permanent sync failures are visible and outside the pending success path', async ({
  page,
}) => {
  await page.goto('/sync-error');
  await expect(page.getByRole('status', { name: 'Synchronization status' })).toContainText(
    'Sync Error',
  );
  await expect(page.getByRole('heading', { name: 'Sync failed - needs attention' })).toBeVisible();
  await expect(page.getByText('UNTAGGED_TRANSACTION')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry Sync' })).toBeVisible();
});
