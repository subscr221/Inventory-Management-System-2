import { test, expect } from '@playwright/test';
import {
  provisionRefusedCaptures,
  NEWEST_REFUSAL_ID,
  OLDER_REFUSAL_ID,
  TECHNICIAN_ID,
  USER_ID,
} from '../fixtures/refused-captures-stub';

// Story 1.14: the refused-captures supervisor screen (AC 1, 2, 3, 5) against stubbed Story 1.13
// routes. The DOA gate itself is owned by test/integration/story-1-13.test.ts; here each error
// code only has to reach the operator as its en.json copy.

const PATH = '/supervisor/refused-captures';

test('lists a site\'s open refusals newest first, resolves one with a note, and shows it under Resolved', async ({ page }) => {
  await provisionRefusedCaptures(page);
  await page.goto(PATH);

  const navLink = page.getByRole('navigation', { name: 'Primary navigation' }).getByRole('link', { name: 'Refused captures' });
  await expect(navLink).toBeVisible();
  await expect(navLink).toHaveAttribute('href', PATH);

  const open = page.getByRole('region', { name: 'Open refusals' });
  const resolved = page.getByRole('region', { name: 'Resolved' });
  const openCards = open.getByRole('listitem');
  await expect(openCards).toHaveCount(2);

  // AC 1: newest first, and the five facts as a description list, not a table.
  const newest = openCards.nth(0);
  await expect(newest).toContainText('ASSET_NOT_FOUND');
  await expect(newest).toContainText('No asset matches the scanned tag.');
  await expect(newest).toContainText(TECHNICIAN_ID);
  await expect(newest).toContainText('maintenance_technician');
  await expect(newest).toContainText('TABLET-07');
  await expect(newest).toContainText('maintenance.fault_reported (maintenance)');
  await expect(newest.getByRole('term').first()).toHaveText('Refused on');
  await expect(openCards.nth(1)).toContainText('MODULE_ACCESS_DENIED');
  await expect(page.getByRole('table')).toHaveCount(0);
  await expect(resolved.getByRole('listitem')).toHaveCount(1);
  await expect(resolved).toContainText('Meter re-registered; technician re-captured the reading.');

  // AC 3: two-tap resolve with a mandatory note.
  await newest.getByRole('button', { name: 'Resolve' }).click();
  const note = page.getByLabel('Resolution note');
  await expect(note).toBeVisible();
  await expect(note).toBeFocused();
  await newest.getByRole('button', { name: 'Confirm resolve' }).click();
  await expect(newest.getByRole('status')).toContainText('Enter a resolution note');
  await expect(openCards).toHaveCount(2);

  await note.fill('Asset registered as PILOT-CHECK-001; technician re-captured the fault.');
  await newest.getByRole('button', { name: 'Confirm resolve' }).click();

  await expect(openCards).toHaveCount(1);
  await expect(open).not.toContainText('ASSET_NOT_FOUND');
  await expect(resolved.getByRole('listitem')).toHaveCount(2);
  const resolvedCard = resolved.getByRole('listitem').nth(0);
  await expect(resolvedCard).toContainText('Asset registered as PILOT-CHECK-001; technician re-captured the fault.');
  await expect(resolvedCard).toContainText(USER_ID);
  await expect(resolvedCard).toContainText('ASSET_NOT_FOUND');
  await expect(resolvedCard).toContainText('maintenance.fault_reported (maintenance)');
  await expect(page.getByRole('status', { name: 'Refused captures status' })).toContainText('Resolved.');
});

test('a resolve the API refuses keeps the card and shows the operator copy for its error code', async ({ page }) => {
  await provisionRefusedCaptures(page, {
    resolveError: {
      status: 403,
      error_code: 'APPROVAL_REQUIRED',
      details: { refusal_id: NEWEST_REFUSAL_ID, resolved_approver_user_id: USER_ID },
    },
  });
  await page.goto(PATH);
  const open = page.getByRole('region', { name: 'Open refusals' });
  const card = open.getByRole('listitem').nth(0);
  await card.getByRole('button', { name: 'Resolve' }).click();
  await page.getByLabel('Resolution note').fill('Trying anyway');
  await card.getByRole('button', { name: 'Confirm resolve' }).click();
  await expect(card.getByRole('status')).toContainText(
    'This action requires approval from the resolved approver before it can proceed.',
  );
  await expect(card).not.toContainText('server message never shown');
  await expect(open.getByRole('listitem')).toHaveCount(2);
  await expect(page.getByLabel('Resolution note')).toBeVisible();
  await card.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByLabel('Resolution note')).toHaveCount(0);
});

