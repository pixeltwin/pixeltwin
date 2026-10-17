import { type PixeltwinClient, TimingTotals, type Variant } from '@pixeltwin/client';
import { clientFor, resolveSettings } from '@pixeltwin/client/run';
import { test as base } from '@playwright/test';
import type { CheckResultInfo } from './fixture.js';
import { Pixeltwin } from './fixture.js';

export interface PixeltwinFixtures {
  /** `pixeltwin.check(page | locator, name, options)`. */
  pixeltwin: Pixeltwin;
  /** Extra variant keys for every check of a project, e.g. `use: { pixeltwinVariant: { theme: 'dark' } }`. */
  pixeltwinVariant: Variant;
  /** Attach expected, actual and diff to the test when a check is not unchanged. Default true. */
  pixeltwinAttachImages: boolean;
  /** Called after every check (and its retakes), e.g. to send its images to another report. */
  pixeltwinOnResult: ((result: CheckResultInfo) => void | Promise<void>) | undefined;
}

export interface PixeltwinWorkerFixtures {
  /** One client per worker; null when pixeltwin is disabled. */
  pixeltwinClient: PixeltwinClient | null;
  /** How long this worker's checks took; sent to the build when the worker ends. */
  pixeltwinTimings: TimingTotals;
}

/** Playwright's `test` with the `pixeltwin` fixture. Combine with your own: `mergeTests(test, yours)`. */
export const test = base.extend<PixeltwinFixtures, PixeltwinWorkerFixtures>({
  pixeltwinVariant: [{}, { option: true }],
  pixeltwinAttachImages: [true, { option: true }],
  pixeltwinOnResult: [undefined, { option: true }],

  pixeltwinClient: [
    // biome-ignore lint/correctness/noEmptyPattern: Playwright reads fixture dependencies from this pattern.
    async ({}, use) => {
      const settings = resolveSettings();
      await use(settings.disabled ? null : clientFor(settings));
    },
    { scope: 'worker' },
  ],

  pixeltwinTimings: [
    async ({ pixeltwinClient }, use) => {
      const totals = new TimingTotals();
      await use(totals);
      const buildId = process.env.PIXELTWIN_BUILD_ID;
      if (!pixeltwinClient || !buildId) return;
      await totals.flush(pixeltwinClient, buildId).catch((err: unknown) => {
        console.warn(`pixeltwin: could not send the timings: ${err instanceof Error ? err.message : String(err)}`);
      });
    },
    { scope: 'worker' },
  ],

  pixeltwin: async (
    { pixeltwinClient, pixeltwinTimings, pixeltwinVariant, pixeltwinAttachImages, pixeltwinOnResult, browserName },
    use,
    testInfo,
  ) => {
    await use(
      new Pixeltwin(pixeltwinClient, testInfo, browserName, pixeltwinVariant, {
        settings: resolveSettings(),
        attachImages: pixeltwinAttachImages,
        onResult: pixeltwinOnResult,
        timings: pixeltwinTimings,
      }),
    );
  },
});

export type { Build, Check, Rect, Variant, Verdict } from '@pixeltwin/client';
export { PixeltwinCheckError, PixeltwinError, PixeltwinGateError, PixeltwinNetworkError } from '@pixeltwin/client';
export { expect } from '@playwright/test';
export {
  type CheckImages,
  type CheckOptions,
  type CheckResultInfo,
  Pixeltwin,
  type ScreenshotOptions,
} from './fixture.js';
