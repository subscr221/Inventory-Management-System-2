import { expect, test, type Page } from '@playwright/test';
import { signIn, simTag } from './auth';
import { expectOutboxDrained } from './sync';

// Floor staff on a normal shift: the indent raiser asks for stores items, the technician
// reports a fault on a pack asset. Both captures go to the local outbox and must sync.

// Pilot SKUs from docs/migration/pilot-mock-extract/opening_stock.csv, excluding BRG-6204
// (kept for the repeat-request test) and CON-GLOVES (used by the operations smoke).
const CLEAN_SKUS = [
  'BRG-6306', 'SEAL-35MM', 'CON-GRIND-DISC', 'FAST-M8-BOLT', 'FAST-M10-NUT', 'WELD-WIRE-1.2',
  'PKG-CARTON-S', 'PKG-CARTON-L', 'PKG-PALLET', 'GEARBOX-40', 'MTR-3.7KW', 'MTR-7.5KW', 'VFD-5HP',
  'RM-ROD-12MM', 'RM-ROD-16MM', 'RM-SHEET-1MM', 'RM-SHEET-2MM', 'RM-PLATE-6MM', 'RM-PIPE-25NB',
];
// Statuses the server counts as an open duplicate (findOpenDuplicate).
const OPEN_STATUSES = new Set(['raised', 'pending-confirmation', 'approved']);

function needByDate(daysAhead: number): string {
  return new Date(Date.now() + daysAhead * 86_400_000).toISOString().slice(0, 10);
}

/** The signed-in person's own indents, read with their own token. */
async function myIndents(page: Page): Promise<Array<{ status: string; reason: string | null; indent_number_ext: string }>> {
  const body = await page.evaluate(async () => {
    const key = Object.keys(localStorage).find((k) => k.startsWith('oidc.user:'));
    const token = key ? (JSON.parse(localStorage.getItem(key) ?? '{}') as { access_token?: string }).access_token : '';
    const res = await fetch('/api/v1/indents?mine=true&limit=200', { headers: { Authorization: `Bearer ${token}` } });
    return { status: res.status, text: await res.text() };
  });
  expect(body.status, `indent listing: ${body.text.slice(0, 300)}`).toBe(200);
  return (JSON.parse(body.text) as { indents: Array<{ status: string; reason: string | null; indent_number_ext: string }> }).indents;
}

async function raiseIndent(page: Page, sku: string, qty: string, note: string): Promise<void> {
  if (new URL(page.url()).pathname !== '/') await page.goto('/');
  const form = page.locator('section.indent-capture');
  await expect(form.getByRole('heading', { name: 'Raise purchase requisition' })).toBeVisible();
  await form.getByLabel('Item SKU').fill(sku);
  await form.getByLabel('Item category').fill('spares');
  await form.getByLabel('Quantity').fill(qty);
  await form.getByLabel('Unit of measure').fill('EA');
  await form.getByLabel('Estimated unit price (INR)').fill('145');
  await form.getByLabel('Need-by date').fill(needByDate(14));
  await form.getByLabel('Department').fill('STORES');
  await form.getByLabel('Business stream').fill('production');
  // The SKU goes into the reason so later runs can tell which SKUs already have an open request.
  await form.getByLabel('Reason').fill(`${simTag()} ${sku} ${note}`);
  await form.getByRole('button', { name: 'Raise requisition' }).click();

  const result = page.getByRole('status', { name: 'Requisition capture result' });
  await expect(result).toContainText('Captured - pending sync');
  await expect(result).not.toContainText('Correct the highlighted fields');
}

test('indent1 raises a requisition for a pilot SKU and it syncs', async ({ page }) => {
  await signIn(page, 'indent1@ancorlabs.org', '/');

  const open = (await myIndents(page)).filter((i) => OPEN_STATUSES.has(i.status));
  const sku = CLEAN_SKUS.find((s) => !open.some((i) => (i.reason ?? '').includes(` ${s} `)));
  test.skip(!sku, 'every pilot SKU already has an open SIM requisition by indent1 in the duplicate window');
  test.info().annotations.push({ type: 'sku', description: sku! });

  await raiseIndent(page, sku!, '12', 'stock for press line');
  await expectOutboxDrained(page);
});

test('indent1 repeats a requisition for the same SKU; it is held for confirmation, not refused', async ({ page }) => {
  // Regression guard: until 2026-09-23 this capture was refused 409 STREAM_CONFLICT (the
  // duplicate-flag event took version 1 of the new stream before the capture was inserted).
  await signIn(page, 'indent1@ancorlabs.org', '/');
  const hasOpen = (await myIndents(page)).some(
    // The first SIM run (IND-2026-0005) predates the SKU-in-reason format.
    (i) => OPEN_STATUSES.has(i.status) && /BRG-6204|^SIM .*bearing stock/.test(i.reason ?? ''),
  );
  if (!hasOpen) {
    await raiseIndent(page, 'BRG-6204', '12', 'bearing stock for press line');
    await expectOutboxDrained(page);
  }
  await raiseIndent(page, 'BRG-6204', '6', 'repeat request, same bearing');
  await expectOutboxDrained(page);
});

test('maint1 reports a fault on a pack asset and it syncs', async ({ page }) => {
  await signIn(page, 'maint1@ancorlabs.org', '/maintenance');

  await page.getByLabel('Asset tag').fill('AST-LATHE-02');
  await page.getByLabel('Fault description').fill(`${simTag()} spindle noise at high speed, checked by technician`);
  await page.getByRole('button', { name: 'Report fault' }).click();

  const result = page.getByRole('status', { name: 'Fault report capture result' });
  await expect(result).toContainText('Captured - pending sync');

  await expectOutboxDrained(page);
});
