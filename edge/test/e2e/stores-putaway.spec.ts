import { test, expect } from '@playwright/test';
import {
  GRN_ID,
  GRN_LINE_ID,
  PUTAWAY_TASK_ID,
  provisionStores,
} from '../fixtures/stores-stub';

// Story 3.15 (AC 2, 3, 4, 5): putaway cards, suggestion, override and the GRN read card.

test('a ready putaway task opens from the inbox and completes on the suggestion', async ({
  page,
}) => {
  await provisionStores(page, { withPutaway: true });
  await page.goto('/stores');

  const open = page.getByRole('link', { name: 'Open putaway' });
  await expect(open).toHaveAttribute('href', `/stores/putaway?task=${PUTAWAY_TASK_ID}`);
  await open.click();

  await expect(page.getByRole('heading', { name: 'Put away SKU-1' })).toBeVisible();
  await expect(page.getByText('Suggested: BIN-A-01')).toBeVisible();
  await expect(page.getByText('Source bay: IB-01')).toBeVisible();

  await page.getByRole('button', { name: 'Use suggested BIN-A-01' }).click();
  await expect(page.getByRole('heading', { name: 'Put away complete' })).toBeVisible();
});

test('another rack asks for a fixed reason and confidence', async ({ page }) => {
  await provisionStores(page, { withPutaway: true });
  await page.goto(`/stores/putaway?task=${PUTAWAY_TASK_ID}`);

  await page.getByRole('button', { name: 'Choose another rack' }).click();
  const scan = page.getByLabel('Scan or type a rack code');
  await scan.fill('BIN-Z-09');
  await scan.press('Enter');

  await expect(page.getByRole('heading', { name: 'Why another rack?' })).toBeVisible();
  await page.getByRole('button', { name: 'Nearer bay' }).click();
  await page.getByRole('button', { name: 'Certain', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm putaway' }).click();
  await expect(page.getByRole('heading', { name: 'Put away complete' })).toBeVisible();
});

test('the GRN read card highlights the label line', async ({ page }) => {
  await provisionStores(page);
  await page.goto(`/stores/grn?grn=${GRN_ID}&line=${GRN_LINE_ID}`);

  await expect(page.getByRole('heading', { name: `Goods receipt ${GRN_ID}` })).toBeVisible();
  await expect(page.getByText('Supplier: SUP-1')).toBeVisible();
  await expect(page.getByText(`(selected)`)).toBeVisible();
  await expect(page.getByText('No labels for this GRN.')).toBeVisible();
});
