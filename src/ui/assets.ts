// The UI's stylesheet and script, embedded as text (and into the compiled binary).

import { createHash } from 'node:crypto';
import css from './assets/app.css' with { type: 'text' };
// @ts-expect-error -- a `type: 'text'` import of a .js file is a string at runtime; TypeScript cannot know that.
import js from './assets/app.js' with { type: 'text' };

export const APP_CSS: string = css;
export const APP_JS: string = js;

const version = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 12);

/** Content-hashed URLs: a new release changes the URL, so assets can be cached forever. */
export const ASSET_PATHS = {
  css: `/ui/assets/app.css?v=${version(APP_CSS)}`,
  js: `/ui/assets/app.js?v=${version(APP_JS)}`,
};
