// The UI's stylesheet and favicon, embedded as text (and into the compiled binary).

import { createHash } from 'node:crypto';
import base from './assets/css/base.css' with { type: 'text' };
import build from './assets/css/build.css' with { type: 'text' };
import components from './assets/css/components.css' with { type: 'text' };
import forms from './assets/css/forms.css' with { type: 'text' };
import insights from './assets/css/insights.css' with { type: 'text' };
import overlays from './assets/css/overlays.css' with { type: 'text' };
import projects from './assets/css/projects.css' with { type: 'text' };
import review from './assets/css/review.css' with { type: 'text' };
import shell from './assets/css/shell.css' with { type: 'text' };
import tokens from './assets/css/tokens.css' with { type: 'text' };
import favicon from './assets/img/favicon.svg' with { type: 'text' };

/** One stylesheet, concatenated in cascade order: tokens first, page rules last. */
export const APP_CSS: string = [
  tokens,
  base,
  shell,
  components,
  overlays,
  projects,
  build,
  review,
  forms,
  insights,
].join('\n');

const version = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 12);

/** The pixeltwin mark on a rounded square; it inverts itself for dark browser chrome. */
export const FAVICON_SVG: string = favicon;

export const ASSET_VERSIONS = { css: version(APP_CSS), favicon: version(FAVICON_SVG) };

/** Content-hashed URLs: a new release changes the URL, so assets can be cached forever. */
export const ASSET_PATHS = {
  css: `/ui/assets/app.css?v=${ASSET_VERSIONS.css}`,
  favicon: `/ui/assets/favicon.svg?v=${ASSET_VERSIONS.favicon}`,
};
