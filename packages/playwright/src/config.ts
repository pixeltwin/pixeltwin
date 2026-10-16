import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { optionsToEnv, type PixeltwinOptions } from '@pixeltwin/client/run';
import type { PlaywrightTestConfig } from '@playwright/test';

const here = fileURLToPath(import.meta.url);

/** Absolute path of the global setup, for configs that list it themselves. */
export const pixeltwinSetup = fileURLToPath(new URL(`./setup${extname(here)}`, import.meta.url));

/**
 * Adds pixeltwin to a Playwright config: the options go to `process.env` (the main process and
 * every worker load this file, so all see them) and the global setup is appended to yours.
 */
export function withPixeltwin<T extends PlaywrightTestConfig>(config: T, options: PixeltwinOptions = {}): T {
  Object.assign(process.env, optionsToEnv(options));
  const own = config.globalSetup === undefined ? [] : [config.globalSetup].flat();
  if (own.includes(pixeltwinSetup) || own.includes('@pixeltwin/playwright/setup')) return config;
  return { ...config, globalSetup: [...own, pixeltwinSetup] };
}

export type { PixeltwinOptions } from '@pixeltwin/client/run';
