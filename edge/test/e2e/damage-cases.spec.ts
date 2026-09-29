import { test, expect, type Page } from '@playwright/test';
import { CASES, provisionDamage, type Persona } from '../fixtures/damage-stub';

// Story 8.9 (AC 2, 3, 4, 8, 10; Tables 11 and 14): the damage cases workbench, one persona per
// role. The stub hands the screen `allowed_actions`; the screen renders exactly those panels.

async function open(page: Page, persona: Persona, caseId?: string, actionDelayMs = 0) {
  await provisionDamage(page, { persona, actionDelayMs });
  await page.goto(caseId ? `/damage/cases?case=${caseId}` : '/damage/cases');
  await expect(
    page.getByRole('navigation', { name: 'Primary navigation' }).getByRole('link', { name: 'Damage cases' }),
  ).toBeVisible();
}

function group(page: Page, name: string) {
  return page.getByRole('region', { name });
}

function caseHeader(page: Page, number: string) {
  return page.getByRole('heading', { level: 3, name: new RegExp(`^${number} - `) });
}

async function posts(page: Page) {
  return page.evaluate(
    () => (window as unknown as { __damagePosts: Array<{ path: string; body: Record<string, unknown> }> }).__damagePosts,
  );
}

test('QC inspector: grouped list, mark arrived, inspect, send for an external check', async ({ page }) => {
  await open(page, 'qc_inspector');
  await expect(group(page, 'Damage reported - to inspect').getByRole('listitem')).toHaveCount(2);
  const toMove = group(page, 'Units to move').getByRole('listitem');
  // The overdue external check leads "Units to move".
  await expect(toMove.nth(0)).toContainText(CASES.overdue.number);
  await expect(toMove.nth(0)).toContainText('Return overdue since 2026-09-01');
  await expect(toMove.nth(1)).toContainText(CASES.arrival.number);

  await group(page, 'Damage reported - to inspect')
    .getByRole('link', { name: new RegExp(CASES.arrival.number) })
    .click();
  await expect(page).toHaveURL(new RegExp(`\\?case=${CASES.arrival.id}$`));
  const header = caseHeader(page, CASES.arrival.number);
  await expect(header).toBeFocused();
  await expect(page.getByText('Booked in QC hold - awaiting arrival')).toBeVisible();
  await expect(page.getByText('IND-2026-0107 raised (same flow)')).toBeVisible();
  await expect(page.getByText('Reported by Arif Ansari, employee')).toBeVisible();
  await expect(page.getByRole('img', { name: 'Photo of the reported damage' })).toBeVisible();
  // Only the panels the server allowed: no key, CEO or finance actions for the inspector.
  await expect(page.getByRole('button', { name: /Concur|Record CEO decision|Record and close|Hold whole lot/ })).toHaveCount(0);

  await page.getByRole('button', { name: 'Mark arrived in QC hold' }).click();
  await expect(page.getByRole('status', { name: 'Damage cases status' })).toHaveText('Marked arrived in QC hold.');
  await expect(header).toBeFocused();
  await expect(page.getByText('In QC hold', { exact: true })).toBeVisible();

  // A required field stays required: recording with no quantity says so and focuses it.
  await page.getByRole('button', { name: 'Record inspection' }).click();
  await expect(page.getByText('Enter a quantity from 0 to 4.')).toBeVisible();
  await expect(page.getByLabel('Confirmed damaged quantity (of 4)')).toBeFocused();
  await page.getByLabel('Confirmed damaged quantity (of 4)').fill('3');
  await page.getByRole('button', { name: 'Record inspection' }).click();
  await expect(page.getByText('Choose a defect code for confirmed damage.')).toBeVisible();
  await page.getByLabel('Defect code').selectOption('FUNCTIONAL');
  await page.getByRole('button', { name: 'Record inspection' }).click();
  await expect(page.getByRole('status', { name: 'Damage cases status' })).toHaveText('Inspection recorded.');
  await expect(page.getByText('Damage confirmed: 3 of 4')).toBeVisible();

  await page.getByRole('button', { name: 'Send for external check' }).click();
  await expect(page.getByText('Enter where the units are going.')).toBeVisible();
  await page.getByLabel('Destination (required)').fill('NABL lab, Noida');
  await page.getByLabel('Why they are going (required)').fill('Confirm the failure mode');
  await page.getByLabel('Expected return date').fill('2026-10-10');
  await page.getByRole('button', { name: 'Send for external check' }).click();
  await expect(page.getByText(/^Out for external check at NABL lab, Noida since .* - awaiting return$/)).toBeVisible();

  expect((await posts(page)).map((entry) => entry.path)).toEqual([
    'custody/arrived',
    'inspection',
    'custody/sent-external',
  ]);
  const inspection = (await posts(page))[1]!.body;
  expect(inspection).toMatchObject({ confirmed_quantity: '3', defect_code: 'FUNCTIONAL' });
  expect(String(inspection['idempotency_key'])).toMatch(/^edge-damage-inspect-/);
});

