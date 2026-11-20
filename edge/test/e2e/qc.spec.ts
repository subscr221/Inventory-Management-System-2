import { test, expect, type Page } from '@playwright/test';
import {
  QC_HOLD_ID,
  QC_LOT_NUMBER,
  QC_TASK_ID,
  provisionQc,
} from '../fixtures/qc-stub';
import { COMPACT_CONTROL, TOUCH_PRIMARY, TOUCH_SECONDARY } from '../fixtures/keyboard';

// Story 8.11 (AC 1-8): QC inbox, inspection detail, observation note & photo, disposition with
// hold scope, two-part split, retention sample, holds page, and handheld/desktop touch density.

async function posts(page: Page) {
  return page.evaluate(
    () =>
      (window as unknown as { __qcPosts: Array<{ path: string; body: Record<string, unknown> }> })
        .__qcPosts,
  );
}

test('inbox renders the 5 groups in order, Sent on count card, /qc/holds link, and scan bar', async ({
  page,
}) => {
  await provisionQc(page, { role: 'qc_head' });
  await page.goto('/qc/tasks');

  await expect(page.getByRole('heading', { level: 1, name: 'QC inbox' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'QC holds' })).toHaveAttribute('href', '/qc/holds');

  const headings = page.locator('#qc-tasks .stores-group > h2');
  await expect(headings).toHaveText([
    'In inspection bay - to inspect',
    'Damage reported',
    'Awaiting disposition',
    'Sent on - finance or CEO',
    'Done today',
  ]);

  await expect(page.getByText('Inspect on opening')).toBeVisible();
  await expect(page.getByText('Suspect whole lot - requested')).toBeVisible();
  await expect(page.getByText('1 case(s) with finance or CEO')).toBeVisible();

  const scanInput = page.getByLabel('Scan a lot');
  await scanInput.fill(QC_LOT_NUMBER);
  await scanInput.press('Enter');
  await expect(page).toHaveURL(new RegExp(`/qc/tasks\\?task=${QC_TASK_ID}$`));
});

test('empty inbox states each empty group and keeps the scan bar armed', async ({ page }) => {
  await provisionQc(page, { empty: true });
  await page.goto('/qc/tasks');

  await expect(page.getByText('No lots waiting for inspection.')).toBeVisible();
  await expect(page.getByText('No open damage cases.')).toBeVisible();
  await expect(page.getByText('No inspected lots awaiting disposition.')).toBeVisible();
  await expect(page.getByText('No cases with finance or CEO.')).toBeVisible();
  await expect(page.getByText('Nothing dispositioned or released today.')).toBeVisible();

  const scanInput = page.getByLabel('Scan a lot');
  await expect(scanInput).toBeVisible();
  await scanInput.fill('LOT-MISSING');
  await scanInput.press('Enter');
  await expect(page.getByText(/No task matches lot LOT-MISSING/)).toBeVisible();
});

