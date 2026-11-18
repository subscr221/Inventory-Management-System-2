import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import {
  TASK_ID,
  provisionFloor,
} from '../fixtures/floor-stub';

// Story 3.16 (AC 7): zero serious or critical axe violations on the floor inbox and the pick-line
// execution screen.

for (const route of [`/floor/tasks`, `/floor/tasks?task=${TASK_ID}`]) {
  test(`axe: ${route} has no serious or critical violations`, async ({ page }) => {
    await provisionFloor(page, { task: 'one-line' });
    await page.goto(route);
    await expect(page.getByRole('main')).toBeVisible();
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });
}
