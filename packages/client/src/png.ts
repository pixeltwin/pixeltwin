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
