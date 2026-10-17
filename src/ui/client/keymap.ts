// Pure: no DOM access, so `bun test` can check it. Turns a key press into a shortcut name.

export interface KeyInput {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  /** Focus is in an input, textarea, select or contenteditable element. */
  editing: boolean;
}

const MODIFIERS = new Set(['Shift', 'Control', 'Meta', 'Alt', 'AltGraph', 'CapsLock']);

/**
 * `a`, `?`, `escape`, `arrowleft`, `shift+arrowleft`, `shift+r`, or `mod+k` for Ctrl/Cmd+K.
 * Shift with a letter is its own shortcut (`shift+r`); `plainOf` gives the letter for keys that
 * have no Shift shortcut, so Shift+A still approves. Returns null when the press
 * should reach the page untouched: typing in a field (Escape excepted) or a modified key that
 * belongs to the browser (Ctrl+C, Cmd+A, Alt+…).
 */
export function shortcutOf(input: KeyInput): string | null {
  if (MODIFIERS.has(input.key)) return null;
  const key = input.key.toLowerCase();
  if (input.ctrlKey || input.metaKey) return key === 'k' && !input.altKey ? 'mod+k' : null;
  if (input.altKey) return null;
  if (input.editing && key !== 'escape') return null;
  // Shift changes what most keys type (`?`), but an arrow stays an arrow: Shift+arrow is its own shortcut.
  if (input.shiftKey && key.startsWith('arrow')) return `shift+${key}`;
  if (input.shiftKey && /^[a-z]$/.test(key)) return `shift+${key}`;
  return key;
}

/** What a Shift+letter shortcut falls back to when nothing listens for it: the letter. */
export function plainOf(shortcut: string): string | null {
  return /^shift\+[a-z]$/.test(shortcut) ? shortcut.slice(6) : null;
}
