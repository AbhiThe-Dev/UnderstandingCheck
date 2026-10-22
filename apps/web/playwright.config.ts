import { defineConfig } from '@playwright/test';

/**
 * Runs against a fresh API + production web build on their own ports with an in-memory database,
 * so tests never see (or change) your development data. Heuristic analyzer, no credentials.
 * Uses the locally installed Chrome; set PW_CHANNEL=chromium after `npx playwright install chromium`.
 */
const API_PORT = 4100;
const WEB_PORT = 3100;

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  use: { baseURL: `http://localhost:${WEB_PORT}`, channel: process.env.PW_CHANNEL ?? 'chrome', viewport: { width: 1440, height: 900 } },
  webServer: [
    {
      command: 'pnpm --filter @uc/api start',
      cwd: '../..',
      url: `http://127.0.0.1:${API_PORT}/health`,
      reuseExistingServer: false,
      env: { UC_DATA_DIR: ':memory:', API_PORT: String(API_PORT), WEB_ORIGIN: `http://localhost:${WEB_PORT}`, ANALYZER: 'heuristic' },
    },
    {
      command: `pnpm exec next build && pnpm exec next start --port ${WEB_PORT}`,
      url: `http://localhost:${WEB_PORT}`,
      reuseExistingServer: false,
      timeout: 180_000,
      env: { NEXT_PUBLIC_API_URL: `http://127.0.0.1:${API_PORT}`, NEXT_TELEMETRY_DISABLED: '1' },
    },
  ],
});
