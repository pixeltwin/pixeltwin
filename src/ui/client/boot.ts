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

// Password fields: the eye button shows or hides what was typed.
document.addEventListener('click', (event) => {
  const button = event.target instanceof Element ? event.target.closest('[data-password-toggle]') : null;
  const input = button?.parentElement?.querySelector('input');
  if (!button || !input) return;
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  button.setAttribute('aria-pressed', String(show));
  button.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
  input.focus();
});

// A select marked data-hint-from-option shows the chosen option's data-hint under itself.
document.addEventListener('change', (event) => {
  const select = event.target instanceof HTMLSelectElement ? event.target : null;
  if (!select?.matches('[data-hint-from-option]')) return;
  const hint = document.getElementById(`${select.id}-hint`);
  const text = select.selectedOptions[0]?.dataset.hint;
  if (hint && text) hint.textContent = text;
});

// Forms marked data-autosubmit save as soon as a field changes (their Save button is for no-JS).
document.addEventListener('change', (event) => {
  const form = event.target instanceof Element ? event.target.closest('form[data-autosubmit]') : null;
  if (form instanceof HTMLFormElement) form.requestSubmit();
});

const islands = (document.body.dataset.islands ?? '').split(/\s+/).filter((name) => /^[a-z-]+$/.test(name));
void Promise.all(
  islands.map((name) =>
    import(`./${name}.js${version}`)
      .then((module: { init?: () => void }) => module.init?.())
      .catch((err: unknown) => console.error(`pixeltwin: island "${name}" failed to start`, err)),
  ),
).then(() => {
  // Every island is listening now; browser tests wait for this before pressing keys.
  document.body.dataset.ready = '';
});
