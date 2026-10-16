// Changed pixels over the screenshots: the diff image's pure red pixels (pixelmatch's diff colour)
// become an opaque mask with transparent everything else, drawn over the baseline and the new
// screenshot in Side, Slider and Onion. Pure: no DOM, so it is tested on its own.

/** RGBA of a highlighted pixel: a red that stands out on white and dark screenshots. */
export const MASK_COLOR = [255, 0, 72, 230] as const;

/**
 * The mask for a diff image (RGBA, width × height): every changed pixel and its 8 neighbours, so
 * a one-pixel change still shows when the screenshot is scaled down to fit.
 */
export function changeMask(diff: Uint8ClampedArray, width: number, height: number): Uint8ClampedArray<ArrayBuffer> {
  const changed = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < changed.length; i++, p += 4) {
    if (diff[p] === 255 && diff[p + 1] === 0 && diff[p + 2] === 0) changed[i] = 1;
  }
  // Grow by one pixel, rows then columns.
  const rows = new Uint8Array(changed.length);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      if (changed[row + x] || (x > 0 && changed[row + x - 1]) || (x < width - 1 && changed[row + x + 1])) {
        rows[row + x] = 1;
      }
    }
  }
  const mask = new Uint8ClampedArray(changed.length * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (rows[i] || (y > 0 && rows[i - width]) || (y < height - 1 && rows[i + width])) mask.set(MASK_COLOR, i * 4);
    }
  }
  return mask;
}
