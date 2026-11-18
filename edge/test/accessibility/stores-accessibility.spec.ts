import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { provisionStores } from '../fixtures/stores-stub';

// Story 3.14 (AC 9): zero serious or critical axe violations on the inbox and acceptance screens.

for (const route of ['/stores', '/stores/accept?gate=99999999-9999-4999-8999-999999999991']) {
  test(`axe: ${route} has no serious or critical violations`, async ({ page }) => {
    await provisionStores(page);
    await page.goto(route);
    await expect(page.getByRole('main')).toBeVisible();
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });
}

// Code review 2026-11-19: the default render shows none of the conditional controls.
test('axe: acceptance with a short line, a damage reason and the inspect note open', async ({
  page,
}) => {
  await provisionStores(page);
  await page.goto('/stores/accept?gate=99999999-9999-4999-8999-999999999991');
  await page.getByLabel('Good', { exact: true }).fill('50');
  await page.getByLabel('Damaged', { exact: true }).fill('2');
  await page.getByLabel('Inspect on opening').check();
  await expect(page.getByText('Why is this line short?')).toBeVisible();
  await expect(page.getByLabel('Damage detail')).toBeVisible();
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(results.violations).toEqual([]);
});
