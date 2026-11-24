import { test, expect } from '@playwright/test';
import { provisionFloor } from '../fixtures/floor-stub';

// Story 3.16 (AC 2, 4, 5, 6): the floor inbox, the pick-line stepper (scan bin, scan lot,
// confirm qty), the held/wrong feedback, and the inline completion panel.

test('the inbox lists an assigned pick list and opens it', async ({ page }) => {
  await provisionFloor(page, { task: 'one-line' });
  await page.goto('/floor/tasks');

  await expect(page.getByRole('heading', { name: 'Pick lists - sales orders' })).toBeVisible();
  await expect(page.getByText('SO-316-1')).toBeVisible();
  await expect(page.getByText('0 of 1 picked')).toBeVisible();
  await expect(page.getByText('Pending')).toBeVisible();

  await page.getByRole('link', { name: 'Open' }).first().click();
  await expect(page).toHaveURL(/\/floor\/tasks\?task=77777777-7777-4777-8777-777777777781/);
});

test('an empty inbox reads All caught up', async ({ page }) => {
  await provisionFloor(page, { task: null });
  await page.goto('/floor/tasks');
  await expect(page.getByRole('heading', { name: 'Pick lists - sales orders' })).toBeVisible();
  await expect(page.getByText('All caught up')).toBeVisible();
});

test('a wrong bin stays on step 1; the directed bin advances through lot to confirm', async ({
  page,
}) => {
  await provisionFloor(page, { task: 'one-line' });
  await page.goto('/floor/tasks?task=77777777-7777-4777-8777-777777777781');

  const bin = page.getByLabel('Scan or type the bin label');
  await expect(bin).toBeFocused();

  await bin.fill('BIN-Z-99');
  await bin.press('Enter');
  await expect(page.getByText(/Wrong bin - BIN-Z-99/)).toBeVisible();

  await bin.fill('BIN-F-01');
  await bin.press('Enter');
  const lot = page.getByLabel('Scan or type the lot label');
  await expect(lot).toBeVisible();

  await lot.fill('LOT-F-01');
  await lot.press('Enter');
  const confirm = page.getByRole('button', { name: 'Confirm 10.000 picked' });
  await expect(confirm).toBeVisible();

  await confirm.click();
  await expect(page.getByRole('heading', { name: 'Pick complete' })).toBeVisible();
  await expect(page.getByText('All lines picked')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Back to tasks' })).toBeVisible();
});

test('the stepper exposes the active step', async ({ page }) => {
  await provisionFloor(page, { task: 'one-line' });
  await page.goto('/floor/tasks?task=77777777-7777-4777-8777-777777777781');

const steps = page.getByLabel('Pick steps');
await expect(steps).toContainText('1 Scan bin');
await expect(steps).toContainText('2 Scan lot');
await expect(steps).toContainText('3 Confirm qty');
await expect(page.getByRole('listitem').filter({ hasText: '1 Scan bin' })).toHaveAttribute(
  'aria-current',
  'step',
);
});

test('short pick records shortfall, shows completion panel with short pill and re-pick note', async ({
  page,
}) => {
  await provisionFloor(page, { task: 'one-line' });
  await page.goto('/floor/tasks?task=77777777-7777-4777-8777-777777777781');

  const bin = page.getByLabel('Scan or type the bin label');
  await bin.fill('BIN-F-01');
  await bin.press('Enter');

  const shortBtn = page.getByRole('button', { name: 'Short pick' });
  await expect(shortBtn).toBeVisible();
  await shortBtn.click();

  // Short pick form is shown
  await expect(page.getByText('Reason for short pick')).toBeVisible();
  await page.getByRole('button', { name: 'Bin empty' }).click();

  const confirmShort = page.getByRole('button', { name: 'Confirm short pick - 0 of 10.000' });
  await expect(confirmShort).toBeVisible();
  await confirmShort.click();

  await expect(page.getByRole('heading', { name: 'Pick complete' })).toBeVisible();
  await expect(page.getByText('1 short')).toBeVisible();
  await expect(page.getByText('Short lines go back to planning for a re-pick.')).toBeVisible();
});
