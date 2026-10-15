// Loaded on every page (UI spec §3.2). Starts the shared behaviour, then imports the islands
// the page asks for in `<body data-islands="review palette">`.
import { initCopy } from './copy.ts';
import { initDialogs } from './dialog.ts';
import { initKeys } from './keys.ts';
import { initTheme } from './theme.ts';
import { initToasts } from './toast.ts';

// Every module shares this module's version query, so one release never mixes files.
const version = new URL(import.meta.url).search;

document.documentElement.classList.add('js');
initToasts();
initKeys();
initDialogs();
initCopy();
initTheme();

for (const name of (document.body.dataset.islands ?? '').split(/\s+/)) {
  if (!/^[a-z-]+$/.test(name)) continue;
  import(`./${name}.js${version}`)
    .then((module: { init?: () => void }) => module.init?.())
    .catch((err: unknown) => console.error(`pixeltwin: island "${name}" failed to start`, err));
}
