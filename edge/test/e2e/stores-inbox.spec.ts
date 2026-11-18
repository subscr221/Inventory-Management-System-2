import { test, expect } from '@playwright/test';
import { provisionStores } from '../fixtures/stores-stub';

// Story 3.14 (AC 1, 3, 4, 5): the stores inbox groups, the scan bar and the acceptance screen.

test('the storekeeper sees the four inbox groups and one actionable arrival', async ({ page }) => {
  await provisionStores(page);
  await page.goto('/stores');

  const nav = page.getByRole('navigation', { name: 'Primary navigation' });
  await expect(nav.getByRole('link', { name: 'Stores', exact: true })).toHaveAttribute('href', '/stores');

  await expect(page.getByRole('heading', { name: 'Arrived - awaiting acceptance' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Cleared by QC - put away' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Issues pending' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Returns to shelve' })).toBeVisible();
  await expect(page.getByText('Nothing waiting').first()).toBeVisible();

  const open = page.getByRole('link', { name: 'Start acceptance' });
  await expect(open).toHaveAttribute(
    'href',
    '/stores/accept?gate=99999999-9999-4999-8999-999999999991',
  );
  await expect(page.getByText('Match supplier')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start acceptance' })).toBeDisabled();
});

test('an unrecognised scan is announced, and a lot offer opens the damage sheet', async ({
  page,
}) => {
  await provisionStores(page);
  await page.goto('/stores');
  const scan = page.getByRole('textbox', { name: 'Scan anything' });
  await scan.fill('NOPE-123');
  await scan.press('Enter');
  await expect(
    page.getByText('Not recognised: NOPE-123. Scan or type a challan or lot code.'),
  ).toBeVisible();
});

test('acceptance carries the arrival, the bay banner and the counted line', async ({ page }) => {
  await provisionStores(page);
  await page.goto('/stores/accept?gate=99999999-9999-4999-8999-999999999991');
  await expect(page.getByRole('heading', { name: 'Accept delivery' })).toBeVisible();
  await expect(page.getByText('CH-OPEN')).toBeVisible();
  await expect(page.getByText('PO-2026-01')).toBeVisible();
  await expect(page.getByText('GOOD quantities go to the inspection bay IB-01.')).toBeVisible();
  await expect(page.getByText('Ordered: 100')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Complete acceptance' })).toBeDisabled();
});
