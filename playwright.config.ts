import { defineConfig, devices } from '@playwright/test';

const PORT = 3100;
const DATABASE_URL =
  process.env['TEST_DATABASE_URL'] ?? 'mysql://cadentra:cadentra@127.0.0.1:3307/cadentra_test';

export default defineConfig({
  testDir: 'e2e',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: process.env['CI'] ? 1 : 0,
  reporter: process.env['CI'] ? [['github'], ['list']] : 'list',
  globalSetup: './e2e/global-setup.ts',
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npx tsx src/server.ts',
    url: `http://localhost:${PORT}/readyz`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      NODE_ENV: 'test',
      PORT: String(PORT),
      LOG_LEVEL: 'warn',
      DATABASE_URL,
      APP_URL: `http://localhost:${PORT}`,
      APP_SECRET: 'e2e-secret-that-is-at-least-32-characters-long',
      RUN_WORKER: 'true',
      WORKER_POLL_MS: '300',
      WORKER_MAX_SENDS_PER_SECOND: '10',
      EMAIL_PROVIDER: 'fake',
    },
  },
});
