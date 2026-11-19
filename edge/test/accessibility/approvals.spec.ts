import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { INDENT_ID, provisionApprovals } from '../fixtures/approvals-stub';

// Story 4.12 (AC 8): zero WCAG 2.1 AA violations on the inbox and the detail, and a keyboard-only
// approve.

const DETAIL = `/approvals?indent=${INDENT_ID}`;

async function scan(page: Page, route: string) {
  await provisionApprovals(page);
  await page.goto(route);
  await expect(page.getByRole('main')).toBeVisible();
  // Scan the loaded screen, never the loading placeholder.
  await expect(
    route === DETAIL
      ? page.getByRole('button', { name: 'Approve' })
      : page.getByRole('button', { name: /IND-2026-0042/ }),
  ).toBeVisible();
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(results.violations).toEqual([]);
}

for (const route of ['/approvals', DETAIL]) {
  test(`axe: ${route} has no violations`, ({ page }) => scan(page, route));
}

test.describe('handheld', () => {
  test.use({ viewport: { width: 360, height: 640 }, hasTouch: true, isMobile: true });

  test('axe: the detail with the pinned footer has no violations', ({ page }) =>
    scan(page, DETAIL));
});

test('keyboard only: open the requisition and approve it', async ({ page }) => {
  await provisionApprovals(page);
  await page.goto('/approvals');
  const row = page.getByRole('button', { name: /IND-2026-0042/ });
  await row.focus();
  await page.keyboard.press('Enter');
  const approve = page.getByRole('button', { name: 'Approve' });
  await approve.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText(/Approved by you/)).toBeFocused();
});
