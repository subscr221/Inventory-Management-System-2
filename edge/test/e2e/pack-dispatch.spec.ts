import { test, expect } from '@playwright/test';
import { PACK_BLOCKED_ID, PACK_READY_ID, provisionPack } from '../fixtures/pack-dispatch-stub';

// Story 3.18 (AC 3, 4, 5): the three-group inbox, the pack-station lot checklist and scan, and
// the IRN blocked card.

test('the inbox groups ready, waiting and dispatched orders with their pills', async ({ page }) => {
  await provisionPack(page);
  await page.goto('/floor/pack');

  await expect(page.getByRole('heading', { name: 'Ready to pack' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Waiting for documents' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Dispatched today' })).toBeVisible();
  await expect(page.getByText('SO-318-1')).toBeVisible();
  await expect(page.getByText('Cannot dispatch')).toBeVisible();
  await expect(page.getByText('SO-318-3')).toBeVisible();
});

test('an empty inbox reads the picked-orders hint', async ({ page }) => {
  await provisionPack(page, { empty: true });
  await page.goto('/floor/pack');
  await expect(
    page.getByText(
      'Nothing to pack or dispatch. Picked orders appear here when the picker finishes.',
    ),
  ).toBeVisible();
});

test('a ready order scans each picked lot into the package and refuses an unknown lot', async ({
  page,
}) => {
  await provisionPack(page);
  await page.goto(`/floor/pack?dispatch=${PACK_READY_ID}`);

  const scan = page.getByLabel('Scan or type the lot label');
  await expect(scan).toBeVisible();

  await scan.fill('L-P-1');
  await scan.press('Enter');
  await expect(page.getByText('In package', { exact: true }).first()).toBeVisible();

  await scan.fill('L-P-99');
  await scan.press('Enter');
  await expect(page.getByText('That lot was not picked for this order.')).toBeVisible();
});

test('a documents order without an IRN renders the blocked card', async ({ page }) => {
  await provisionPack(page);
  await page.goto(`/floor/pack?dispatch=${PACK_BLOCKED_ID}`);

  await expect(
    page.getByRole('heading', { name: 'E-invoice IRN missing - cannot dispatch' }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Check IRN again' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Record IRN' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Confirm dispatch' })).toBeDisabled();
});

test('a ready order packs, generates documents, records the IRN and confirms dispatch', async ({
  page,
}) => {
  await provisionPack(page);
  await page.goto(`/floor/pack?dispatch=${PACK_READY_ID}`);

  const scan = page.getByLabel('Scan or type the lot label');
  await scan.fill('L-P-1');
  await scan.press('Enter');
  await scan.fill('L-P-2');
  await scan.press('Enter');
  await page.getByLabel('Weight').fill('2.5');

  const generate = page.getByRole('button', { name: 'Generate shipping documents' });
  await expect(generate).toBeEnabled();
  await generate.click();

  // After generation the IRN is missing, so the blocked card shows and Confirm is disabled.
  await expect(
    page.getByRole('heading', { name: 'E-invoice IRN missing - cannot dispatch' }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Confirm dispatch' })).toBeDisabled();

  await page.getByRole('button', { name: 'Record IRN' }).click();
  await page.getByLabel('Invoice number').fill('INV-318-1');
  await page.getByLabel(/IRN \(64 characters\)/).fill('a'.repeat(64));
  await page.getByRole('button', { name: 'Save IRN' }).click();

  // IRN recorded -> documents ready -> confirm dispatch succeeds.
  await expect(page.getByText('Shipping documents ready')).toBeVisible();
  const confirm = page.getByRole('button', { name: 'Confirm dispatch' });
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await expect(page.getByRole('heading', { name: 'Dispatched', exact: true })).toBeVisible();
});
