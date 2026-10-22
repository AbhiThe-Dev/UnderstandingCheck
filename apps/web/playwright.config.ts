import { defineConfig } from '@playwright/test';

/**
 * Runs against the real API + web app (heuristic analyzer, no credentials).
 * Uses the locally installed Chrome; set PW_CHANNEL=chromium after `npx playwright install chromium` to use the bundled one.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  use: { baseURL: 'http://localhost:3000', channel: process.env.PW_CHANNEL ?? 'chrome', viewport: { width: 1440, height: 900 } },
  webServer: [
    {
      command: 'pnpm --filter @uc/api start',
      cwd: '../..',
      url: 'http://127.0.0.1:4000/health',
      reuseExistingServer: true,
      env: { UC_DATA_DIR: '.data/e2e' },
    },
    { command: 'pnpm dev', url: 'http://localhost:3000', reuseExistingServer: true },
  ],
});
