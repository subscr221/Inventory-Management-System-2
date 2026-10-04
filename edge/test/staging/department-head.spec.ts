import { expect, test } from '@playwright/test';
import { PEOPLE, signIn, simTag } from './auth';

// The department head reviews refused captures for the site and resolves one that
// somebody else captured. Resolving your own capture is not the supervisor's job.

test('subscr reviews refused captures and resolves one captured by someone else', async ({ page }) => {
  await signIn(page, 'subscr@ancorlabs.org', '/supervisor/refused-captures');

  await expect(page.getByRole('heading', { name: 'Open refusals' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Resolved' })).toBeVisible();
  await expect(page.locator('#refused-captures')).not.toHaveAttribute('aria-busy', 'true');
  await expect(page.getByText('Your role does not cover refused captures')).toHaveCount(0);

  const openSection = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Open refusals' }) });
  const cards = openSection.locator('li.refused-card');
  const count = await cards.count();

  const own = [PEOPLE['subscr@ancorlabs.org'], 'subscr@ancorlabs.org'];
  // captured_by may be a user id rather than a name; also skip anything the header names.
  const me = ((await page.locator('header .edge-brand p').textContent()) ?? '').split(' · ')[0]?.trim();
  if (me) own.push(me);
  let target = -1;
  for (let i = 0; i < count; i += 1) {
    const capturedBy = (await cards.nth(i).locator('div').filter({ hasText: 'Captured by' }).locator('dd').textContent()) ?? '';
    if (!own.some((who) => capturedBy.includes(who))) {
      target = i;
      break;
    }
  }

  if (target < 0) {
    test.info().annotations.push({
      type: 'no-open-refusal',
      description: `${count} open refusal(s), none captured by someone other than subscr; nothing to resolve.`,
    });
    if (count === 0) await expect(openSection.getByText('No refused captures at this site.')).toBeVisible();
    return;
  }

  const card = cards.nth(target);
  const facts = (await card.locator('dl').innerText()).replace(/\s+/g, ' ');
  await card.getByRole('button', { name: 'Resolve' }).click();
  const note = card.getByLabel('Resolution note');
  await note.fill(`${simTag()} resolved by simulation`);
  await card.getByRole('button', { name: 'Confirm resolve' }).click();

  await expect(page.getByRole('status', { name: 'Refused captures status' })).toContainText(
    'Resolved. The capture now appears under Resolved.',
  );
  const resolvedSection = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Resolved' }) });
  await expect(resolvedSection.locator('li.refused-card').filter({ hasText: `${simTag()} resolved by simulation` }).first()).toBeVisible();
  test.info().annotations.push({ type: 'resolved', description: facts });
});
