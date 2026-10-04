import { expect, type Page } from '@playwright/test';

// Sync-state helpers shared by the staging specs. The frontline page (/) shows the
// outbox counters; every page shows the header badge.

export function syncBadge(page: Page) {
  return page.getByRole('banner').getByRole('status', { name: 'Synchronization status' });
}

function counter(page: Page, label: 'Pending sync' | 'Needs attention') {
  return page.locator('.sync-counts > div').filter({ has: page.locator('dt', { hasText: label }) }).locator('dd');
}

/** Go to the frontline page and wait until the outbox has drained with nothing refused. */
export async function expectOutboxDrained(page: Page, timeout = 45_000): Promise<void> {
  if (new URL(page.url()).pathname !== '/') await page.goto('/');
  await expect(counter(page, 'Pending sync')).toHaveText('0', { timeout });
  await expect(counter(page, 'Needs attention')).toHaveText('0');
  await expect(page.getByRole('heading', { name: 'Sync failed - needs attention' })).toHaveCount(0);
  await expect(syncBadge(page)).not.toContainText('Sync Error');
}
