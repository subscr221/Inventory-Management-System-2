import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { PHOTO_FILE, provisionGate } from '../fixtures/gate-stub';

// Story 3.13 (AC 10): both tabs are free of automated WCAG 2.1 AA violations and the stepper is
// operable from the keyboard alone.

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

async function expectNoViolations(page: Page) {
  expect((await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze()).violations).toEqual([]);
}

async function waitForBootstrap(page: Page) {
  await expect(
    page
      .getByRole('navigation', { name: 'Primary navigation' })
      .getByRole('link', { name: 'Gate entry' }),
  ).toBeVisible();
}

test('the gate entry tab has no automated WCAG 2.1 AA violations', async ({ page }) => {
  await provisionGate(page);
  await page.goto('/gate');
  await waitForBootstrap(page);
  await page.getByLabel('Challan number').fill('CH-2026-01');
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Accept' }).click();
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByLabel('Take challan photo').setInputFiles(PHOTO_FILE);
  await expectNoViolations(page);
});

test('the trucks-on-site tab has no automated WCAG 2.1 AA violations', async ({ page }) => {
  await provisionGate(page);
  await page.goto('/gate');
  await waitForBootstrap(page);
  await page.getByRole('tab', { name: 'Trucks on site' }).click();
  await expect(page.getByRole('heading', { name: 'Trucks on site' })).toBeVisible();
  await expectNoViolations(page);
});

test('the stepper is operable from the keyboard alone', async ({ page }) => {
  await provisionGate(page);
  await page.goto('/gate');
  await waitForBootstrap(page);

  const challan = page.getByLabel('Challan number');
  await expect(challan).toBeFocused();
  await page.keyboard.type('CH-2026-01');
  await page.keyboard.press('Enter');
  await expect(page.getByText(/Matched CH-2026-01/)).toBeVisible();
  // Tab order: the ScanField actions ("Scan again" first) come before the match card's Accept.
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Scan again' })).toBeFocused();
  for (let i = 0; i < 6; i += 1) {
    if (
      await page
        .getByRole('button', { name: 'Accept' })
        .evaluate((el) => el === document.activeElement)
    )
      break;
    await page.keyboard.press('Tab');
  }
  await expect(page.getByRole('button', { name: 'Accept' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expectNoViolations(page);
});
