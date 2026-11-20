import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { QC_TASK_ID, provisionQc } from '../fixtures/qc-stub';
import { tabTo } from '../fixtures/keyboard';

// Story 8.11 (AC 8): zero WCAG 2.1 AA axe violations on /qc/tasks, task detail, and /qc/holds,
// plus keyboard-only navigation reaching the first card, Pass and Fail, Complete inspection,
// and Record disposition.

for (const route of ['/qc/tasks', `/qc/tasks?task=${QC_TASK_ID}`, '/qc/holds']) {
  test(`axe: ${route} has no WCAG 2.1 AA violations`, async ({ page }) => {
    await provisionQc(page, { role: 'qc_head', initialInspected: route.includes('?task=') });
    await page.goto(route);
    await expect(page.getByRole('main')).toBeVisible();
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });
}

test('keyboard-only flow reaches the first card, Pass and Fail, Complete inspection, and Record disposition', async ({
  page,
}) => {
  await provisionQc(page, { role: 'qc_head' });
  await page.goto('/qc/tasks');

  const firstOpen = page.getByRole('link', { name: 'Open' }).first();
  await tabTo(page, firstOpen, 60);
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`/qc/tasks\\?task=${QC_TASK_ID}$`));

  const pass1 = page.getByRole('button', { name: 'Pass' }).nth(0);
  await tabTo(page, pass1, 40);
  await page.keyboard.press('Enter');

  const fail2 = page.getByRole('button', { name: 'Fail' }).nth(1);
  await tabTo(page, fail2, 20);
  await page.keyboard.press('Enter');

  const complete = page.getByRole('button', { name: 'Complete inspection' });
  await tabTo(page, complete, 40);
  await expect(complete).toBeEnabled();
  await page.keyboard.press('Enter');

  const record = page.getByRole('button', { name: 'Record disposition' });
  await tabTo(page, record, 40);
  await expect(record).toBeVisible();
});
