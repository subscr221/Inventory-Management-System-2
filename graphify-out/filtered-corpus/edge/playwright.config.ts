import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './test',
  webServer: {
    command: 'npm run build && node .next/standalone/edge/server.js',
    url: 'http://127.0.0.1:3000',
    reuseExistingServer: !process.env['CI'],
    timeout: 120_000,
  },
  use: {
    baseURL: 'http://127.0.0.1:3000',
    serviceWorkers: 'allow',
    ...devices['Desktop Chrome'],
  },
});
