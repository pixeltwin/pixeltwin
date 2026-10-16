// Client islands (UI spec §3.2): TypeScript modules embedded as text (also in the compiled
// binary), transpiled once at startup and served as ES modules from /ui/assets/<name>.js.

import { createHash } from 'node:crypto';
// @ts-expect-error -- a `type: 'text'` import is a string at runtime; TypeScript sees the module.
import api from './client/api.ts' with { type: 'text' };
// @ts-expect-error -- see above.
import areas from './client/areas.ts' with { type: 'text' };
// @ts-expect-error -- see above
import boot from './client/boot.ts' with { type: 'text' };
// @ts-expect-error -- see above
import changes from './client/changes.ts' with { type: 'text' };
// @ts-expect-error -- see above
import copy from './client/copy.ts' with { type: 'text' };
// @ts-expect-error -- see above
import dialog from './client/dialog.ts' with { type: 'text' };
// @ts-expect-error -- see above
import keymap from './client/keymap.ts' with { type: 'text' };
// @ts-expect-error -- see above
import keys from './client/keys.ts' with { type: 'text' };
// @ts-expect-error -- see above
import live from './client/live.ts' with { type: 'text' };
// @ts-expect-error -- see above
import palette from './client/palette.ts' with { type: 'text' };
// @ts-expect-error -- see above
import promote from './client/promote.ts' with { type: 'text' };
// @ts-expect-error -- see above
import queue from './client/queue.ts' with { type: 'text' };
// @ts-expect-error -- see above
import rank from './client/rank.ts' with { type: 'text' };
// @ts-expect-error -- see above
import review from './client/review.ts' with { type: 'text' };
// @ts-expect-error -- see above
import search from './client/search.ts' with { type: 'text' };
// @ts-expect-error -- see above
import theme from './client/theme.ts' with { type: 'text' };
// @ts-expect-error -- see above
import toast from './client/toast.ts' with { type: 'text' };
// @ts-expect-error -- see above
import tokens from './client/tokens.ts' with { type: 'text' };
// @ts-expect-error -- see above
import viewer from './client/viewer.ts' with { type: 'text' };
// @ts-expect-error -- see above
import zoom from './client/zoom.ts' with { type: 'text' };

const SOURCES: Record<string, string> = {
  api,
  areas,
  boot,
  changes,
  copy,
  dialog,
  keymap,
  keys,
  live,
  palette,
  promote,
  queue,
  rank,
  review,
  search,
  theme,
  toast,
  tokens,
  viewer,
  zoom,
};

/** One version for all modules: they import each other, so they change together. */
export const CLIENT_VERSION = createHash('sha256')
  .update(Object.entries(SOURCES).flat().join('\0'))
  .digest('hex')
  .slice(0, 12);

const transpiler = new Bun.Transpiler({ loader: 'ts', target: 'browser', minifyWhitespace: true });

/** `from "./keys.ts"` → `from "./keys.js?v=…"`; `import("./x.ts")` likewise. */
function rewriteImports(code: string): string {
  return code.replace(
    /(\bfrom\s*|\bimport\s*\(?\s*)(["'])\.\/([a-z0-9-]+)\.ts\2/g,
    (_, lead: string, quote: string, name: string) => {
      if (!(name in SOURCES)) throw new Error(`client module imports unknown module "${name}"`);
      return `${lead}${quote}./${name}.js?v=${CLIENT_VERSION}${quote}`;
    },
  );
}

export const CLIENT_MODULES: Record<string, string> = Object.fromEntries(
  Object.entries(SOURCES).map(([name, source]) => [name, rewriteImports(transpiler.transformSync(source))]),
);

export function clientModulePath(name: string): string {
  return `/ui/assets/${name}.js?v=${CLIENT_VERSION}`;
}
