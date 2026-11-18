import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import {
  GRN_ID,
  PUTAWAY_TASK_ID,
  provisionStores,
} from '../fixtures/stores-stub';

// Story 3.15 (AC 7): zero serious or critical axe violations on putaway and the GRN read card.

for (const route of [
  `/stores/putaway?task=${PUTAWAY_TASK_ID}`,
  `/stores/grn?grn=${GRN_ID}`,
]) {
  test(`axe: ${route} has no serious or critical violations`, async ({ page }) => {
    await provisionStores(page, { withPutaway: true });
    await page.goto(route);
    await expect(page.getByRole('main')).toBeVisible();
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });
}
