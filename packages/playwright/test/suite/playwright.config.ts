// A small suite run by test/sdk/playwright.test.ts against a test server (PIXELTWIN_* from there).

import { withPixeltwin } from '@pixeltwin/playwright/config';
import { defineConfig, devices } from '@playwright/test';

export default withPixeltwin(
  defineConfig({
    testDir: '.',
    testMatch: '*.pw.ts',
    outputDir: process.env.SUITE_OUTPUT_DIR ?? 'test-results',
    workers: 2,
    fullyParallel: true,
    reporter: 'list',
    use: { colorScheme: 'light', locale: 'en-US', timezoneId: 'UTC' },
    projects: [
      { name: 'desktop', use: { browserName: 'chromium', viewport: { width: 800, height: 600 } } },
      // Device pixels: twice the CSS size.
      { name: 'hidpi', use: { browserName: 'chromium', viewport: { width: 640, height: 480 }, deviceScaleFactor: 2 } },
      // A phone zooms a page without a viewport meta tag out to 980 CSS pixels.
      { name: 'phone', use: { ...devices['Pixel 7'] } },
    ],
  }),
  { project: process.env.SUITE_PROJECT },
);
