import { test, expect, type Page } from '@playwright/test';
import {
  UNL_GATE_ID,
  UNL_LINE_ID,
  provisionUnloading,
} from '../fixtures/unloading-exceptions-stub';

// Story 3.20: the merged inbox, the two resolve flows, scan, offline and the no-access card.

const posts = (page: Page) =>
  page.evaluate(() => (window as unknown as { __posts: string[] }).__posts);

test('the inbox merges open cases oldest first and lists only today under Resolved today', async ({
  page,
}) => {
  await provisionUnloading(page);
  await page.goto('/unloading/exceptions');

  await expect(
    page.getByRole('heading', { name: 'Exceptions from gate and unloading (2)' }),
  ).toBeVisible();
  const cards = page
    .locator('section[aria-labelledby="unloading-open-heading"]')
    .getByRole('listitem');
  await expect(cards.first()).toContainText('PO-9');
  await expect(cards.nth(1)).toContainText('UP 80 AB 1234');
  await expect(page.getByText('Not matched')).toBeVisible();
  await expect(page.getByText('Over tolerance', { exact: true })).toBeVisible();
  const resolved = page.locator('section[aria-labelledby="unloading-resolved-heading"]');
  await expect(resolved).toContainText('PO-TODAY');
  await expect(resolved).not.toContainText('PO-YESTERDAY');
  await expect(resolved.getByText('Matched to PO')).toBeVisible();
});

test('an empty inbox shows the mock text with the scan field armed', async ({ page }) => {
  await provisionUnloading(page, { empty: true });
  await page.goto('/unloading/exceptions');
  await expect(
    page.getByText(
      'No open exceptions from gate or unloading. New ones appear here as trucks arrive.',
    ),
  ).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Scan vehicle, challan or PO' })).toBeEnabled();
});

test('match to PO: a missing PO announces, an open PO enables the match and resolves', async ({
  page,
}) => {
  await provisionUnloading(page);
  await page.goto(`/unloading/exceptions?case=gate:${UNL_GATE_ID}`);

  const primary = page.getByRole('button', { name: 'Choose a PO to match' });
  await expect(primary).toBeDisabled();
  await page.getByLabel('PO number to match').fill('PO-404');
  await page.getByRole('button', { name: 'Look up PO' }).click();
  await expect(page.getByText('No PO PO-404 found - check the number and try again')).toBeVisible();
  await expect(primary).toBeDisabled();

  await page.getByLabel('PO number to match').fill('PO-1');
  await page.getByRole('button', { name: 'Look up PO' }).click();
  await expect(page.getByText('SUP-1')).toBeVisible();
  await expect(page.getByText('2026-11-25')).toBeVisible();
  await page.getByRole('button', { name: 'Match to PO-1' }).click();
  await expect(page.getByText('The delivery moves to the stores inbox.')).toBeVisible();
  expect(await posts(page)).toContain(`/api/v1/gate-events/${UNL_GATE_ID}/match-po`);
});

test('a refused match shows the error and no Resolved view', async ({ page }) => {
  await provisionUnloading(page, { matchRefused: true });
  await page.goto(`/unloading/exceptions?case=gate:${UNL_GATE_ID}`);
  await page.getByLabel('PO number to match').fill('PO-1');
  await page.getByRole('button', { name: 'Look up PO' }).click();
  await page.getByRole('button', { name: 'Match to PO-1' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'not open for receiving' })).toBeVisible();
  await expect(page.getByText('The delivery moves to the stores inbox.')).toHaveCount(0);
});

test('ask procurement sends the note and shows the Resolved view', async ({ page }) => {
  await provisionUnloading(page);
  await page.goto(`/unloading/exceptions?case=gate:${UNL_GATE_ID}`);
  await page.getByLabel('Note (optional)').fill('Supplier says PO pending');
  await page.getByRole('button', { name: 'No PO fits - hold vehicle, ask procurement' }).click();
  await expect(page.getByRole('heading', { name: 'Exception resolved' })).toBeVisible();
  expect(await posts(page)).toContain(`/api/v1/gate-events/${UNL_GATE_ID}/send-to-procurement`);
});

test('accept within band shows facts in order and posts the accept', async ({ page }) => {
  await provisionUnloading(page);
  await page.goto(`/unloading/exceptions?case=line:${UNL_LINE_ID}`);
  const detail = page.getByRole('region', { name: 'Over tolerance' });
  await expect(detail.locator('dt')).toHaveText([
    'PO line',
    'Ordered',
    'Already received',
    'Accept up to 20 (10% tolerance)',
    'Counted',
  ]);
  await expect(detail.getByText('Excess 10 - returned with vehicle')).toBeVisible();
  await expect(
    detail.getByRole('button', { name: 'Hold excess for buyer decision' }),
  ).toBeDisabled();
  await expect(detail.getByText('Post-pilot')).toBeVisible();
  await detail.getByRole('button', { name: 'Accept 20 - return 10 with vehicle' }).click();
  await expect(page.getByText('The delivery moves to the stores inbox.')).toBeVisible();
  expect(await posts(page)).toContain(`/api/v1/grn-lines/${UNL_LINE_ID}/accept-within-band`);
});

test('Recount returns to the inbox without a request', async ({ page }) => {
  await provisionUnloading(page);
  await page.goto(`/unloading/exceptions?case=line:${UNL_LINE_ID}`);
  await page.getByRole('link', { name: 'Recount' }).click();
  await expect(page).toHaveURL(/\/unloading\/exceptions$/);
  await expect(
    page.getByRole('heading', { name: 'Exceptions from gate and unloading (2)' }),
  ).toBeVisible();
  expect(await posts(page)).toEqual([]);
});

test('scan opens the matching case and announces a miss', async ({ page }) => {
  await provisionUnloading(page);
  await page.goto('/unloading/exceptions');
  const scan = page.getByRole('textbox', { name: 'Scan vehicle, challan or PO' });
  await scan.fill('nothing');
  await scan.press('Enter');
  await expect(page.getByText('No open exception for nothing')).toBeVisible();
  await scan.fill('up80ab1234');
  await scan.press('Enter');
  await expect(page).toHaveURL(new RegExp(`case=gate%3A${UNL_GATE_ID}`));
});

test('offline: the needs-connection card shows and every resolve action is disabled', async ({
  page,
  context,
}) => {
  await provisionUnloading(page);
  await page.goto(`/unloading/exceptions?case=line:${UNL_LINE_ID}`);
  const accept = page.getByRole('button', { name: 'Accept 20 - return 10 with vehicle' });
  await expect(accept).toBeEnabled();
  await expect(
    page
      .getByRole('navigation', { name: 'Primary navigation' })
      .getByRole('link', { name: 'Unloading exceptions' }),
  ).toBeVisible();
  await context.setOffline(true);
  await expect(page.getByText(/This screen needs a connection to load/)).toBeVisible();
  await expect(accept).toBeDisabled();
  await expect(
    page.getByText('Needs a connection - exceptions are resolved against live PO and GRN data'),
  ).toBeVisible();
  expect(await posts(page)).toEqual([]);
});

test('a caller without the navigation entry gets the no-access card', async ({ page }) => {
  await provisionUnloading(page, { navigation: ['Dashboard', 'Frontline'] });
  await page.goto('/unloading/exceptions');
  await expect(page.getByRole('heading', { name: 'No access' })).toBeVisible();
});
