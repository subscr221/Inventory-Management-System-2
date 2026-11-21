import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import {
  UNL_GATE_ID,
  UNL_LINE_ID,
  provisionUnloading,
} from '../fixtures/unloading-exceptions-stub';

// Story 3.20: zero WCAG 2.1 AA violations on the inbox and both details, at handheld and desktop
// widths, plus a keyboard-only resolve.

const viewports = [
  { name: 'handheld', width: 390, height: 800 },
  { name: 'desktop', width: 1280, height: 800 },
];

for (const viewport of viewports) {
  for (const route of [
    '/unloading/exceptions',
    `/unloading/exceptions?case=gate:${UNL_GATE_ID}`,
    `/unloading/exceptions?case=line:${UNL_LINE_ID}`,
  ]) {
    test(`axe: ${route} at ${viewport.name} has no violations`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await provisionUnloading(page);
      await page.goto(route);
      await expect(page.getByRole('main')).toBeVisible();
      await expect(page.getByText('Loading exceptions...')).toHaveCount(0);
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      expect(results.violations).toEqual([]);
    });
  }
}

test('keyboard only: accept within band resolves without a pointer', async ({ page }) => {
  await provisionUnloading(page);
  await page.goto(`/unloading/exceptions?case=line:${UNL_LINE_ID}`);
  const accept = page.getByRole('button', { name: 'Accept 20 - return 10 with vehicle' });
  await expect(accept).toBeVisible();
  await accept.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText('The delivery moves to the stores inbox.')).toBeVisible();
});
