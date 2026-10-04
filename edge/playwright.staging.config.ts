import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

// Pilot simulation against the deployed staging site through the real Keycloak login.
// Run from edge/: npx playwright test -c playwright.staging.config.ts
// Needs PILOT_PW (the staging pilot password). STAGING_URL overrides the target.
const outDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../_bmad-output/pilot-sim/playwright');

export default defineConfig({
  testDir: './test/staging',
  workers: 1,
  fullyParallel: false,
  retries: 1,
  timeout: 60_000,
  expect: { timeout: 20_000 },
  outputDir: path.join(outDir, 'test-results'),
  reporter: [
    ['list'],
    ['html', { outputFolder: path.join(outDir, 'html'), open: 'never' }],
    ['json', { outputFile: path.join(outDir, process.env['PW_JSON_OUT'] ?? 'results.json') }],
  ],
  use: {
    ...devices['Desktop Chrome'],
    baseURL: process.env['STAGING_URL'] ?? 'https://ims-staging.ancorlabs.org',
    serviceWorkers: 'allow',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    navigationTimeout: 30_000,
    actionTimeout: 15_000,
  },
});
