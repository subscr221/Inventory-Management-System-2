import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { provisionEnterprise } from '../fixtures/enterprise-stub';

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

for (const path of ['/dashboard', '/workflows', '/access-control', '/reports']) {
  test(`enterprise screen ${path} has no automated WCAG 2.1 AA violations`, async ({ page }) => {
    await provisionEnterprise(page);
    await page.goto(path);
    // Wait for bootstrap so the view (not the first-sync fallback) has rendered.
    await expect(page.getByText('Asha Operations Lead')).toBeVisible();
    const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
    expect(results.violations).toEqual([]);
  });
}

test('global search dialog is keyboard operable and exposes an accessible dialog', async ({ page }) => {
  await provisionEnterprise(page);
  await page.goto('/');
  await expect(page.getByText('Asha Operations Lead')).toBeVisible();

  await page.getByRole('button', { name: 'Open search' }).click();
  const dialog = page.getByRole('dialog', { name: 'Search' });
  await expect(dialog).toBeVisible();
  await expect(page.getByLabel('Search the application')).toBeFocused();

  await page.keyboard.type('work');
  await expect(page.getByRole('button', { name: 'Workflows' })).toBeVisible();

  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  expect(results.violations).toEqual([]);
});

test('global search opens on Ctrl+K and closes on Escape', async ({ page }) => {
  await provisionEnterprise(page);
  await page.goto('/');
  await expect(page.getByText('Asha Operations Lead')).toBeVisible();

  await page.keyboard.press('Control+k');
  await expect(page.getByRole('dialog', { name: 'Search' })).toBeVisible();
  await expect(page.getByLabel('Search the application')).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Search' })).toBeHidden();
});
