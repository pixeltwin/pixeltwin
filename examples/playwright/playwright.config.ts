import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.SITE_PORT ?? 19181);

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',

  // Opens one pixeltwin build for the run, finalizes it at the end, prints the summary and, with
  // PIXELTWIN_GATE=1, fails the run unless the verdict is `passed`.
  globalSetup: '@pixeltwin/playwright/setup',

  use: {
    baseURL: `http://localhost:${port}`,
    // Same rendering on every run.
    colorScheme: 'light',
    locale: 'en-US',
    timezoneId: 'UTC',
  },

  // Every check gets the variant { browser, viewport }: each project below has its own baselines.
  projects: [
    { name: 'chromium-desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } } },
    { name: 'firefox-desktop', use: { ...devices['Desktop Firefox'], viewport: { width: 1280, height: 800 } } },
    { name: 'chromium-mobile', use: { ...devices['Pixel 7'] } },
  ],

  webServer: {
    command: 'node serve.mjs',
    url: `http://localhost:${port}/`,
    env: { SITE_PORT: String(port) },
    // A fresh server per run, so DEMO_CHANGE=1 always takes effect.
    reuseExistingServer: false,
  },
});
