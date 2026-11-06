import { defineConfig } from '@playwright/test';

const PORT = Number(process.env['FIXTURE_PORT'] ?? '4321');

export default defineConfig({
  testDir: './tests/e2e',
  globalSetup: './tests/e2e/global-setup.ts',
  fullyParallel: false,
  forbidOnly: !!process.env['CI'],
  retries: process.env['CI'] ? 2 : 0,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'on-first-retry',
  },
  webServer: {
    command: `node scripts/serve-fixtures.mjs`,
    url: `http://127.0.0.1:${PORT}/page.html`,
    reuseExistingServer: false,
    env: { PORT: String(PORT) },
  },
});
