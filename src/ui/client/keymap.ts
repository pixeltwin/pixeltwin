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
 * `a`, `?`, `escape`, `arrowleft`, `shift+arrowleft`, or `mod+k` for Ctrl/Cmd+K. Returns null when the press
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
  return key;
}
