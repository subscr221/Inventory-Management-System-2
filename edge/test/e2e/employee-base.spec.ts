import { test, expect } from '@playwright/test';
import { provisionEmployeeBase, KNOWN_SKU, OUT_SKU } from '../fixtures/employee-base-stub';

// Story 1.15: the employee base screens against stubbed routes (AC 2, 4, 5 and Task 3.6).

test('the bootstrap advertises the three base entries with real paths', async ({ page }) => {
  await provisionEmployeeBase(page);
  await page.goto('/');
  const nav = page.getByRole('navigation', { name: 'Primary navigation' });
  for (const [name, href] of [
    ['New requisition', '/requisitions/new'],
    ['Check stock', '/stock'],
    ['My requests', '/requests'],
  ] as const) {
    await expect(nav.getByRole('link', { name })).toHaveAttribute('href', href);
  }
  await expect(nav.getByRole('link', { name: 'Refused captures' })).toHaveCount(0);
});

test('check stock shows a state per location and never a number, driven by the keyboard', async ({
  page,
}) => {
  await provisionEmployeeBase(page);
  await page.goto('/stock');
  const field = page.getByLabel('Item code (SKU)');
  await expect(field).toBeVisible();

  // Real Tab presses from the page top reach the field, then the button.
  await page.locator('body').click({ position: { x: 1, y: 1 } });
  for (
    let i = 0;
    i < 40 && !(await field.evaluate((el) => el === document.activeElement));
    i += 1
  ) {
    await page.keyboard.press('Tab');
  }
  await expect(field).toBeFocused();
  await page.keyboard.type(KNOWN_SKU);
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Check' })).toBeFocused();
  await page.keyboard.press('Enter');

  const result = page.getByRole('region', { name: `${KNOWN_SKU} (PAIR)` });
  await expect(result.getByRole('listitem')).toHaveCount(2);
  await expect(result.getByRole('listitem').nth(0)).toContainText('CMF-STORE-A1');
  await expect(result.getByRole('listitem').nth(0)).toContainText('In stock');
  await expect(result.getByRole('listitem').nth(1)).toContainText('Out of stock');
  await expect(result).toContainText('Available to request.');
  await expect(result).not.toContainText(/\d+\s*(available|PAIR\b)/);

  await field.fill(OUT_SKU);
  await page.getByRole('button', { name: 'Check' }).click();
  await expect(page.getByRole('region', { name: `${OUT_SKU} (EA)` })).toContainText(
    'Not available to request at your locations.',
  );

  await field.fill('NO-SUCH-ITEM');
  await page.getByRole('button', { name: 'Check' }).click();
  await expect(page.getByRole('status', { name: 'Stock check status' })).toHaveText(
    'No item has that code.',
  );

  await field.fill('$bad');
  await page.getByRole('button', { name: 'Check' }).click();
  await expect(page.getByRole('status', { name: 'Stock check status' })).toHaveText(
    'Enter a valid item code.',
  );
});

test('my requests lists own requisitions newest first and truncates past the limit', async ({
  page,
}) => {
  // Code review 2026-09-27: 55 total (over the 50-item limit) is the real truncation case; the
  // fix requests limit+1 and slices, so this exercises that path rather than the old length===limit
  // heuristic.
  await provisionEmployeeBase(page, { indentCount: 55 });
  await page.goto('/requests');
  const section = page.getByRole('region', { name: 'Requisitions' });
  const cards = section.getByRole('listitem');
  await expect(cards).toHaveCount(50);
  await expect(cards.nth(0)).toContainText('IND-2026-0100');
  await expect(cards.nth(0)).toContainText('Routed for approval');
  await expect(cards.nth(1)).toContainText('Approved');
  await expect(cards.nth(1)).toContainText('Not required');
  await expect(section).toContainText('Only your 50 most recent requisitions are shown.');
  await expect(page.getByRole('table')).toHaveCount(0);
});

test('my requests does not claim truncation when the caller has exactly the limit', async ({
  page,
}) => {
  // Code review 2026-09-27: regression case for the off-by-one fix - exactly 50 total requisitions
  // must not show "Only your 50 most recent requisitions are shown," since there are no more.
  await provisionEmployeeBase(page, { indentCount: 50 });
  await page.goto('/requests');
  const section = page.getByRole('region', { name: 'Requisitions' });
  await expect(section.getByRole('listitem')).toHaveCount(50);
  await expect(section).not.toContainText('Only your 50 most recent requisitions are shown.');
});

test('my requests says so when there are none and when the API refuses', async ({ page }) => {
  await provisionEmployeeBase(page, { indentCount: 0 });
  await page.goto('/requests');
  await expect(page.getByRole('region', { name: 'Requisitions' })).toContainText(
    'You have not raised any requisitions.',
  );

  await provisionEmployeeBase(page, { indentStatus: 403 });
  await page.goto('/requests');
  await expect(page.getByText('Your access does not include requisitions.')).toBeVisible();
  await expect(page.getByText('server message never shown')).toHaveCount(0);
});

test('new requisition renders the indent capture on its own route', async ({ page }) => {
  await provisionEmployeeBase(page);
  await page.goto('/requisitions/new');
  await expect(page.locator('#new-requisition')).toBeVisible();
  await expect(page.locator('#frontline')).toHaveCount(0);
});

test('a deep link the bootstrap does not advertise shows the no-access card with a way home', async ({
  page,
}) => {
  await provisionEmployeeBase(page, { navigation: ['Dashboard', 'Frontline'] });
  for (const path of ['/stock', '/requests', '/requisitions/new']) {
    await page.goto(path);
    const card = page.getByRole('alert').filter({ hasText: 'No access' });
    await expect(card).toContainText('Your access does not include this screen.');
    await expect(card.getByRole('link', { name: 'Go to home' })).toHaveAttribute('href', '/');
    await expect(page.getByLabel('Item code (SKU)')).toHaveCount(0);
  }
});

test('check stock and my requests show the needs-connection card offline', async ({
  page,
  context,
}) => {
  await provisionEmployeeBase(page);
  const nav = page.getByRole('navigation', { name: 'Primary navigation' });
  await page.goto('/stock');
  // Wait for the live bootstrap: the shell wires its online/offline listener after it.
  await expect(nav.getByRole('link', { name: 'Check stock' })).toBeVisible();
  await expect(page.getByLabel('Item code (SKU)')).toBeVisible();
  await context.setOffline(true);
  await expect(page.getByText('Checking stock needs a connection.')).toBeVisible();
  await context.setOffline(false);
  await page.goto('/requests');
  await expect(nav.getByRole('link', { name: 'My requests' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Requisitions' })).toBeVisible();
  await context.setOffline(true);
  await expect(page.getByText('My requests needs a connection.')).toBeVisible();
  await context.setOffline(false);
});
