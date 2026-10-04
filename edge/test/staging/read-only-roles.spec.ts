import { expect, test } from '@playwright/test';
import { forgetSignIn, personInHeader, signIn, signOut, type Person } from './auth';
import { syncBadge } from './sync';

// Finance, CFO, migration lead and site head: sign in, look around, sign out.

const people: Person[] = [
  'accounts@ancorlabs.org',
  'anupam@ancorlabs.org',
  'info@ancorlabs.org',
  'cmf_supervisor@ancorlabs.org',
];

for (const email of people) {
  test(`${email} signs in, sees their name, signs out to Keycloak`, async ({ page }) => {
    await signIn(page, email, '/');

    await expect(personInHeader(page, email)).toBeVisible();
    // accounts@ holds only all-sites (*) roles, so bootstrap answers 403 EDGE_NO_CONCRETE_SITE.
    // Until 2026-09-23 the header then showed a made-up "Raman Gate Officer"; now the person's
    // own name and a card that says no site is assigned.
    await expect(page.getByText('Raman Gate Officer')).toHaveCount(0);
    await expect(
      page.getByRole('heading', { name: 'No site is assigned to your account.' }),
    ).toHaveCount(email === 'accounts@ancorlabs.org' ? 1 : 0);
    await expect(syncBadge(page)).toBeVisible();
    await expect(syncBadge(page)).not.toContainText('Sync Error');
    await expect(page.getByRole('heading', { name: 'Sync failed - needs attention' })).toHaveCount(0);

    await signOut(page);
    // The cached session is dead after sign-out; the next run must log in again.
    forgetSignIn(email);
    await expect(page.locator('#username')).toBeVisible();
    await expect(page.locator('#kc-login')).toBeVisible();

    // Coming back to the app must not show the old person again.
    await page.goto('/');
    await expect
      .poll(() => new URL(page.url()).host, { timeout: 30_000 })
      .toBe('auth.ancorlabs.org');
  });
}
