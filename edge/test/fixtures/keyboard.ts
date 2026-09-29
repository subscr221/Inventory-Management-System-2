import { expect, type Locator, type Page } from '@playwright/test';

/**
 * Density follows the pointer (EXPERIENCE.md): the default Playwright project is a desktop with a
 * fine pointer, so controls are compact there. The touch sizes are asserted in device-classes.spec.
 */
export const COMPACT_CONTROL = '34px';
export const TOUCH_PRIMARY = '56px';
export const TOUCH_SECONDARY = '48px';

/** Real Tab presses until the target has focus (keyboard evidence, not .focus()). */
export async function tabTo(page: Page, target: Locator, limit = 40) {
  for (let i = 0; i < limit && !(await target.evaluate((el) => el === document.activeElement)); i += 1) {
    await page.keyboard.press('Tab');
  }
  await expect(target).toBeFocused();
}
