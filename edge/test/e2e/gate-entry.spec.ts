import { test, expect, type Page } from '@playwright/test';
import {
  GATE_NAVIGATION,
  OPEN_TRUCK_TOKEN,
  PHOTO_FILE,
  provisionGate,
} from '../fixtures/gate-stub';

// Story 3.13 (AC 1, 5, 6, 8, 10): the gate entry stepper and the weighbridge tab.

async function waitForBootstrap(page: Page) {
  await expect(
    page
      .getByRole('navigation', { name: 'Primary navigation' })
      .getByRole('link', { name: 'Gate entry' }),
  ).toBeVisible();
}

test('the gate officer is advertised Gate entry with a real path and sees the site and gate', async ({
  page,
}) => {
  await provisionGate(page);
  await page.goto('/');
  const nav = page.getByRole('navigation', { name: 'Primary navigation' });
  await expect(nav.getByRole('link', { name: 'Gate entry' })).toHaveAttribute('href', '/gate');

  await page.goto('/gate');
  await waitForBootstrap(page);
  await expect(page.getByRole('heading', { name: 'Gate entry' })).toBeVisible();
  await expect(page.getByText('Site site-A - gate GATE-01')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Next' })).toBeDisabled();
});

test('one keyboard-only gate entry is captured and reports the binding token', async ({ page }) => {
  await provisionGate(page);
  await page.goto('/gate');
  await waitForBootstrap(page);

  // Challan: wedge the number and press Enter.
  const challan = page.getByLabel('Challan number');
  await expect(challan).toBeFocused();
  await page.keyboard.type('CH-2026-01');
  await page.keyboard.press('Enter');
  await expect(page.getByText(/Matched CH-2026-01/)).toBeVisible();
  await page.getByRole('button', { name: 'Accept' }).click();
  await page.getByRole('button', { name: 'Next' }).click();

  await page.getByLabel('Take challan photo').setInputFiles(PHOTO_FILE);
  await expect(page.getByText('Photo captured.')).toBeVisible();
  await page.getByRole('button', { name: 'Next' }).click();

  await page.getByLabel('Vehicle registration').fill('ka01ab1234');
  await page.getByLabel('Driver name (optional)').fill('Ravi');
  await page.getByRole('button', { name: 'Next' }).click();

  await page.getByRole('radio', { name: 'Unlisted supplier' }).check();
  await page.getByLabel('Supplier name').fill('Acme Traders');

  await expect(page.getByText('Ready to submit.')).toBeVisible();
  await page.getByRole('button', { name: 'Submit entry' }).click();
  await expect(page.getByRole('heading', { name: 'Gate entry captured' })).toBeVisible();
  await expect(page.getByText(/Binding token: [0-9a-f-]{36}/)).toBeVisible();
});

test('the weighbridge tab refuses an out-of-band or negative weighment and disables an out-of-stamp device', async ({
  page,
}) => {
  await provisionGate(page);
  await page.goto('/gate');
  await waitForBootstrap(page);
  await page.getByRole('tab', { name: 'Trucks on site' }).click();

  await page.getByLabel('Binding token').fill('77777777-7777-4777-8777-777777777777');
  await page.getByLabel('Gross (kg)').fill('1000');
  await page.getByLabel('Tare (kg)').fill('1500');
  // Tare greater than gross: the submit stays disabled and no net is shown.
  await expect(page.getByRole('button', { name: 'Submit weighment' })).toBeDisabled();

  await page.getByLabel('Tare (kg)').fill('500');
  await expect(page.getByText('Net: 500.000 kg')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Submit weighment' })).toBeEnabled();
  // The indicator link is absent at the pilot, so the read button is present but its reason is shown.
  await expect(page.getByText('No indicator link on this device.')).toBeVisible();
});

test('an overdue stamp blocks weighing with an alert', async ({ page }) => {
  await provisionGate(page, { stamp: 'overdue', openTruck: true });
  await page.goto('/gate');
  await waitForBootstrap(page);
  await page.getByRole('tab', { name: 'Trucks on site' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'out of statutory stamp' })).toBeVisible();
  await page.getByLabel('Gross (kg)').fill('1000');
  await page.getByLabel('Tare (kg)').fill('500');
  await expect(page.getByRole('button', { name: 'Submit weighment' })).toBeDisabled();
});

test('a failed stamp check fails soft and does not block weighing', async ({ page }) => {
  await provisionGate(page, { stamp: 'fail', openTruck: true });
  await page.goto('/gate');
  await waitForBootstrap(page);
  await page.getByRole('tab', { name: 'Trucks on site' }).click();
  await expect(page.getByText('Stamp not verified, server will confirm.')).toBeVisible();
  await page.getByLabel('Gross (kg)').fill('1000');
  await page.getByLabel('Tare (kg)').fill('500');
  await expect(page.getByRole('button', { name: 'Submit weighment' })).toBeEnabled();
});

test('a net weight outside the PO line tolerance shows the breach banner', async ({ page }) => {
  await provisionGate(page, { orderedQty: 100, openTruck: true });
  await page.goto('/gate');
  await waitForBootstrap(page);
  await page.getByRole('tab', { name: 'Trucks on site' }).click();
  await expect(page.getByLabel('Binding token')).toHaveValue(OPEN_TRUCK_TOKEN);
  await page.getByLabel('Gross (kg)').fill('1000');
  await page.getByLabel('Tare (kg)').fill('500');
  await expect(page.getByText(/outside the PO line tolerance/)).toBeVisible();
  await page.getByLabel('Gross (kg)').fill('600');
  await expect(page.getByText(/outside the PO line tolerance/)).toHaveCount(0);
});

for (const role of ['weighbridge_operator', 'store_assistant']) {
  test(`${role} keeps the gate stepper and the trucks tab`, async ({ page }) => {
    await provisionGate(page, { role, navigation: GATE_NAVIGATION });
    await page.goto('/gate');
    await waitForBootstrap(page);
    await expect(page.getByRole('tab', { name: 'Gate entry' })).toBeVisible();
    await expect(page.getByRole('list', { name: 'Gate entry steps' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Trucks on site' })).toBeVisible();
  });
}

test('a device with no site hides the gate nav row and guards the route', async ({ page }) => {
  await provisionGate(page, { siteCodeExt: null });
  await page.goto('/gate');
  await expect(page.getByText(/no site assigned/).first()).toBeVisible();
  await expect(
    page
      .getByRole('navigation', { name: 'Primary navigation' })
      .getByRole('link', { name: 'Gate entry' }),
  ).toHaveCount(0);
  // The route guard follows the advertised nav: no gate row, so no gate screen.
  await expect(page.getByRole('heading', { name: 'No access' })).toBeVisible();
});
