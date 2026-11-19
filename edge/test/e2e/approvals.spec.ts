import { test, expect, type Page } from '@playwright/test';
import {
  INDENT_ID,
  INDENT_ID_2,
  LINE_PENDING,
  provisionApprovals,
} from '../fixtures/approvals-stub';

// Story 4.12 (AC 4 to AC 8): the approvals inbox and requisition approval detail.

const posts = (page: Page) =>
  page.evaluate(() => (window as unknown as { __approvalPosts: unknown[] }).__approvalPosts);

test('desktop: the table lists the waiting requisition and the detail approves it', async ({
  page,
}) => {
  await provisionApprovals(page);
  await page.goto('/approvals');
  await expect(
    page.getByText('Your DOA band as head of department: up to Rs 1,00,000'),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Waiting 1' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  const table = page.getByRole('table', { name: 'Approvals for head of department' });
  await expect(table.getByRole('columnheader', { name: 'Requested by' })).toBeVisible();
  await expect(table.getByRole('cell', { name: 'Maint One' })).toBeVisible();
  await expect(page.getByText('Pick an approval from the list')).toBeVisible();

  await table.getByRole('button', { name: /IND-2026-0042/ }).click();
  await expect(page).toHaveURL(new RegExp(`indent=${INDENT_ID}`));
  const detail = page.getByRole('region', { name: 'Approval detail' });
  await expect(detail.getByRole('note')).toHaveText(
    "Routed to you as the requester's head of department by value band (up to Rs 1,00,000)",
  );
  await expect(
    detail.getByText('Standing approval SA-2026-004 - 4 of 6 used this month'),
  ).toBeVisible();
  await expect(detail.getByText('Head of department approval')).toBeVisible();
  await expect(detail.getByText('Waiting for you')).toBeVisible();
  await expect(detail.getByRole('rowheader', { name: 'Total' })).toBeVisible();

  await detail.getByRole('button', { name: 'Approve' }).click();
  await expect(detail.getByText(/Approved by you, .*Maint One has been notified\./)).toBeVisible();
  await expect(detail.getByRole('button', { name: 'Approve' })).toHaveCount(0);
  expect(await posts(page)).toEqual([{ action: 'approve', body: { line_ids: [LINE_PENDING] } }]);
  await expect(page.getByRole('button', { name: 'Decided 1' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Waiting 0' })).toBeVisible();
});

test('reject needs a reason: Confirm reject stays disabled until text, Cancel restores', async ({
  page,
}) => {
  await provisionApprovals(page);
  await page.goto(`/approvals?indent=${INDENT_ID}`);
  const detail = page.getByRole('region', { name: 'Approval detail' });
  await detail.getByRole('button', { name: 'Reject' }).click();
  const confirm = detail.getByRole('button', { name: 'Confirm reject' });
  await expect(confirm).toBeDisabled();
  await expect(detail.getByText('Required before you can reject.')).toBeVisible();
  await detail.getByRole('button', { name: 'Cancel' }).click();
  await expect(detail.getByRole('button', { name: 'Approve' })).toBeVisible();

  await detail.getByRole('button', { name: 'Reject' }).click();
  await detail
    .getByLabel('Reason for rejection (required, sent to the requester)')
    .fill('Use stock on hand ($& spare)');
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await expect(
    // `$&` is a String.replace pattern; the typed reason must come back untouched.
    detail.getByText(
      /Rejected by you, .*Reason sent to Maint One: "Use stock on hand \(\$& spare\)"/,
    ),
  ).toBeVisible();
  expect(await posts(page)).toEqual([
    {
      action: 'reject',
      body: { line_ids: [LINE_PENDING], rejection_reason: 'Use stock on hand ($& spare)' },
    },
  ]);
});

test('a 409 shows the error text and reloads the detail', async ({ page }) => {
  await provisionApprovals(page, { conflictFirst: true });
  await page.goto(`/approvals?indent=${INDENT_ID}`);
  const detail = page.getByRole('region', { name: 'Approval detail' });
  await detail.getByRole('button', { name: 'Approve' }).click();
  await expect(detail.getByRole('alert')).toContainText('already been approved or rejected');
  await expect(detail.getByRole('button', { name: 'Approve' })).toBeEnabled();
});

test('a decision answered after another requisition was picked paints nothing on the new one', async ({
  page,
}) => {
  await provisionApprovals(page, { second: true, decisionDelayMs: 600 });
  await page.goto('/approvals');
  await page.getByRole('button', { name: /IND-2026-0042/ }).click();
  const detail = page.getByRole('region', { name: 'Approval detail' });
  await detail.getByRole('button', { name: 'Approve' }).click();
  await page.getByRole('button', { name: /IND-2026-0043/ }).click();
  await expect(page).toHaveURL(new RegExp(`indent=${INDENT_ID_2}`));
  // The delayed answer lands now: the lists refresh, the open requisition is left alone.
  await expect(page.getByRole('button', { name: 'Decided 1' })).toBeVisible();
  await expect(detail.getByText(/Approved by you/)).toHaveCount(0);
  await expect(detail).toContainText('IND-2026-0043');
  await expect(detail.getByRole('button', { name: 'Approve' })).toBeEnabled();
});

test('offline: the block shows, actions are disabled, data stays readable', async ({
  page,
  context,
}) => {
  await provisionApprovals(page);
  await page.goto(`/approvals?indent=${INDENT_ID}`);
  const detail = page.getByRole('region', { name: 'Approval detail' });
  await expect(detail.getByRole('button', { name: 'Approve' })).toBeEnabled();
  // Wait for the live bootstrap: the shell wires its online/offline listener after it.
  await expect(
    page
      .getByRole('navigation', { name: 'Primary navigation' })
      .getByRole('link', { name: 'Approvals' }),
  ).toBeVisible();
  await context.setOffline(true);
  await expect(
    detail.getByText(/Offline - approvals need a connection\. .*last sync at/),
  ).toBeVisible();
  // One status on a two-pane layout, not one per pane.
  await expect(page.getByText(/Offline - approvals need a connection/)).toHaveCount(1);
  await expect(detail.getByRole('button', { name: 'Approve' })).toBeDisabled();
  await expect(detail.getByRole('button', { name: 'Reject' })).toBeDisabled();
  await expect(detail.getByText('CON-WELD-ROD').first()).toBeVisible();
  await context.setOffline(false);
  await expect(detail.getByRole('button', { name: 'Approve' })).toBeEnabled();
});

test('empty waiting state offers the decided items', async ({ page }) => {
  await provisionApprovals(page, { empty: true });
  await page.goto('/approvals');
  await expect(page.getByText('Nothing waiting for you')).toBeVisible();
  await page.getByRole('button', { name: 'See decided items' }).click();
  await expect(page.getByRole('button', { name: 'Decided 0' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
});

test('a search with no hits shows No items match and Clear filters', async ({ page }) => {
  await provisionApprovals(page);
  await page.goto('/approvals');
  await page.getByRole('searchbox', { name: 'Search' }).fill('helmet');
  await expect(page.getByText('No items match')).toBeVisible();
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await expect(page.getByRole('button', { name: /IND-2026-0042/ })).toBeVisible();
  await page.getByRole('searchbox', { name: 'Search' }).fill('weld-rod');
  await expect(page.getByRole('button', { name: /IND-2026-0042/ })).toBeVisible();
});

test('a deep link without the Approvals entry shows the no-access card', async ({ page }) => {
  await provisionApprovals(page, { navigation: ['Dashboard', 'Frontline'] });
  await page.goto('/approvals');
  await expect(page.getByRole('alert').filter({ hasText: 'No access' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Approval detail' })).toHaveCount(0);
});

test.describe('handheld', () => {
  test.use({ viewport: { width: 360, height: 640 }, hasTouch: true, isMobile: true });

  test('cards open the detail as a page; the pinned footer replaces the bottom nav', async ({
    page,
  }) => {
    await provisionApprovals(page);
    await page.goto('/approvals');
    const bottomNav = page.getByRole('navigation', { name: 'Bottom navigation' });
    await expect(bottomNav).toBeVisible();
    await page.getByRole('button', { name: /IND-2026-0042/ }).click();
    await expect(bottomNav).toHaveCount(0);
    const approve = page.getByRole('button', { name: 'Approve' });
    await expect(approve).toHaveCSS('min-height', '56px');
    await expect(page.getByRole('button', { name: 'Reject' })).toHaveCSS('min-height', '48px');
    await page.getByRole('button', { name: 'Back to inbox' }).first().click();
    await expect(bottomNav).toBeVisible();
    await expect(page.getByRole('button', { name: /IND-2026-0042/ })).toBeVisible();
  });

  test('a deep link whose list fails keeps the bottom nav as the way out', async ({ page }) => {
    await provisionApprovals(page, { listFails: true });
    await page.goto(`/approvals?indent=${INDENT_ID}`);
    await expect(page.getByText('Approvals could not be loaded.')).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Bottom navigation' })).toBeVisible();
  });
});

test.describe('tablet', () => {
  test.use({ viewport: { width: 768, height: 1024 }, hasTouch: true, isMobile: true });

  test('cards and detail side by side at touch density', async ({ page }) => {
    await provisionApprovals(page);
    await page.goto(`/approvals?indent=${INDENT_ID}`);
    await expect(page.getByRole('table', { name: /Approvals for/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /IND-2026-0042/ })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Approve' })).toHaveCSS('min-height', '56px');
  });
});

test.describe('desktop touch', () => {
  test.use({ viewport: { width: 1366, height: 768 }, hasTouch: true });

  test('the desktop table with touch-size actions', async ({ page }) => {
    await provisionApprovals(page);
    await page.goto(`/approvals?indent=${INDENT_ID}`);
    await expect(page.getByRole('table', { name: /Approvals for/ })).toBeVisible();
    await expect(page.locator('.approvals-screen')).toHaveAttribute(
      'data-device-class',
      'desktop-touch',
    );
    await expect(page.getByRole('button', { name: 'Approve' })).toHaveCSS('min-height', '56px');
  });
});

test('desktop: compact 34px actions', async ({ page }) => {
  await provisionApprovals(page);
  await page.goto(`/approvals?indent=${INDENT_ID}`);
  await expect(page.getByRole('button', { name: 'Approve' })).toHaveCSS('min-height', '34px');
});
