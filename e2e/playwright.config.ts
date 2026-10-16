import { defineConfig, devices } from '@playwright/test';

/** pixeltwin under test listens here; global-setup.ts starts it with an empty data dir. */
export const E2E_PORT = Number(process.env.E2E_PORT ?? 18777);

export default defineConfig({
  testDir: '.',
  globalSetup: './global-setup.ts',
  // One server, one worker: tests seed their own projects, so they could run in parallel, but a
  // single worker keeps the server's diff workers from timing out on slow CI machines.
  workers: 1,
  timeout: 30_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    baseURL: `http://localhost:${E2E_PORT}`,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } }],
});
