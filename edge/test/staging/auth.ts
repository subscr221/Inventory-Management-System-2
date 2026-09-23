import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';

// Real Keycloak sign-in for the staging pilot simulation. Each person's browser state
// (Keycloak SSO cookies plus the oidc-client-ts user in localStorage) is cached under
// .auth/ so later tests skip the login form while the session is still good.

const AUTH_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '.auth');
const KEYCLOAK_HOST = 'auth.ancorlabs.org';

// Display names from docs/migration/pilot-mock-extract/roles.json. On staging some real
// accounts carry their email as the user name, so the header may show either.
export const PEOPLE = {
  'info@ancorlabs.org': 'Gagan Kumar',
  'accounts@ancorlabs.org': 'Finance Controller',
  'subscr@ancorlabs.org': 'Department Head',
  'anupam@ancorlabs.org': 'CFO',
  'cmf_supervisor@ancorlabs.org': 'Site Head',
  'indent1@ancorlabs.org': 'Kavita Singh',
  'maint1@ancorlabs.org': 'Arif Ansari',
  'maintsup1@ancorlabs.org': 'Deepak Chauhan',
} as const;

export type Person = keyof typeof PEOPLE;

export function pilotPassword(): string {
  const pw = process.env['PILOT_PW'];
  if (!pw) throw new Error('PILOT_PW is not set; export the staging pilot password first.');
  return pw;
}

/** "SIM 2026-09-23" style tag for every record the simulation creates. */
export function simTag(): string {
  return `SIM ${new Date().toISOString().slice(0, 10)}`;
}

function authFile(email: string): string {
  return path.join(AUTH_DIR, `${email.replace(/[^a-z0-9._-]/gi, '_')}.json`);
}

export function forgetSignIn(email: string): void {
  fs.rmSync(authFile(email), { force: true });
}

function onKeycloak(page: Page): boolean {
  try {
    return new URL(page.url()).host === KEYCLOAK_HOST;
  } catch {
    return false;
  }
}

/** The header line "<user name> · <site name>". */
export function identityLine(page: Page) {
  return page.locator('header .edge-brand p');
}

/** The header line, but only while it names this person (display name or email). */
export function personInHeader(page: Page, email: Person) {
  return identityLine(page).filter({ hasText: new RegExp(`^(${escape(PEOPLE[email])}|${escape(email)}) ·`) });
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function restoreCachedState(page: Page, email: string, appOrigin: string): Promise<void> {
  const file = authFile(email);
  if (!fs.existsSync(file)) return;
  const state = JSON.parse(fs.readFileSync(file, 'utf8')) as {
    cookies: Parameters<ReturnType<Page['context']>['addCookies']>[0];
    origins: Array<{ origin: string; localStorage: Array<{ name: string; value: string }> }>;
  };
  await page.context().addCookies(state.cookies);
  const entries = state.origins.find((o) => o.origin === appOrigin)?.localStorage ?? [];
  // Restore once per tab only, so a later sign-out is not undone by the next navigation.
  await page.addInitScript(
    ({ origin, items }) => {
      if (location.origin !== origin) return;
      if (sessionStorage.getItem('pilot-sim-restored')) return;
      sessionStorage.setItem('pilot-sim-restored', '1');
      for (const item of items) localStorage.setItem(item.name, item.value);
    },
    { origin: appOrigin, items: entries },
  );
}

async function fillKeycloak(page: Page, email: string): Promise<void> {
  const pw = pilotPassword();
  // Login form, then possibly a forced password update; loop until we leave Keycloak.
  for (let step = 0; step < 4 && onKeycloak(page); step += 1) {
    const newPw = page.locator('#password-new');
    const username = page.locator('#username');
    await expect(newPw.or(username).first()).toBeVisible();
    if (await newPw.isVisible()) {
      await newPw.fill(pw);
      await page.locator('#password-confirm').fill(pw);
      await page.locator('input[type="submit"], button[type="submit"]').first().click();
    } else {
      await username.fill(email);
      await page.locator('#password').fill(pw);
      await page.locator('#kc-login').click();
    }
    await page.waitForLoadState('domcontentloaded');
    const error = page.locator('#input-error, .kc-feedback-text, .pf-m-danger').first();
    if (onKeycloak(page) && (await error.isVisible().catch(() => false))) {
      const text = (await error.textContent())?.trim() ?? '';
      if (text && !(await newPw.isVisible())) throw new Error(`Keycloak refused ${email}: ${text}`);
    }
  }
}

/**
 * Sign in as a pilot person through the real Keycloak form and wait until the app shows
 * that person in the header. Lands on /maintenance unless another path is given.
 */
export async function signIn(page: Page, email: Person, landing = '/maintenance'): Promise<void> {
  const appOrigin = new URL(test.info().project.use.baseURL ?? 'https://ims-staging.ancorlabs.org').origin;
  await restoreCachedState(page, email, appOrigin);
  await page.goto(landing);

  const name = personInHeader(page, email);
  // Either the app renders the person (cached session) or we end up on Keycloak.
  await expect
    .poll(async () => onKeycloak(page) || (await name.isVisible().catch(() => false)), { timeout: 30_000 })
    .toBe(true);

  if (onKeycloak(page)) {
    await fillKeycloak(page, email);
    await page.waitForURL((url) => url.origin === appOrigin && !url.pathname.startsWith('/auth/callback'), {
      timeout: 30_000,
    });
  }
  await expect(name).toBeVisible({ timeout: 30_000 });

  fs.mkdirSync(AUTH_DIR, { recursive: true });
  await page.context().storageState({ path: authFile(email) });
}

/** Click Sign out and wait for the Keycloak login form to come back. */
export async function signOut(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.waitForURL((url) => url.host === KEYCLOAK_HOST, { timeout: 30_000 });
  // Keycloak may show a logout confirmation before the login form; follow it if present.
  const confirm = page.locator('#kc-logout');
  if (await confirm.isVisible().catch(() => false)) await confirm.click();
}
