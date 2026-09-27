import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { provisionEmployeeBase, KNOWN_SKU } from '../fixtures/employee-base-stub';

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

// Story 1.15: the base screens populated, denied and offline, with the API stubbed so the audit
// covers the real cards rather than the first-sync fallback.
test('check stock with a result has no automated WCAG 2.1 AA violations and 44px controls', async ({
  page,
}) => {
  await provisionEmployeeBase(page);
  await page.goto('/stock');
  const field = page.getByLabel('Item code (SKU)');
  await field.fill(KNOWN_SKU);
  await page.getByRole('button', { name: 'Check' }).click();
  await expect(
    page.getByRole('region', { name: `${KNOWN_SKU} (PAIR)` }).getByRole('listitem'),
  ).toHaveCount(2);
  expect((await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze()).violations).toEqual([]);
  await field.focus();
  await expect(field).toHaveCSS('outline-style', 'solid');
  await expect(field).toHaveCSS('min-height', '48px');
  await expect(page.getByRole('button', { name: 'Check' })).toHaveCSS('min-height', '44px');
});

test('my requests populated has no automated WCAG 2.1 AA violations', async ({ page }) => {
  await provisionEmployeeBase(page, { indentCount: 3 });
  await page.goto('/requests');
  await expect(
    page.getByRole('region', { name: 'Requisitions' }).getByRole('listitem'),
  ).toHaveCount(3);
  expect((await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze()).violations).toEqual([]);
});

test('the no-access and needs-connection cards have no automated WCAG 2.1 AA violations', async ({
  page,
  context,
}) => {
  await provisionEmployeeBase(page, { navigation: ['Dashboard', 'Frontline'] });
  await page.goto('/requests');
  await expect(page.getByRole('link', { name: 'Go to home' })).toBeVisible();
  expect((await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze()).violations).toEqual([]);

  await provisionEmployeeBase(page);
  await page.goto('/requests');
  await expect(
    page
      .getByRole('navigation', { name: 'Primary navigation' })
      .getByRole('link', { name: 'My requests' }),
  ).toBeVisible();
  await expect(page.getByRole('region', { name: 'Requisitions' })).toBeVisible();
  await context.setOffline(true);
  await expect(page.getByRole('button', { name: 'Check connection' })).toBeVisible();
  expect((await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze()).violations).toEqual([]);
  await context.setOffline(false);
});
