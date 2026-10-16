import type { Rect } from './types.js';

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Width and height from a PNG's IHDR chunk; null when the bytes are not a PNG. */
export function pngSize(png: Uint8Array): { width: number; height: number } | null {
  if (png.length < 24 || SIGNATURE.some((byte, i) => png[i] !== byte)) return null;
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/**
 * Rounds a rectangle outwards to whole pixels and clips it to the image (when its size is known).
 * Null when nothing of it is left.
 */
export function toPixelRect(rect: Rect, image?: { width: number; height: number } | null): Rect | null {
  let left = Math.max(0, Math.floor(rect.x));
  let top = Math.max(0, Math.floor(rect.y));
  let right = Math.ceil(rect.x + rect.width);
  let bottom = Math.ceil(rect.y + rect.height);
  if (image) {
    right = Math.min(right, image.width);
    bottom = Math.min(bottom, image.height);
    left = Math.min(left, image.width);
    top = Math.min(top, image.height);
  }
  if (!Number.isFinite(right - left) || !Number.isFinite(bottom - top)) return null;
  if (right - left < 1 || bottom - top < 1) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** Where a screenshot starts, in CSS pixels, and how many screenshot pixels one CSS pixel is. */
export interface CssToPixels {
  origin: { x: number; y: number };
  scale: number | { x: number; y: number };
}

/**
 * Maps a box in CSS pixels (as `getBoundingClientRect()` gives it) to a region in screenshot pixels.
 * Browsers paint a box with fractional edges snapped to whole CSS pixels and scale afterwards, so at
 * a device pixel ratio of 2.625 an element can paint 1.3 screenshot pixels past its exact box. The box
 * is therefore first snapped outwards to whole CSS pixels, then shifted by the origin, scaled, rounded
 * outwards to whole pixels and clipped to the image. Null when nothing of it is left.
 */
export function cssBoxToPixels(
  box: Rect,
  { origin, scale }: CssToPixels,
  image?: { width: number; height: number } | null,
): Rect | null {
  if (!(box.width > 0 && box.height > 0)) return null;
  const sx = typeof scale === 'number' ? scale : scale.x;
  const sy = typeof scale === 'number' ? scale : scale.y;
  const left = Math.floor(box.x);
  const top = Math.floor(box.y);
  const right = Math.ceil(box.x + box.width);
  const bottom = Math.ceil(box.y + box.height);
  return toPixelRect(
    { x: (left - origin.x) * sx, y: (top - origin.y) * sy, width: (right - left) * sx, height: (bottom - top) * sy },
    image,
  );
}
