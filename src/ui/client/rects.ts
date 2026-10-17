// Pure: no DOM access, so `bun test` can check it. Area rectangles in screenshot pixels: moving
// and resizing one, and where a duplicate goes.

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

export type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'move';

/** Smaller drags are taken for clicks, not areas; an edited area cannot shrink below it either. */
export const MIN_SIZE = 4;

/** A duplicate goes this far below (or right of) its original. */
export const COPY_GAP = 8;

/** When neither below nor right fits, the duplicate overlaps its original, shifted by this much. */
export const COPY_NUDGE = 16;

export const same = (a: Rect, b: Rect) => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

/** `from` moved or resized by (dx, dy) image pixels through `handle`, kept inside a w×h image. */
export function dragged(from: Rect, handle: Handle, dx: number, dy: number, w: number, h: number): Rect {
  if (handle === 'move') {
    return {
      ...from,
      x: Math.min(w - from.width, Math.max(0, from.x + dx)),
      y: Math.min(h - from.height, Math.max(0, from.y + dy)),
    };
  }
  let left = from.x;
  let top = from.y;
  let right = from.x + from.width;
  let bottom = from.y + from.height;
  if (handle.includes('w')) left = Math.min(right - MIN_SIZE, Math.max(0, left + dx));
  if (handle.includes('e')) right = Math.max(left + MIN_SIZE, Math.min(w, right + dx));
  if (handle.includes('n')) top = Math.min(bottom - MIN_SIZE, Math.max(0, top + dy));
  if (handle.includes('s')) bottom = Math.max(top + MIN_SIZE, Math.min(h, bottom + dy));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

const fits = (r: Rect, image: Size) =>
  r.x >= 0 && r.y >= 0 && r.x + r.width <= image.width && r.y + r.height <= image.height;

/**
 * Where a duplicate of `from` goes on an `image`. With `step` (how far the last duplicate was
 * moved from its own original) it repeats that move, so a row of equal boxes takes one Cmd+D
 * each. Otherwise, or when the repeat would leave the image: just below the original, else just
 * right of it, else overlapping it shifted by 16 px, kept inside the image.
 */
export function copyPlace(from: Rect, image: Size, step?: { dx: number; dy: number }): Rect {
  if (step && (step.dx !== 0 || step.dy !== 0)) {
    const repeated = { ...from, x: from.x + step.dx, y: from.y + step.dy };
    if (fits(repeated, image)) return repeated;
  }
  const below = { ...from, y: from.y + from.height + COPY_GAP };
  if (fits(below, image)) return below;
  const right = { ...from, x: from.x + from.width + COPY_GAP };
  if (fits(right, image)) return right;
  const shifted = dragged(from, 'move', COPY_NUDGE, COPY_NUDGE, image.width, image.height);
  // In a corner the shift is clamped away; go the other way instead.
  return same(shifted, from) ? dragged(from, 'move', -COPY_NUDGE, -COPY_NUDGE, image.width, image.height) : shifted;
}
