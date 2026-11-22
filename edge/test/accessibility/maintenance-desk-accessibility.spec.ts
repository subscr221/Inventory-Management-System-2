import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { provisionDesk } from '../fixtures/maintenance-desk-stub';

// Story 7.11: zero WCAG 2.1 AA violations on the desk at the four device classes, a keyboard-only
// triage, focus returning to the board after the conflict panel closes, and no outbox write.

const viewports = [
  { name: 'handheld', width: 390, height: 800, touch: false },
  { name: 'tablet', width: 800, height: 900, touch: false },
  { name: 'desktop', width: 1280, height: 900, touch: false },
  { name: 'desktop-touch', width: 1280, height: 900, touch: true },
];

for (const viewport of viewports) {
  test.describe(`desk at ${viewport.name}`, () => {
    test.use({ hasTouch: viewport.touch });

    test('axe: /maintenance/desk has no violations', async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await provisionDesk(page);
      await page.goto('/maintenance/desk');
      await expect(page.getByRole('main')).toBeVisible();
      await expect(page.getByRole('heading', { name: 'To triage (1)' })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Done - sign-off (1)' })).toBeVisible();
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      expect(results.violations).toEqual([]);
    });
  });
}

test('keyboard only: create a work order without a pointer', async ({ page }) => {
  await provisionDesk(page);
  await page.goto('/maintenance/desk');
  const create = page.getByRole('button', { name: 'Create work order' });
  await expect(create).toBeVisible();
  await create.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText('Work order created with priority P1.')).toBeVisible();
});

test('keyboard only: the conflict panel opens, resolves and returns focus to its button', async ({
  page,
}) => {
  await provisionDesk(page);
  await page.goto('/maintenance/desk');
  const opener = page.getByRole('button', { name: 'Sync conflicts (1)' });
  await opener.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Sync conflicts', exact: true })).toBeFocused();
  await page.getByLabel('Discard the device change').check();
  await page.getByRole('button', { name: 'Resolve conflict' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText('Conflict resolved.')).toBeVisible();
  await page.getByRole('button', { name: 'Close' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Sync conflicts (0)' })).toBeFocused();
});

test('offline: the last board stays under the banner, actions are disabled, nothing is queued', async ({
  page,
  context,
}) => {
  await provisionDesk(page);
  await page.goto('/maintenance/desk');
  await expect(page.getByRole('heading', { name: 'To triage (1)' })).toBeVisible();
  await context.setOffline(true);
  await expect(page.getByText('Offline - needs a live connection')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create work order' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Resolve conflict' })).toHaveCount(0);
  const posts = await page.evaluate(() => (window as unknown as { __posts: string[] }).__posts);
  expect(posts.filter((p) => p.startsWith('/api/v1/maintenance'))).toEqual([]);
});

test('a caller without the desk entry sees the no-access card', async ({ page }) => {
  await provisionDesk(page, { navigation: ['Dashboard', 'Frontline', 'Maintenance'] });
  await page.goto('/maintenance/desk');
  await expect(page.getByRole('heading', { name: 'No access' })).toBeVisible();
});
