import { test, expect, type Page } from '@playwright/test';
import { BASE_NAVIGATION, PHOTO_FILE, provisionDamage } from '../fixtures/damage-stub';

// Story 8.9 (AC 1, 2, 5; Table 13): report damage from the base hat, offline-capable.

async function waitForBootstrap(page: Page) {
  await expect(
    page.getByRole('navigation', { name: 'Primary navigation' }).getByRole('link', { name: 'Report damage' }),
  ).toBeVisible();
}

async function attachmentPuts(page: Page) {
  return page.evaluate(
    () => (window as unknown as { __attachmentPuts: Array<{ id: string; type: string; size: number }> }).__attachmentPuts,
  );
}

test('every employee is advertised Report damage with a real path; the reporter gets no workbench', async ({
  page,
}) => {
  await provisionDamage(page);
  await page.goto('/');
  const nav = page.getByRole('navigation', { name: 'Primary navigation' });
  await expect(nav.getByRole('link', { name: 'Report damage' })).toHaveAttribute('href', '/damage/new');
  await expect(nav.getByRole('link', { name: 'Damage cases' })).toHaveCount(0);
});

test('a keyboard-wedge report with a photo is captured and says so, and the photo uploads raw', async ({
  page,
}) => {
  await provisionDamage(page);
  await page.goto('/damage/new');
  await waitForBootstrap(page);

  const sku = page.getByLabel('Item code (SKU)');
  await expect(sku).toBeFocused();
  await expect(sku).toHaveCSS('min-height', '56px');
  await expect(page.getByText('Still needed: item code, bin, quantity, reason, photo')).toBeVisible();

  // A scanner types the code and presses Enter: the form sends focus to the first missing part.
  await page.keyboard.type('PCB-CTRL-01');
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('Bin', { exact: true })).toBeFocused();
  await page.keyboard.type('CMF-STORE-A1');
  await page.getByLabel('Lot number').fill('LOT-7');
  await page.getByLabel('Quantity affected').fill('4');
  await page.getByRole('radio', { name: /Dead on arrival - electronic/ }).check();
  await page.getByLabel('Take photo').setInputFiles(PHOTO_FILE);
  await expect(page.getByText('Photo saved')).toBeVisible();
  await expect(page.getByLabel('Retake')).toBeVisible();
  await expect(page.getByText('Ready to send')).toBeVisible();

  await page.getByRole('button', { name: 'Send damage report' }).dblclick();
  const done = page.getByRole('heading', { name: 'Captured - pending sync' });
  await expect(done).toBeVisible();
  await expect(done).toBeFocused();
  await expect(page.getByText('QC and finance will decide - You do not need to do anything more.')).toBeVisible();
  await expect(page.getByText('Whole-lot hold requested. The QC head decides.')).toHaveCount(0);

  // The pending photo goes out once, raw, with the file's own type (D14).
  await expect.poll(async () => (await attachmentPuts(page)).length).toBe(1);
  const [put] = await attachmentPuts(page);
  expect(put!.type).toBe('image/jpeg');
  expect(put!.size).toBe(PHOTO_FILE.buffer.length);
  expect(put!.id).toMatch(/^[0-9a-f-]{36}$/);

  await page.getByRole('button', { name: 'Report another' }).click();
  await expect(page.getByLabel('Item code (SKU)')).toHaveValue('');
  await expect(page.getByLabel('Item code (SKU)')).toBeFocused();
});

test('offline: in-use material, Other with a note, whole lot and replacement are captured pending sync', async ({
  page,
  context,
}) => {
  await provisionDamage(page);
  await page.goto('/damage/new');
  await waitForBootstrap(page);
  await context.setOffline(true);

  await page.getByLabel('Item code (SKU)').fill('GASKET-40');
  await page.getByRole('radio', { name: 'In use / issued to me' }).check();
  await expect(page.getByLabel('Bin', { exact: true })).toHaveCount(0);
  await page.getByLabel('Quantity affected').fill('2.5');
  await page.getByRole('radio', { name: /^Other/ }).check();
  await page.getByRole('checkbox', { name: /Suspect whole lot/ }).check();
  await page.getByRole('checkbox', { name: /Request replacement/ }).check();
  await page.getByLabel('Take photo').setInputFiles(PHOTO_FILE);
  await expect(
    page.getByText(
      'Still needed: one-line note for Other, lot number for a whole-lot request, replacement details',
    ),
  ).toBeVisible();

  // Sending with parts missing names them and moves focus to the first one.
  await page.getByRole('button', { name: 'Send damage report' }).click();
  await expect(page.getByLabel('What is wrong? (one line, up to 200 characters)')).toBeFocused();
  await page.keyboard.type('Scorched connector');
  await page.getByLabel('Lot number').fill('LOT-9');
  await page.getByLabel('Department code').fill('MAINT');
  await page.getByLabel('Business stream').fill('manufacturing');
  await page.getByLabel('Item category').fill('spares');
  await page.getByLabel('Unit of measure').fill('EA');
  await page.getByRole('button', { name: 'Send damage report' }).click();

  await expect(page.getByRole('heading', { name: 'Captured - pending sync' })).toBeVisible();
  await expect(page.getByText('Whole-lot hold requested. The QC head decides.')).toBeVisible();
  await expect(
    page.getByText('A linked replacement requisition was raised in the same flow.'),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: 'Back to my requests' })).toHaveAttribute('href', '/requests');
  // Offline: nothing was uploaded yet; the photo waits in the device store.
  expect(await attachmentPuts(page)).toEqual([]);
  await context.setOffline(false);
});

test('my requests lists own damage reports with state, decision and the linked requisition', async ({
  page,
}) => {
  await provisionDamage(page);
  await page.goto('/requests');
  const section = page.getByRole('region', { name: 'Damage reports' });
  const cards = section.getByRole('listitem');
  await expect(cards).toHaveCount(5);
  const first = cards.filter({ hasText: 'DMG-2026-0001' });
  await expect(first).toContainText('On hold - with QC');
  await expect(first).toContainText('PCB-CTRL-01 x 4');
  await expect(first).toContainText('LOT-7');
  await expect(first).toContainText('QC and finance will decide');
  await expect(first).toContainText('IND-2026-0107');
  await expect(cards.filter({ hasText: 'DMG-2026-0003' })).toContainText('With the CEO');
  await expect(page.getByRole('region', { name: 'Requisitions' }).getByRole('listitem')).toHaveCount(1);
});

test('a deep link to either damage screen without its entry shows the no-access card', async ({ page }) => {
  await provisionDamage(page, { navigation: BASE_NAVIGATION });
  for (const path of ['/damage/new', '/damage/cases']) {
    await page.goto(path);
    const card = page.getByRole('alert').filter({ hasText: 'No access' });
    await expect(card).toContainText('Your access does not include this screen.');
    await expect(card.getByRole('link', { name: 'Go to home' })).toHaveAttribute('href', '/');
    await expect(page.getByLabel('Item code (SKU)')).toHaveCount(0);
  }
});
