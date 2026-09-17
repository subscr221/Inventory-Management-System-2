import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { provisionRefusedCaptures } from '../fixtures/refused-captures-stub';

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

for (const path of ['/', '/first-sync', '/sync-error', '/supervisor/refused-captures']) {
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

// Story 1.14 (AC 4): the supervisor screen in its three states, with the API stubbed so the audit
// covers the populated cards and the open resolve form, not the first-sync fallback.
test('refused-captures screen with the resolve form open has no automated WCAG 2.1 AA violations', async ({ page }) => {
  await provisionRefusedCaptures(page);
  await page.goto('/supervisor/refused-captures');
  const open = page.getByRole('region', { name: 'Open refusals' });
  await expect(open.getByRole('listitem')).toHaveCount(2);
  await open.getByRole('button', { name: 'Resolve' }).first().click();
  const note = page.getByLabel('Resolution note');
  await expect(note).toBeFocused();
  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  expect(results.violations).toEqual([]);
  await expect(note).toHaveCSS('outline-style', 'solid');
  for (const name of ['Confirm resolve', 'Cancel', 'Resolve']) {
    await expect(page.getByRole('button', { name, exact: true }).first()).toHaveCSS('min-height', '44px');
  }
});

test('refused-captures no-access and needs-connection cards have no automated WCAG 2.1 AA violations', async ({
  page,
  context,
}) => {
  await provisionRefusedCaptures(page, { listStatus: 403 });
  await page.goto('/supervisor/refused-captures');
  await expect(page.getByText('Your role does not cover refused captures at this site.')).toBeVisible();
  expect((await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze()).violations).toEqual([]);

  await context.setOffline(true);
  await expect(page.getByRole('button', { name: 'Check connection' })).toBeVisible();
  expect((await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze()).violations).toEqual([]);
  await page.getByRole('button', { name: 'Check connection' }).focus();
  await expect(page.getByRole('button', { name: 'Check connection' })).toHaveCSS('outline-style', 'solid');
  await expect(page.getByRole('button', { name: 'Check connection' })).toHaveCSS('min-height', '44px');
  await context.setOffline(false);
});
