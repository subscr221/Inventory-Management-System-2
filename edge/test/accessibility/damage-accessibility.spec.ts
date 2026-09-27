import { test, expect, type Locator, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { CASES, PHOTO_FILE, provisionDamage } from '../fixtures/damage-stub';

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

async function expectNoViolations(page: Page) {
  expect((await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze()).violations).toEqual([]);
}

/** Real Tab presses until the target has focus (keyboard evidence, not .focus()). */
async function tabTo(page: Page, target: Locator, limit = 80) {
  for (let i = 0; i < limit && !(await target.evaluate((el) => el === document.activeElement)); i += 1) {
    await page.keyboard.press('Tab');
  }
  await expect(target).toBeFocused();
}

// Story 8.9: the damage screens populated, with every option open, done, denied and offline.
test('report damage, fully expanded, has no automated WCAG 2.1 AA violations and 56px scan inputs', async ({
  page,
}) => {
  await provisionDamage(page);
  await page.goto('/damage/new');
  await expect(
    page.getByRole('navigation', { name: 'Primary navigation' }).getByRole('link', { name: 'Report damage' }),
  ).toBeVisible();
  await page.getByRole('radio', { name: /^Other/ }).check();
  await page.getByRole('checkbox', { name: /Request replacement/ }).check();
  await page.getByLabel('Take photo').setInputFiles(PHOTO_FILE);
  await expectNoViolations(page);
  for (const label of ['Item code (SKU)', 'Lot number', 'Bin']) {
    await expect(page.getByLabel(label, { exact: true })).toHaveCSS('min-height', '56px');
  }
  await expect(page.getByRole('button', { name: 'Send damage report' })).toHaveCSS('min-height', '44px');
});

test('report damage is operable from the keyboard alone, through to the done screen', async ({ page }) => {
  await provisionDamage(page);
  await page.goto('/damage/new');
  await expect(
    page.getByRole('navigation', { name: 'Primary navigation' }).getByRole('link', { name: 'Report damage' }),
  ).toBeVisible();
  await page.locator('body').click({ position: { x: 1, y: 1 } });
  await tabTo(page, page.getByLabel('Item code (SKU)'));
  await page.keyboard.type('PCB-CTRL-01');
  await page.keyboard.press('Enter'); // the scanner's Enter: focus goes to the first missing part
  await expect(page.getByLabel('Bin', { exact: true })).toBeFocused();
  await page.keyboard.type('CMF-STORE-A1');
  await page.keyboard.press('Tab');
  await expect(page.getByLabel('Quantity affected')).toBeFocused();
  await page.keyboard.type('1');
  await page.keyboard.press('Tab');
  // Radio group: Tab enters it, Space selects the focused reason.
  await expect(page.getByRole('radio', { name: /Dead on arrival/ })).toBeFocused();
  await page.keyboard.press('Space');
  await expect(page.getByRole('radio', { name: /Dead on arrival/ })).toBeChecked();
  await page.getByLabel('Take photo').setInputFiles(PHOTO_FILE);
  await tabTo(page, page.getByRole('button', { name: 'Send damage report' }));
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Captured - pending sync' })).toBeFocused();
  await expectNoViolations(page);
});

test('the workbench list and a case with key actions have no automated WCAG 2.1 AA violations', async ({
  page,
}) => {
  await provisionDamage(page, { persona: 'qc_head' });
  await page.goto(`/damage/cases?case=${CASES.arrival.id}`);
  await expect(page.getByRole('button', { name: 'Hold whole lot' })).toBeVisible();
  await expectNoViolations(page);

  await provisionDamage(page, { persona: 'finance' });
  await page.goto(`/damage/cases?case=${CASES.financeKey.id}`);
  await expect(page.getByRole('button', { name: 'Concur: Debit note to supplier' })).toBeVisible();
  await page.getByRole('button', { name: 'Disagree with QC outcome' }).click();
  await expectNoViolations(page);

  await provisionDamage(page, { persona: 'ceo' });
  await page.goto(`/damage/cases?case=${CASES.escalated.id}`);
  await expect(page.getByRole('button', { name: 'Record CEO decision' })).toBeVisible();
  await expectNoViolations(page);
});

test('a case is reached, acted on and re-announced with real Tab presses; focus returns to its header', async ({
  page,
}) => {
  await provisionDamage(page, { persona: 'stores' });
  await page.goto('/damage/cases');
  const link = page
    .getByRole('region', { name: 'Units to move' })
    .getByRole('link', { name: new RegExp(CASES.arrival.number) });
  await expect(link).toBeVisible();
  await page.locator('body').click({ position: { x: 1, y: 1 } });
  await tabTo(page, link, 120);
  await page.keyboard.press('Enter');
  const header = page.getByRole('heading', { level: 3, name: new RegExp(`^${CASES.arrival.number} - `) });
  await expect(header).toBeFocused();
  await tabTo(page, page.getByRole('button', { name: 'Mark arrived in QC hold' }));
  await page.keyboard.press('Enter');
  await expect(page.getByRole('status', { name: 'Damage cases status' })).toHaveText('Marked arrived in QC hold.');
  await expect(header).toBeFocused();
  await expectNoViolations(page);
});

test('the no-access and needs-connection cards have no automated WCAG 2.1 AA violations', async ({
  page,
  context,
}) => {
  await provisionDamage(page, {
    persona: 'reporter',
    navigation: ['Dashboard', 'Frontline', 'Report damage', 'Damage cases'],
  });
  await page.goto('/damage/cases');
  await expect(page.getByText('Your access does not include damage cases.', { exact: false })).toBeVisible();
  await expectNoViolations(page);

  await provisionDamage(page, { persona: 'qc_inspector' });
  await page.goto('/damage/cases');
  await expect(page.getByRole('region', { name: 'Damage reported - to inspect' })).toBeVisible();
  await context.setOffline(true);
  await expect(page.getByText('Approvals need a live connection')).toBeVisible();
  await expectNoViolations(page);
  await context.setOffline(false);
});
