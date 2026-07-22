import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

for (const path of ['/', '/first-sync', '/sync-error']) {
  test(`shell screen ${path} has no automated WCAG 2.1 AA violations`, async ({ page }) => {
    await page.goto(path);
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });
}

test('shell exposes synchronization status through the accessibility tree', async ({ page }) => {
  await page.goto('/sync-error');
  await expect(page.getByRole('status', { name: 'Synchronization status' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Capture Shell Test Event' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Primary navigation' })).toBeVisible();
});
