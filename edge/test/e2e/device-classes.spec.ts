import { test, expect, type Page } from '@playwright/test';
import { provisionEmployeeBase } from '../fixtures/employee-base-stub';
import { COMPACT_CONTROL, TOUCH_PRIMARY, TOUCH_SECONDARY } from '../fixtures/keyboard';

// UX Phase 1 (EXPERIENCE.md Foundation): the device class picks the nav surface and the density.
// It is chosen by viewport width plus the primary pointer, never by role, so one account is walked
// through all four classes here.
const NAVIGATION = [
  'Dashboard',
  'Frontline',
  'New requisition',
  'Check stock',
  'My requests',
  'Report damage',
];

const bottomNav = (page: Page) => page.getByRole('navigation', { name: 'Bottom navigation' });
const sidebar = (page: Page) => page.getByRole('complementary');
const iconRail = (page: Page) => page.locator('.icon-rail');

async function openCheckStock(page: Page, deviceClass: string) {
  await provisionEmployeeBase(page, { navigation: NAVIGATION });
  await page.goto('/stock');
  await expect(page.locator('.edge-shell')).toHaveAttribute('data-device-class', deviceClass);
  // The live bootstrap has landed once the advertised entry is rendered somewhere in the shell.
  await expect(page.getByRole('link', { name: 'Dashboard' }).first()).toBeAttached();
}

async function expectDensity(page: Page, primary: string, secondary: string) {
  await expect(page.getByLabel('Item code (SKU)')).toHaveCSS('min-height', secondary);
  await expect(page.getByRole('button', { name: 'Check', exact: true })).toHaveCSS(
    'min-height',
    primary,
  );
}

test.describe('handheld', () => {
  test.use({ viewport: { width: 360, height: 640 }, hasTouch: true, isMobile: true });

  test('uses the bottom nav with More for the overflow, at touch density', async ({ page }) => {
    await openCheckStock(page, 'handheld');
    await expect(bottomNav(page)).toBeVisible();
    await expect(sidebar(page)).toHaveCount(0);
    await expect(iconRail(page)).toHaveCount(0);

    // Four slots: three entries and More.
    await expect(bottomNav(page).getByRole('link')).toHaveCount(3);
    const more = bottomNav(page).getByRole('button', { name: 'More' });
    await expect(more).toHaveAttribute('aria-expanded', 'false');
    // Check stock sits in the overflow, so More carries the active marker.
    await expect(more).toHaveClass(/active/);
    await more.click();
    await expect(more).toHaveAttribute('aria-expanded', 'true');
    await expect(bottomNav(page).getByRole('link', { name: 'Check stock' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await page.keyboard.press('Escape');
    await expect(more).toHaveAttribute('aria-expanded', 'false');

    await expectDensity(page, TOUCH_PRIMARY, TOUCH_SECONDARY);
    // Nothing forces a sideways scroll on the tightest canvas.
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
  });
});

test.describe('tablet', () => {
  test.use({ viewport: { width: 768, height: 1024 }, hasTouch: true, isMobile: true });

  test('uses the icon rail, labelled for assistive tech, at touch density', async ({ page }) => {
    await openCheckStock(page, 'tablet');
    await expect(iconRail(page)).toBeVisible();
    await expect(sidebar(page)).toHaveCount(0);
    await expect(bottomNav(page)).toHaveCount(0);

    await expect(iconRail(page).getByRole('link')).toHaveCount(NAVIGATION.length);
    const active = iconRail(page).getByRole('link', { name: 'Check stock' });
    await expect(active).toHaveAttribute('aria-current', 'page');
    await expect(active).toHaveAttribute('title', 'Check stock');
    await expectDensity(page, TOUCH_PRIMARY, TOUCH_SECONDARY);
  });
});

test.describe('desktop', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('keeps the sidebar at compact density', async ({ page }) => {
    await openCheckStock(page, 'desktop');
    await expect(sidebar(page)).toBeVisible();
    await expect(bottomNav(page)).toHaveCount(0);
    await expect(iconRail(page)).toHaveCount(0);
    await expect(sidebar(page).getByRole('link', { name: 'Dashboard' })).toHaveCSS(
      'min-height',
      COMPACT_CONTROL,
    );
    await expectDensity(page, COMPACT_CONTROL, COMPACT_CONTROL);
  });

  test('switches the nav surface when the window is resized', async ({ page }) => {
    await openCheckStock(page, 'desktop');
    await page.setViewportSize({ width: 500, height: 800 });
    await expect(page.locator('.edge-shell')).toHaveAttribute('data-device-class', 'handheld');
    await expect(bottomNav(page)).toBeVisible();
    await page.setViewportSize({ width: 900, height: 800 });
    await expect(iconRail(page)).toBeVisible();
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(sidebar(page)).toBeVisible();
  });
});

test.describe('desktop touch', () => {
  test.use({ viewport: { width: 1366, height: 768 }, hasTouch: true });

  test('keeps the sidebar at touch density', async ({ page }) => {
    await openCheckStock(page, 'desktop-touch');
    await expect(sidebar(page)).toBeVisible();
    await expect(bottomNav(page)).toHaveCount(0);
    await expect(sidebar(page).getByRole('link', { name: 'Dashboard' })).toHaveCSS(
      'min-height',
      '52px',
    );
    await expectDensity(page, TOUCH_PRIMARY, TOUCH_SECONDARY);
  });
});
