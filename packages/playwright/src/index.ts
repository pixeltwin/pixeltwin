import type { PixeltwinClient, Variant } from '@pixeltwin/client';
import { clientFor, resolveSettings } from '@pixeltwin/client/run';
import { test as base } from '@playwright/test';
import { Pixeltwin } from './fixture.js';

export interface PixeltwinFixtures {
  /** `pixeltwin.check(page | locator, name, options)`. */
  pixeltwin: Pixeltwin;
  /** Extra variant keys for every check of a project, e.g. `use: { pixeltwinVariant: { theme: 'dark' } }`. */
  pixeltwinVariant: Variant;
}

export interface PixeltwinWorkerFixtures {
  /** One client per worker; null when pixeltwin is disabled. */
  pixeltwinClient: PixeltwinClient | null;
}

/** Playwright's `test` with the `pixeltwin` fixture. Combine with your own: `mergeTests(test, yours)`. */
export const test = base.extend<PixeltwinFixtures, PixeltwinWorkerFixtures>({
  pixeltwinVariant: [{}, { option: true }],

  pixeltwinClient: [
    // biome-ignore lint/correctness/noEmptyPattern: Playwright reads fixture dependencies from this pattern.
    async ({}, use) => {
      const settings = resolveSettings();
      await use(settings.disabled ? null : clientFor(settings));
    },
    { scope: 'worker' },
  ],

  pixeltwin: async ({ pixeltwinClient, pixeltwinVariant, browserName }, use, testInfo) => {
    await use(new Pixeltwin(pixeltwinClient, testInfo, browserName, pixeltwinVariant));
  },
});

export type { Build, Check, Rect, Variant, Verdict } from '@pixeltwin/client';
export { PixeltwinError, PixeltwinGateError, PixeltwinNetworkError } from '@pixeltwin/client';
export { expect } from '@playwright/test';
export { type CheckOptions, Pixeltwin, type ScreenshotOptions } from './fixture.js';
