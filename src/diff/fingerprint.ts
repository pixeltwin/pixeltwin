import { createHash } from 'node:crypto';
import type { Rect } from './types';

// Change fingerprints: the same change on different screens (a new header on 40 pages) gets the
// same fingerprint, so it can be reviewed once. A region's fingerprint hashes what changed in it:
// the changed pixels' places inside the region's box and their colours before and after. Where the
// box sits on the screen is left out, and so are its pixels that did not change (unchanged,
// below the colour threshold, anti-aliasing, ignored): they are often the page around the change.

/** Hex characters kept of a hash: 64 bits, far from colliding among the checks of a build. */
const KEPT = 16;
/** Bytes per changed pixel in the hash input: x, y (uint32 each), RGBA before, RGBA after. */
const PIXEL_BYTES = 16;
const CHUNK = 64 * 1024;

/**
 * The fingerprint of one changed region. `mask` has 1 for every changed pixel of the `width`-wide
 * canvas; `before` and `after` are the RGBA pixels of the baseline and the new screenshot, both
 * `width` wide (only called when they have the same size).
 */
export function regionFingerprint(
  region: Rect,
  mask: Uint8Array,
  before: Uint8Array,
  after: Uint8Array,
  width: number,
): string {
  const hash = createHash('sha1');
  const chunk = new Uint8Array(CHUNK);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, region.width);
  view.setUint32(4, region.height);
  hash.update(chunk.subarray(0, 8));
  let used = 0;
  for (let dy = 0; dy < region.height; dy++) {
    const row = (region.y + dy) * width;
    for (let dx = 0; dx < region.width; dx++) {
      const i = row + region.x + dx;
      if (!mask[i]) continue;
      if (used + PIXEL_BYTES > CHUNK) {
        hash.update(chunk.subarray(0, used));
        used = 0;
      }
      view.setUint32(used, dx);
      view.setUint32(used + 4, dy);
      const p = i * 4;
      chunk[used + 8] = before[p] as number;
      chunk[used + 9] = before[p + 1] as number;
      chunk[used + 10] = before[p + 2] as number;
      chunk[used + 11] = before[p + 3] as number;
      chunk[used + 12] = after[p] as number;
      chunk[used + 13] = after[p + 1] as number;
      chunk[used + 14] = after[p + 2] as number;
      chunk[used + 15] = after[p + 3] as number;
      used += PIXEL_BYTES;
    }
  }
  hash.update(chunk.subarray(0, used));
  return hash.digest('hex').slice(0, KEPT);
}

/**
 * A check's change key: its regions' fingerprints as a set (sorted, repeats kept), so two checks
 * with exactly the same changes share it, wherever on the screen those changes are.
 */
export function changeKeyOf(fingerprints: string[]): string {
  return createHash('sha1')
    .update([...fingerprints].sort().join(','))
    .digest('hex')
    .slice(0, KEPT);
}
