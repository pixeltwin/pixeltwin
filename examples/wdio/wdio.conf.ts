import { mkdirSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { join } from 'node:path';
import { type CheckResultInfo, PixeltwinService } from '@pixeltwin/wdio';
import { startSite } from './serve.mjs';

const port = Number(process.env.SITE_PORT ?? 19182);
// HEADED=1 shows the browser windows.
const headless = process.env.HEADED === '1' ? [] : ['--headless=new'];
// Same rendering on every run.
const stable = ['--hide-scrollbars', '--force-color-profile=srgb', '--lang=en-US', '--disable-gpu'];

let site: Server | undefined;

export const config: WebdriverIO.Config = {
  runner: 'local',
  specs: ['./test/specs/**/*.e2e.ts'],
  maxInstances: 2,

  // Every check gets the variant { browser, viewport }, so desktop and mobile have their own
  // baselines. WebdriverIO downloads Chrome for Testing and a matching chromedriver when needed.
  capabilities: [
    {
      browserName: 'chrome',
      // The viewport is set to exactly 1280×800 in `before` below (the window size includes the
      // browser's own UI).
      'goog:chromeOptions': { args: [...headless, ...stable, '--window-size=1280,1000'] },
    },
    {
      browserName: 'chrome',
      'goog:chromeOptions': {
        args: [...headless, ...stable],
        // A phone: 412×839 CSS pixels at a device pixel ratio of 2.625 (a Pixel 7).
        mobileEmulation: {
          deviceMetrics: { width: 412, height: 839, pixelRatio: 2.625, touch: true },
          userAgent:
            'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
        },
      },
    },
  ],

  baseUrl: `http://localhost:${port}`,
  framework: 'mocha',
  mochaOpts: { ui: 'bdd', timeout: 60_000 },
  reporters: ['spec'],
  logLevel: 'warn',

  // The launcher opens one pixeltwin build for the run and finalizes it at the end: it prints the
  // summary and, with PIXELTWIN_GATE=1, exits 1 unless the verdict is `passed`. PIXELTWIN_URL,
  // PIXELTWIN_TOKEN and PIXELTWIN_PROJECT come from the environment (or set them here).
  services: [
    [
      PixeltwinService,
      {
        // A page still loading or animating is screenshotted again, a second apart, up to twice.
        retakes: 2,
        // Expected, actual and diff of every check that is not unchanged, for your own report.
        onResult: async ({ name, check, images }: CheckResultInfo) => {
          if (check.result === 'unchanged') return;
          const dir = join('pixeltwin-results', Object.values(check.variant).join('-'));
          mkdirSync(dir, { recursive: true });
          const { baseline, current, diff } = await images();
          for (const [kind, png] of [
            ['expected', baseline],
            ['actual', current],
            ['diff', diff],
          ] as const) {
            if (png) writeFileSync(join(dir, `${name}-${kind}.png`), png);
          }
        },
      },
    ],
  ],

  before: async (capabilities) => {
    const chrome = (capabilities as { 'goog:chromeOptions'?: { mobileEmulation?: unknown } })['goog:chromeOptions'];
    if (!chrome?.mobileEmulation) await browser.setViewport({ width: 1280, height: 800 });
  },

  // The demo site, served by the launcher for the whole run (DEMO_CHANGE=1 switches the change on).
  onPrepare: async () => {
    site = await startSite(port);
  },
  onComplete: async () => {
    await new Promise((done) => (site ? site.close(done) : done(undefined)));
  },
};
