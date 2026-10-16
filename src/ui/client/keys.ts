// Global keyboard shortcuts (UI spec §3.2). Islands register handlers with `onKey`; elements
// with `data-key="a"` are clicked (links, buttons) or submitted (forms) when `a` is pressed.
import { shortcutOf } from './keymap.ts';

export interface Shortcut {
  /** What `shortcutOf` returns, e.g. `a`, `?`, `escape`, `mod+k`. */
  key: string;
  /** Shown in the `?` sheet; omit to keep a shortcut out of it. */
  label?: string;
  run: (event: KeyboardEvent) => void;
}

const shortcuts: Shortcut[] = [];

/** Registers a shortcut; returns a function that removes it. Later registrations win. */
export function onKey(shortcut: Shortcut): () => void {
  shortcuts.unshift(shortcut);
  return () => {
    const i = shortcuts.indexOf(shortcut);
    if (i >= 0) shortcuts.splice(i, 1);
  };
}

function isEditing(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && target.closest('input, textarea, select, [contenteditable]') !== null;
}

/** The label of a `data-key` element for the `?` sheet: its `data-key-label`, else its text. */
function labelOf(element: HTMLElement): string {
  return element.dataset.keyLabel ?? element.textContent?.replace(/\s+/g, ' ').trim() ?? '';
}

function visible(element: HTMLElement): boolean {
  return element.getClientRects().length > 0 || element instanceof HTMLFormElement;
}

function trigger(element: HTMLElement): void {
  if (element instanceof HTMLFormElement) element.requestSubmit();
  else element.click();
}

const KEY_NAMES: Record<string, string> = {
  'mod+k': navigator.platform.startsWith('Mac') ? '⌘K' : 'Ctrl K',
  escape: 'Esc',
  arrowleft: '←',
  arrowright: '→',
  'shift+arrowleft': 'Shift ←',
  'shift+arrowright': 'Shift →',
};

/** The `?` sheet: every labelled shortcut that works on this page right now. */
function showSheet(): void {
  document.getElementById('shortcut-sheet')?.remove();
  const rows = new Map<string, string>();
  for (const s of shortcuts) if (s.label && !rows.has(s.key)) rows.set(s.key, s.label);
  for (const el of document.querySelectorAll<HTMLElement>('[data-key]')) {
    const k = el.dataset.key as string;
    if (!rows.has(k) && visible(el)) rows.set(k, labelOf(el));
  }
  rows.set('?', 'Show this list');

  const dialog = document.createElement('dialog');
  dialog.id = 'shortcut-sheet';
  dialog.className = 'sheet';
  dialog.setAttribute('aria-labelledby', 'shortcut-sheet-title');
  const title = document.createElement('h2');
  title.id = 'shortcut-sheet-title';
  title.textContent = 'Keyboard shortcuts';
  const list = document.createElement('dl');
  list.className = 'shortcut-list';
  for (const [k, label] of rows) {
    const dt = document.createElement('dt');
    const kbd = document.createElement('kbd');
    kbd.textContent = KEY_NAMES[k] ?? k.toUpperCase();
    dt.append(kbd);
    const dd = document.createElement('dd');
    dd.textContent = label;
    list.append(dt, dd);
  }
  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = 'Close';
  close.addEventListener('click', () => dialog.close());
  dialog.append(title, list, close);
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
}

export function initKeys(): void {
  onKey({ key: '?', run: showSheet });
  document.addEventListener('keydown', (event) => {
    if (event.defaultPrevented || event.repeat) return;
    const key = shortcutOf({
      key: event.key,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      altKey: event.altKey,
      shiftKey: event.shiftKey,
      editing: isEditing(event.target),
    });
    if (!key) return;
    // An open modal dialog owns the keyboard; Escape is the browser's to close it.
    if (document.querySelector('dialog[open]') && key !== 'mod+k') return;
    const shortcut = shortcuts.find((s) => s.key === key);
    if (shortcut) {
      event.preventDefault();
      shortcut.run(event);
      return;
    }
    const element = [...document.querySelectorAll<HTMLElement>(`[data-key="${CSS.escape(key)}"]`)].find(visible);
    if (element) {
      event.preventDefault();
      trigger(element);
    }
  });
}
