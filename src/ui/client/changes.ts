// Changed pixels over the screenshots: the diff image's pure red pixels (pixelmatch's diff colour)
// become an opaque mask with transparent everything else, drawn over the new screenshot (focus
// mode) and over thumbnails (build page). Pure: no DOM, so it is tested on its own.

/** RGBA of a highlighted pixel: a red that stands out on white and dark screenshots. */
export const MASK_COLOR = [255, 0, 72, 230] as const;

/** How much redder than green and blue a scaled-down diff pixel must be to hold a change. */
const RED_MARGIN = 24;

/** `marked` grown by one pixel (8 neighbours), painted MASK_COLOR on transparent. */
function grown(marked: Uint8Array, width: number, height: number): Uint8ClampedArray<ArrayBuffer> {
  const rows = new Uint8Array(marked.length);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      if (marked[row + x] || (x > 0 && marked[row + x - 1]) || (x < width - 1 && marked[row + x + 1])) {
        rows[row + x] = 1;
      }
    }
  }
  const mask = new Uint8ClampedArray(marked.length * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (rows[i] || (y > 0 && rows[i - width]) || (y < height - 1 && rows[i + width])) mask.set(MASK_COLOR, i * 4);
    }
  }
  return mask;
}

/**
 * The mask for a diff image (RGBA, width × height): every changed pixel and its 8 neighbours, so
 * a one-pixel change still shows when the screenshot is scaled down to fit.
 */
export function changeMask(diff: Uint8ClampedArray, width: number, height: number): Uint8ClampedArray<ArrayBuffer> {
  const marked = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < marked.length; i++, p += 4) {
    if (diff[p] === 255 && diff[p + 1] === 0 && diff[p + 2] === 0) marked[i] = 1;
  }
  return grown(marked, width, height);
}

/**
 * The mask for a diff image already scaled down to thumbnail size: scaling averages a changed
 * pixel into its grey neighbours, so any pixel clearly redder than it is grey holds a change.
 */
export function thumbMask(diff: Uint8ClampedArray, width: number, height: number): Uint8ClampedArray<ArrayBuffer> {
  const marked = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < marked.length; i++, p += 4) {
    const r = diff[p] ?? 0;
    if (r - Math.max(diff[p + 1] ?? 0, diff[p + 2] ?? 0) >= RED_MARGIN) marked[i] = 1;
  }
  return grown(marked, width, height);
}
