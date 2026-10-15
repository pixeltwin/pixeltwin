// The UI's stylesheet and script, embedded as text (and into the compiled binary).

import { createHash } from 'node:crypto';
// @ts-expect-error -- a `type: 'text'` import of a .js file is a string at runtime; TypeScript cannot know that.
import js from './assets/app.js' with { type: 'text' };
import base from './assets/css/base.css' with { type: 'text' };
import components from './assets/css/components.css' with { type: 'text' };
import legacy from './assets/css/legacy.css' with { type: 'text' };
import shell from './assets/css/shell.css' with { type: 'text' };
import tokens from './assets/css/tokens.css' with { type: 'text' };

/** One stylesheet, concatenated in cascade order: tokens first, page rules last. */
export const APP_CSS: string = [tokens, base, shell, components, legacy].join('\n');
export const APP_JS: string = js;

const version = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 12);

export const ASSET_VERSIONS = { css: version(APP_CSS), js: version(APP_JS) };

/** Content-hashed URLs: a new release changes the URL, so assets can be cached forever. */
export const ASSET_PATHS = {
  css: `/ui/assets/app.css?v=${ASSET_VERSIONS.css}`,
  js: `/ui/assets/app.js?v=${ASSET_VERSIONS.js}`,
};