test('a refusal someone else already resolved leaves the open list with what the API said', async ({ page }) => {
  await provisionRefusedCaptures(page, {
    resolveError: {
      status: 409,
      error_code: 'REFUSED_CAPTURE_ALREADY_RESOLVED',
      details: { refusal_id: OLDER_REFUSAL_ID, resolved_by: TECHNICIAN_ID, resolved_at: '2026-09-17T07:10:00.000Z' },
    },
  });
  await page.goto(PATH);
  const open = page.getByRole('region', { name: 'Open refusals' });
  const resolved = page.getByRole('region', { name: 'Resolved' });
  const card = open.getByRole('listitem').nth(1);
  await expect(card).toContainText('MODULE_ACCESS_DENIED');
  await card.getByRole('button', { name: 'Resolve' }).click();
  await page.getByLabel('Resolution note').fill('Second supervisor');
  await card.getByRole('button', { name: 'Confirm resolve' }).click();
  await expect(open.getByRole('listitem')).toHaveCount(1);
  await expect(resolved.getByRole('listitem').nth(0)).toContainText(TECHNICIAN_ID);
  await expect(page.getByRole('status', { name: 'Refused captures status' })).toContainText(
    'Someone else already resolved this capture.',
  );
});

test('a 403 from the list shows the no-access copy and no rows', async ({ page }) => {
  await provisionRefusedCaptures(page, { listStatus: 403 });
  await page.goto(PATH);
  await expect(page.getByText('Your role does not cover refused captures at this site.')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Open refusals' })).toHaveCount(0);
  await expect(page.getByRole('listitem')).toHaveCount(0);
});

test('offline shows the needs-connection card and nothing from the previous fetch', async ({ page, context }) => {
  await provisionRefusedCaptures(page);
  await page.goto(PATH);
  await expect(page.getByRole('region', { name: 'Open refusals' }).getByRole('listitem')).toHaveCount(2);

  await context.setOffline(true);
  await expect(page.getByText('This list needs a connection.')).toBeVisible();
  await expect(page.getByRole('listitem')).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Open refusals' })).toHaveCount(0);
  const check = page.getByRole('button', { name: 'Check connection' });
  await expect(check).toBeVisible();
  await check.click();
  await expect(page.getByText('This list needs a connection.')).toBeVisible();

  await context.setOffline(false);
  await expect(page.getByRole('region', { name: 'Open refusals' }).getByRole('listitem')).toHaveCount(2);
});

test('the navigation entry is absent when the bootstrap does not advertise it', async ({ page }) => {
  await provisionRefusedCaptures(page, { navigation: ['Dashboard', 'Frontline'] });
  await page.goto('/');
  const nav = page.getByRole('navigation', { name: 'Primary navigation' });
  await expect(nav.getByRole('link', { name: 'Frontline' })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Refused captures' })).toHaveCount(0);
});

test('keyboard-only: tab order reaches every Resolve, Confirm and Cancel control', async ({ page }) => {
  await provisionRefusedCaptures(page);
  await page.goto(PATH);
  await expect(page.getByRole('region', { name: 'Open refusals' }).getByRole('listitem')).toHaveCount(2);

  await page.keyboard.press('Tab');
  await expect(page.getByText('Skip to content')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Dashboard' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Frontline' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Refused captures' })).toBeFocused();
  await page.keyboard.press('Tab');
  const openCards = page.getByRole('region', { name: 'Open refusals' }).getByRole('listitem');
  const firstResolve = openCards.nth(0).getByRole('button', { name: 'Resolve', exact: true });
  const secondResolve = openCards.nth(1).getByRole('button', { name: 'Resolve', exact: true });
  await expect(firstResolve).toBeFocused();
  await expect(firstResolve).toHaveCSS('min-height', '44px');
  await expect(firstResolve).toHaveCSS('outline-style', 'solid');

  await page.keyboard.press('Enter');
  const note = page.getByLabel('Resolution note');
  await expect(note).toBeFocused();
  await expect(note).toHaveCSS('outline-style', 'solid');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Confirm resolve' })).toBeFocused();
  await expect(page.getByRole('button', { name: 'Confirm resolve' })).toHaveCSS('min-height', '44px');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(secondResolve).toBeFocused();
  // Escape hatch by keyboard: Shift+Tab back to Cancel, activate it, and the first card's Resolve returns.
  await page.keyboard.press('Shift+Tab');
  await expect(page.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('Resolution note')).toHaveCount(0);
  await expect(firstResolve).toBeVisible();
});

test('keyboard-only: Tab reaches the Check connection control on the offline card', async ({ page, context }) => {
  await provisionRefusedCaptures(page);
  await page.goto(PATH);
  await expect(page.getByRole('region', { name: 'Open refusals' }).getByRole('listitem')).toHaveCount(2);

  await context.setOffline(true);
  const check = page.getByRole('button', { name: 'Check connection' });
  await expect(check).toBeVisible();

  await page.keyboard.press('Tab');
  await expect(page.getByText('Skip to content')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Dashboard' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Frontline' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Refused captures' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(check).toBeFocused();
  await expect(check).toHaveCSS('min-height', '44px');
  await expect(check).toHaveCSS('outline-style', 'solid');
});
