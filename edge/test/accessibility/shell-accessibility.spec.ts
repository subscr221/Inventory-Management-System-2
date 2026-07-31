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

test('cross-dock capture is keyboard operable with visible focus and 44px controls', async ({ page }) => {
  await page.goto('/');
  const taskInput = page.getByLabel('Cross-dock task ID');
  const loadButton = page.getByRole('button', { name: 'Load known task' });
  await taskInput.focus();
  await expect(taskInput).toBeFocused();
  await expect(taskInput).toHaveCSS('min-height', '44px');
  await expect(loadButton).toHaveCSS('min-height', '44px');
  await expect(taskInput).toHaveCSS('outline-style', 'solid');
});
