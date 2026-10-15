// The UI's stylesheet and script, embedded as text (and into the compiled binary).

import { createHash } from 'node:crypto';
import base from './assets/css/base.css' with { type: 'text' };
import components from './assets/css/components.css' with { type: 'text' };
import legacy from './assets/css/legacy.css' with { type: 'text' };
import overlays from './assets/css/overlays.css' with { type: 'text' };
import projects from './assets/css/projects.css' with { type: 'text' };
import shell from './assets/css/shell.css' with { type: 'text' };
import tokens from './assets/css/tokens.css' with { type: 'text' };

/** One stylesheet, concatenated in cascade order: tokens first, page rules last. */
export const APP_CSS: string = [tokens, base, shell, components, overlays, projects, legacy].join('\n');

const version = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 12);

export const ASSET_VERSIONS = { css: version(APP_CSS) };

/** Content-hashed URLs: a new release changes the URL, so assets can be cached forever. */
export const ASSET_PATHS = {
  css: `/ui/assets/app.css?v=${ASSET_VERSIONS.css}`,
};