test('in flight, every sibling action is disabled', async ({ page }) => {
  await open(page, 'qc_inspector', CASES.arrival.id, 800);
  await page.getByRole('button', { name: 'Mark arrived in QC hold' }).click();
  await expect(page.getByRole('button', { name: 'Record inspection' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Mark arrived in QC hold' })).toBeDisabled();
  await expect(page.getByRole('status', { name: 'Damage cases status' })).toHaveText('Marked arrived in QC hold.');
  await expect(page.getByRole('button', { name: 'Record inspection' })).toBeEnabled();
});

test('QC head: decides the whole-lot request, then turns the QC key', async ({ page }) => {
  await open(page, 'qc_head', CASES.arrival.id);
  await expect(page.getByText('Suspect whole lot - requested')).toBeVisible();
  await expect(page.getByText('You decide lot-wide hold as QC head.')).toBeVisible();
  await page.getByRole('button', { name: 'Hold whole lot' }).click();
  await expect(page.getByText('Enter a reason.')).toBeVisible();
  await expect(page.getByLabel('Reason (required)')).toBeFocused();
  await page.getByLabel('Reason (required)').fill('Same supplier batch failed twice');
  await page.getByRole('button', { name: 'Hold whole lot' }).click();
  await expect(page.getByRole('status', { name: 'Damage cases status' })).toHaveText('Whole-lot decision recorded.');
  await expect(page.getByText('Whole lot LOT-7 everywhere')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Hold whole lot' })).toHaveCount(0);

  await group(page, 'Awaiting your key').getByRole('link', { name: new RegExp(CASES.qcKey.number) }).click();
  await expect(caseHeader(page, CASES.qcKey.number)).toBeFocused();
  await expect(page.getByText('Photo not yet uploaded')).toBeVisible();
  await expect(page.getByText('0 of 2 concurred')).toBeVisible();
  await page.getByRole('radio', { name: 'Write-off' }).check();
  await page.getByRole('button', { name: 'Concur: Write-off' }).click();
  await expect(page.getByRole('status', { name: 'Damage cases status' })).toHaveText('Your key is turned.');
  await expect(page.getByText('1 of 2 concurred')).toBeVisible();
  await expect(page.getByText(/^You concurred, .*\. Waiting for finance\. The outcome locks when both concur\.$/)).toBeVisible();
  await expect(group(page, 'Sent on - finance or CEO')).toContainText(CASES.qcKey.number);
  expect((await posts(page)).map((entry) => [entry.path, entry.body['decision'] ?? entry.body['outcome']])).toEqual([
    ['whole-lot', 'hold_lot'],
    ['keys/qc/turn', 'write_off'],
  ]);
});

test('finance: turns its key with the QC outcome, then records the ERP reference', async ({ page }) => {
  await open(page, 'finance', CASES.financeKey.id);
  const keys = page.getByRole('region', { name: 'Concurrence - QC and finance either can go first' });
  await expect(keys).toContainText('Concurred');
  await expect(keys).toContainText('Quratulain Head');
  // The QC outcome is preselected; concurring with it locks the case.
  await expect(page.getByRole('radio', { name: 'Debit note to supplier' })).toBeChecked();
  await expect(page.getByRole('button', { name: 'Disagree with QC outcome' })).toBeVisible();
  await page.getByRole('button', { name: 'Concur: Debit note to supplier' }).click();
  await expect(page.getByRole('status', { name: 'Damage cases status' })).toHaveText('Your key is turned.');
  await expect(keys).toContainText('Both concurred - outcome locked.');
  await expect(keys).toContainText('2 of 2 concurred');

  await page.getByRole('button', { name: 'Record and close' }).click();
  await expect(page.getByText('Enter the ERP document number (up to 64 characters).')).toBeVisible();
  await page.getByLabel('ERP document number').fill('ERP-DN-0042');
  await page.getByRole('button', { name: 'Record and close' }).click();
  await expect(page.getByRole('status', { name: 'Damage cases status' })).toHaveText(
    'ERP reference recorded - case closed.',
  );
  await expect(page.getByText('Closed - ERP ERP-DN-0042')).toBeVisible();
  await expect(group(page, 'Closed (last 30 days)')).toContainText(CASES.financeKey.number);
});

test('finance: a disagreement needs a reason and escalates to the CEO', async ({ page }) => {
  await open(page, 'finance', CASES.financeKey.id);
  await page.getByRole('button', { name: 'Disagree with QC outcome' }).click();
  await page.getByRole('radio', { name: 'Write-off' }).last().check();
  await page.getByRole('button', { name: 'Disagree - escalate to CEO' }).click();
  await expect(page.getByLabel('Why do you disagree? (required)')).toBeFocused();
  await page.getByLabel('Why do you disagree? (required)').fill('Supplier will not accept a debit note');
  await page.getByRole('button', { name: 'Disagree - escalate to CEO' }).click();
  await expect(page.getByRole('status', { name: 'Damage cases status' })).toHaveText(
    'Disagreement recorded - escalated to the CEO.',
  );
  await expect(page.getByText('CEO: decides. QC and finance can no longer edit this case.')).toBeVisible();
  await expect(page.getByText('With the CEO - Nothing more for you until the CEO decides.')).toBeVisible();
});

test('CEO: sees both positions and records the decision', async ({ page }) => {
  await open(page, 'ceo');
  await group(page, 'With the CEO - decide').getByRole('link', { name: new RegExp(CASES.escalated.number) }).click();
  const decision = page.getByRole('region', { name: 'CEO decision' });
  await expect(decision).toContainText('QC position');
  await expect(decision).toContainText('Write-off');
  await expect(decision).toContainText('Finance position');
  await expect(decision).toContainText('Debit note to supplier');
  await decision.getByRole('radio', { name: 'Accept as-is with price reduction' }).check();
  await decision.getByLabel('Price reduction % (above 0, up to 100)').fill('0');
  await decision.getByLabel('Reason (required)').fill('Usable with rework');
  await decision.getByRole('button', { name: 'Record CEO decision' }).click();
  await expect(page.getByText('Enter a price reduction above 0 and up to 100.')).toBeVisible();
  await decision.getByLabel('Price reduction % (above 0, up to 100)').fill('15');
  await decision.getByRole('button', { name: 'Record CEO decision' }).click();
  await expect(page.getByRole('status', { name: 'Damage cases status' })).toHaveText('CEO decision recorded.');
  await expect(
    page.getByText('Final outcome: Accept as-is with price reduction (15%), decided by the CEO (Chandra Rao)'),
  ).toBeVisible();
  expect((await posts(page))[0]).toMatchObject({
    path: 'escalation/decide',
    body: { outcome: 'accept_as_is_price_reduction', price_reduction_pct: '15', reason: 'Usable with rework' },
  });
});

test('stores: marks the overdue external check returned and the reported units arrived', async ({ page }) => {
  await open(page, 'stores', CASES.overdue.id);
  await expect(page.getByText('Out for external check at NABL lab, Noida', { exact: false })).toBeVisible();
  await expect(page.getByText('Return overdue since 2026-09-01').first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Record inspection' })).toHaveCount(0);
  await page.getByLabel('External result reference').fill('NABL-2026-8841');
  await page.getByRole('button', { name: 'Mark returned' }).click();
  await expect(page.getByRole('status', { name: 'Damage cases status' })).toHaveText('Marked returned.');
  await expect(page.getByText('In QC hold', { exact: true })).toBeVisible();

  await group(page, 'Units to move').getByRole('link', { name: new RegExp(CASES.arrival.number) }).click();
  await page.getByRole('button', { name: 'Mark arrived in QC hold' }).click();
  await expect(page.getByRole('status', { name: 'Damage cases status' })).toHaveText('Marked arrived in QC hold.');
  const history = page.getByRole('region', { name: 'History' }).getByRole('listitem');
  await expect(history.nth(0)).toContainText('Arrived in QC hold');
  await expect(history.nth(0)).toContainText('Sunil Stores (store_assistant)');
  expect((await posts(page)).map((entry) => entry.path)).toEqual(['custody/returned', 'custody/arrived']);
});

test('a reporter without workbench scope is told so; offline needs a live connection', async ({
  page,
  context,
}) => {
  await provisionDamage(page, {
    persona: 'reporter',
    navigation: ['Dashboard', 'Frontline', 'Report damage', 'Damage cases'],
  });
  await page.goto('/damage/cases');
  await expect(page.getByText('Your access does not include damage cases.', { exact: false })).toBeVisible();
  await expect(page.getByText('server message never shown')).toHaveCount(0);

  await open(page, 'qc_inspector');
  await expect(group(page, 'Damage reported - to inspect')).toBeVisible();
  await context.setOffline(true);
  await expect(page.getByText('Approvals need a live connection')).toBeVisible();
  await expect(page.getByRole('main').getByRole('listitem')).toHaveCount(0);
  await context.setOffline(false);
});
