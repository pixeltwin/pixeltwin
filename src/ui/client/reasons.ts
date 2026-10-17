// Pure: no DOM access, so `bun test` can check it. What a key press does in the reject popover.

export interface PopoverKey {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  /** Focus is in the comment field. */
  inComment: boolean;
  /** Focus is on a button of the popover (Cancel, Reject): Enter and Space are the button's. */
  onButton: boolean;
}

export type PopoverAction =
  /** Pick (or unpick) the category at this index, 0–6. */
  | { kind: 'pick'; index: number }
  | { kind: 'submit' }
  | { kind: 'cancel' }
  /** Start typing the comment: move the focus there and let the key through. */
  | { kind: 'comment' }
  /** The key is the field's or the browser's; global shortcuts must not see it. */
  | { kind: 'keep' };

/** Categories in the popover (number keys 1–7). */
export const REASON_COUNT = 7;

export function popoverAction(input: PopoverKey): PopoverAction {
  if (input.ctrlKey || input.metaKey || input.altKey) return { kind: 'keep' };
  if (input.key === 'Escape') return { kind: 'cancel' };
  if (input.key === 'Enter') return input.onButton ? { kind: 'keep' } : { kind: 'submit' };
  if (input.inComment) return { kind: 'keep' };
  const digit = /^[1-9]$/.test(input.key) ? Number(input.key) : 0;
  if (digit >= 1 && digit <= REASON_COUNT) return { kind: 'pick', index: digit - 1 };
  // A letter starts the comment, so "1 banner late ↵" needs no Tab.
  if (input.key.length === 1 && /\S/.test(input.key) && !/[0-9]/.test(input.key)) return { kind: 'comment' };
  return { kind: 'keep' };
}