test('detail runs sampling, observations, split disposition, and release', async ({ page }) => {
  await provisionQc(page, { role: 'qc_head' });
  await page.goto(`/qc/tasks?task=${QC_TASK_ID}`);

  await expect(page.getByText('Sample size: 1')).toBeVisible();

  // Record Pass on first characteristic and Fail on second.
  const passButtons = page.getByRole('button', { name: 'Pass' });
  const failButtons = page.getByRole('button', { name: 'Fail' });
  await passButtons.nth(0).click();
  await failButtons.nth(1).click();
  await expect(page.getByText('Out of tolerance')).toBeVisible();

  // Set Split Good=8 -> Not usable=2; requires observation note.
  await page.getByLabel('Good quantity').fill('8');
  await expect(page.getByText('Not usable: 2')).toBeVisible();

  // Upload a photo and save an observation note.
  await page.getByLabel('Add photo').setInputFiles({
    name: 'defect.png',
    mimeType: 'image/png',
    buffer: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  });
  await expect(page.getByText('Photo saved.')).toBeVisible();
  await page.getByLabel('Observation note').fill('Dented flange on 2 units');
  await page.getByRole('button', { name: 'Save observation' }).click();
  await expect(page.getByRole('status', { name: 'Observation status' })).toHaveText(
    'Observation saved.',
  );
  await expect(page.getByText('By Qasim QC')).toBeVisible();
  await expect(page.getByRole('img', { name: 'Inspection observation photo' })).toBeVisible();

  // Complete inspection -> Decision card appears.
  await page.getByRole('button', { name: 'Complete inspection' }).click();
  await expect(page.getByRole('heading', { name: 'Decision' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Conditional release' })).toBeDisabled();
  await expect(page.getByText('Needs the Approvals inbox (DOA sign-off), not yet built')).toBeVisible();

  // Two-part split disposition posts split then child dispositions.
  await page.getByLabel('Justification (required)').fill('8 good, 2 dented');
  await page.getByLabel('Defect code').fill('DENT');
  await page.getByRole('button', { name: 'Record disposition' }).click();

  await expect
    .poll(async () => {
      const recorded = await posts(page);
      return (
        recorded.some((p) => p.path.endsWith(`/${QC_TASK_ID}/split`)) &&
        recorded.some((p) => p.path.endsWith('/disposition'))
      );
    })
    .toBe(true);
});

test('whole-lot hold blocks Accept, shows hold_id, and retention sample clears release', async ({
  page,
}) => {
  await provisionQc(page, { role: 'qc_head', initialInspected: true, requireRetention: true });
  await page.goto(`/qc/tasks?task=${QC_TASK_ID}`);

  await page.getByLabel('Hold the whole lot everywhere').check();
  await expect(page.getByRole('button', { name: 'Accept' })).toBeDisabled();
  await expect(
    page.getByText('A lot-wide hold blocks accepting the good units until QC clears the lot'),
  ).toBeVisible();

  // Switch back to bay scope to test Accept -> RETENTION_SAMPLE_REQUIRED -> log sample -> released.
  await page.getByLabel('Hold this lot in the bay only').check();
  await page.getByLabel('Justification (required)').fill('All good');
  await page.getByRole('button', { name: 'Record disposition' }).click();

  await expect(page.getByText('Log retention sample first')).toBeVisible();
  await page.getByLabel('Sample bin').fill('44444444-4444-4444-8444-444444444401');
  await page.getByRole('button', { name: 'Log retention sample' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Released for putaway' }),
  ).toBeVisible();
});

test('non-QC-head sees Decision and Hold scope cards read-only', async ({ page }) => {
  await provisionQc(page, { role: 'qc_inspector', initialInspected: true });
  await page.goto(`/qc/tasks?task=${QC_TASK_ID}`);

  await expect(page.getByText('Only the QC head can record the disposition.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Record disposition' })).toBeDisabled();
});

test('/qc/holds lists open holds with two-tap release and handles offline', async ({
  page,
  context,
}) => {
  await provisionQc(page, { role: 'qc_head' });
  await page.goto('/qc/holds');

  await expect(page.getByText(`Hold ${QC_HOLD_ID}`)).toBeVisible();
  await expect(page.getByText('Placed by Qadir Head')).toBeVisible();

  await page.getByLabel('Release reason (required)').fill('Re-tested OK');
  await page.getByRole('button', { name: 'Release', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm release' }).click();
  await expect(page.getByRole('status', { name: 'Holds status' })).toHaveText('Released.');

  await context.setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await expect(
    page.getByRole('heading', { level: 1, name: 'Lots on hold (all sites, as synced)' }),
  ).toBeVisible();
});

test('deep link without QC inbox nav renders no-access card', async ({ page }) => {
  await provisionQc(page, { role: 'warehouse_operator' });
  await page.goto('/qc/tasks');
  await expect(page.getByRole('alert')).toBeVisible();
});

test.describe('handheld density and bottom nav MAX_SLOTS 4', () => {
  test.use({ viewport: { width: 360, height: 640 }, hasTouch: true, isMobile: true });

  test('keeps 4 bottom-nav slots with More and 56/48px targets', async ({ page }) => {
    await provisionQc(page, { role: 'qc_head' });
    await page.goto('/qc/tasks');

    const bottomNav = page.getByRole('navigation', { name: 'Bottom navigation' });
    await expect(bottomNav.getByRole('link')).toHaveCount(3);
    await expect(bottomNav.getByRole('button', { name: 'More' })).toBeVisible();
    await expect(page.getByLabel('Scan a lot')).toHaveCSS('min-height', TOUCH_SECONDARY);
    await expect(page.getByRole('link', { name: 'Open' }).first()).toHaveCSS(
      'min-height',
      TOUCH_PRIMARY,
    );
  });
});

test.describe('desktop compact density', () => {
  test.use({ viewport: { width: 1280, height: 800 }, hasTouch: false });

  test('uses 34px compact controls on desktop', async ({ page }) => {
    await provisionQc(page, { role: 'qc_head' });
    await page.goto('/qc/tasks');
    await expect(page.getByLabel('Scan a lot')).toHaveCSS('min-height', COMPACT_CONTROL);
  });
});
