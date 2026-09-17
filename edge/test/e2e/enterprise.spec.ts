import { test, expect } from '@playwright/test';
import { provisionEnterprise } from '../fixtures/enterprise-stub';

test('workflows route renders the approval workflow list and detail', async ({ page }) => {
  await provisionEnterprise(page);
  await page.goto('/workflows');
  await expect(page.getByText('Asha Operations Lead')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Workflow Management' })).toBeVisible();
  await expect(page.getByText('Indent approval #1042')).toBeVisible();

  // Selecting a workflow opens its steps and progress.
  await page.getByText('Indent approval #1042').click();
  await expect(page.getByText('Procurement approval')).toBeVisible();
  await expect(page.getByText('Progress: 1/3').first()).toBeVisible();
});

test('workflows approve advances a step locally', async ({ page }) => {
  await provisionEnterprise(page);
  await page.goto('/workflows');
  await expect(page.getByText('Asha Operations Lead')).toBeVisible();

  // Pick the workflow whose next step is assigned to the signed-in user, then approve it.
  await page.getByText('Indent approval #1042').click();
  await expect(page.getByText('Progress: 1/3').first()).toBeVisible();
  await page.getByRole('button', { name: 'Approve' }).first().click();
  await expect(page.getByText('Progress: 2/3').first()).toBeVisible();
});

test('access-control route lists roles, users, and permissions', async ({ page }) => {
  await provisionEnterprise(page);
  await page.goto('/access-control');
  await expect(page.getByText('Asha Operations Lead')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Access Control' })).toBeVisible();
  await expect(page.getByText('Rakesh Iyer')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Administrator' })).toBeVisible();
});

test('access-control assigning a role to a user updates the selection', async ({ page }) => {
  await provisionEnterprise(page);
  await page.goto('/access-control');
  await expect(page.getByText('Asha Operations Lead')).toBeVisible();

  const userRow = page.getByText('Rakesh Iyer').locator('..');
  const select = userRow.getByRole('combobox');
  await expect(select).toHaveValue('role.procurement-specialist');
  await select.selectOption('role.logistics-coordinator');
  await expect(select).toHaveValue('role.logistics-coordinator');
});

test('reports route lists templates and switches to generated reports', async ({ page }) => {
  await provisionEnterprise(page);
  await page.goto('/reports');
  await expect(page.getByText('Asha Operations Lead')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Reporting' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Inventory summary' })).toBeVisible();

  await page.getByRole('button', { name: 'Generated Reports' }).click();
  await expect(page.getByText('Movement history (weekly)')).toBeVisible();
});

test('global search narrows results and keeps keyboard navigation within the dialog', async ({
  page,
}) => {
  await provisionEnterprise(page);
  await page.goto('/');
  await expect(page.getByText('Asha Operations Lead')).toBeVisible();

  await page.getByRole('button', { name: 'Open search' }).click();
  await expect(page.getByLabel('Search the application')).toBeFocused();

  await page.keyboard.type('access');
  const option = page.getByRole('button', { name: 'Access Control' });
  await expect(option).toHaveCount(1);

  // Arrow down to the first result and Enter activates it (navigates to /access-control).
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await page.waitForURL('**/access-control');
  await expect(page.getByRole('heading', { name: 'Access Control' })).toBeVisible();
});
