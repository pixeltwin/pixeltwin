// Loaded on every page (UI spec §3.2). Starts the shared behaviour, then imports the islands
// the page asks for in `<body data-islands="review palette">`.
import { initCopy } from './copy.ts';
import { initDialogs } from './dialog.ts';
import { initKeys, onKey } from './keys.ts';
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

// The command palette (UI spec §4.3) loads on first use: ⌘K / Ctrl+K or the top bar button.
if (document.body.dataset.role) {
  const openPalette = () => {
    import(`./palette.js${version}`)
      .then((module: { open: () => void }) => module.open())
      .catch((err: unknown) => console.error('pixeltwin: the palette failed to start', err));
  };
  onKey({ key: 'mod+k', label: 'Search and commands', run: openPalette });
  for (const button of document.querySelectorAll<HTMLElement>('[data-palette-open]')) {
    button.hidden = false;
    const kbd = button.querySelector('kbd');
    if (kbd && !navigator.platform.startsWith('Mac')) kbd.textContent = 'Ctrl K';
    button.addEventListener('click', openPalette);
  }
}

// Forms marked data-autosubmit save as soon as a field changes (their Save button is for no-JS).
document.addEventListener('change', (event) => {
  const form = event.target instanceof Element ? event.target.closest('form[data-autosubmit]') : null;
  if (form instanceof HTMLFormElement) form.requestSubmit();
});

for (const name of (document.body.dataset.islands ?? '').split(/\s+/)) {
  if (!/^[a-z-]+$/.test(name)) continue;
  import(`./${name}.js${version}`)
    .then((module: { init?: () => void }) => module.init?.())
    .catch((err: unknown) => console.error(`pixeltwin: island "${name}" failed to start`, err));
}
