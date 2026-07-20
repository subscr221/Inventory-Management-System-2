import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test('shell has no automated WCAG 2.1 AA violations', async ({ page }) => {
  await page.goto('/');
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(results.violations).toEqual([]);
});

test('shell exposes synchronization status through the accessibility tree', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('status', { name: 'Synchronization status' })).toContainText(
    'Working offline - syncing when connected',
  );
  await expect(page.getByRole('button', { name: 'Capture Shell Test Event' })).toBeVisible();
});
