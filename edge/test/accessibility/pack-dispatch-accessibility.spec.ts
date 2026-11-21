import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { PACK_BLOCKED_ID, PACK_READY_ID, provisionPack } from '../fixtures/pack-dispatch-stub';

// Story 3.18 (AC 8): zero serious or critical axe violations on the pack station inbox, the
// packing detail and the IRN blocked card.

for (const route of [
  `/floor/pack`,
  `/floor/pack?dispatch=${PACK_READY_ID}`,
  `/floor/pack?dispatch=${PACK_BLOCKED_ID}`,
]) {
  test(`axe: ${route} has no serious or critical violations`, async ({ page }) => {
    await provisionPack(page);
    await page.goto(route);
    await expect(page.getByRole('main')).toBeVisible();
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });
}
