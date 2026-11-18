import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { PHOTO_FILE, provisionStores } from '../fixtures/stores-stub';

// Story 3.14 (AC 1, 3, 4, 5): the stores inbox groups, the scan bar and the acceptance screen.

test('the storekeeper sees the four inbox groups and one actionable arrival', async ({ page }) => {
  await provisionStores(page);
  await page.goto('/stores');

  const nav = page.getByRole('navigation', { name: 'Primary navigation' });
  await expect(nav.getByRole('link', { name: 'Stores', exact: true })).toHaveAttribute(
    'href',
    '/stores',
  );

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

// The stub answers 404 for every lot, so the lot sheet itself is not driven here.
test('an unrecognised scan is announced', async ({ page }) => {
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

// Code review 2026-11-19: the submit path, driven end to end against the fetch stub.
const ACCEPT = '/stores/accept?gate=99999999-9999-4999-8999-999999999991';

type Post = Record<string, unknown>;

function posts(page: Page): Promise<Post[]> {
  return page.evaluate(
    () => (window as unknown as { __grnLinePosts?: Post[] }).__grnLinePosts ?? [],
  );
}

async function takeMaterialPhoto(page: Page) {
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Take one material photo' }).click();
  await (await chooser).setFiles(PHOTO_FILE);
  await expect(page.getByRole('button', { name: 'Photo saved' })).toBeVisible();
}

test('completing an acceptance posts the GOOD row to the inspection bay', async ({ page }) => {
  await provisionStores(page);
  await page.goto(ACCEPT);
  await page.getByLabel('Good', { exact: true }).fill('90');
  await expect(page.getByText('Matches PO')).toBeVisible();
  await takeMaterialPhoto(page);
  await page.getByRole('button', { name: 'Complete acceptance' }).click();
  await expect(page.getByRole('heading', { name: 'Acceptance complete' })).toBeVisible();
  const sent = await posts(page);
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({
    received_qty: '90',
    line_condition: 'GOOD',
    target_location_code: 'IB-01',
    po_ref_ext: 'PO-2026-01',
  });
  expect(String(sent[0]!['idempotency_key'])).toBe(
    `stores-receipt-${String(sent[0]!['grn_line_id'])}`,
  );
});

test('an edit after a refusal is sent, under the same GRN and line ids', async ({ page }) => {
  await provisionStores(page, { refuseFirstPost: true });
  await page.goto(ACCEPT);
  await page.getByLabel('Good', { exact: true }).fill('90');
  await takeMaterialPhoto(page);
  await page.getByRole('button', { name: 'Complete acceptance' }).click();
  await expect(
    page.getByRole('alert').filter({ hasText: 'Choose a reason for this line' }),
  ).toBeVisible();

  await page.getByLabel('Good', { exact: true }).fill('88');
  await page.getByLabel('Damaged', { exact: true }).fill('2');
  await expect(page.getByRole('button', { name: 'Complete acceptance' })).toBeDisabled();
  await page.getByLabel('Damage detail').selectOption('TRANSIT_DAMAGE');
  await page.getByRole('button', { name: 'Complete acceptance' }).click();
  await expect(page.getByRole('heading', { name: 'Acceptance complete' })).toBeVisible();

  const sent = await posts(page);
  expect(sent.map((row) => [row['line_condition'], row['received_qty']])).toEqual([
    ['GOOD', '90'],
    ['DAMAGED', '2'],
    ['GOOD', '88'],
  ]);
  expect(sent[2]!['grn_id']).toBe(sent[0]!['grn_id']);
  expect(sent[2]!['grn_line_id']).toBe(sent[0]!['grn_line_id']);
});

test('a count of zero on every line is refused and posts nothing', async ({ page }) => {
  await provisionStores(page);
  await page.goto(ACCEPT);
  await page.getByLabel('Good', { exact: true }).fill('0');
  await takeMaterialPhoto(page);
  await page.getByRole('button', { name: 'Complete acceptance' }).click();
  await expect(page.getByText('Nothing was counted on any line')).toBeVisible();
  expect(await posts(page)).toHaveLength(0);
});

test('an arrival that is not weighed and matched does not open for acceptance', async ({
  page,
}) => {
  await provisionStores(page);
  await page.goto('/stores/accept?gate=99999999-9999-4999-8999-999999999992');
  await expect(
    page.getByText('This arrival is not open for acceptance at this site.'),
  ).toBeVisible();
});

test('a scanned lot opens the lot sheet with Report damage', async ({ page }) => {
  await provisionStores(page, { knownLot: 'LOT-9' });
  await page.goto('/stores');
  const scan = page.getByRole('textbox', { name: 'Scan anything' });
  await scan.fill(' LOT-9 ');
  await scan.press('Enter');
  await expect(page.getByRole('heading', { name: 'Lot LOT-9' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Report damage' })).toHaveAttribute(
    'href',
    '/damage/new?lot=LOT-9',
  );
});
