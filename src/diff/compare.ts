import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import { elementChanges } from './elements';
import { changeKeyOf, regionFingerprint } from './fingerprint';
import { extractRegions } from './regions';
import { summarize } from './summary';
import type { DiffJob, DiffJobResult, Rect } from './types';

function decode(bytes: Uint8Array): PNG {
  return PNG.sync.read(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
}

/**
 * pngjs by default tries all five PNG filters on every row and keeps the best (about 47 ms for a
 * 1280×800 diff). One fixed filter ("sub") takes a few ms, and diff images, mostly flat grey with
 * some red, come out barely larger.
 */
const DIFF_PNG_OPTIONS = { filterType: 1, deflateLevel: 6 };

function encode(width: number, height: number, data: Uint8Array): Uint8Array {
  const png = new PNG({ width, height });
  png.data = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return new Uint8Array(PNG.sync.write(png, DIFF_PNG_OPTIONS));
}

function samePixels(a: PNG, b: PNG): boolean {
  return a.width === b.width && a.height === b.height && Buffer.compare(a.data, b.data) === 0;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Copies the top-left `width`×`height` area of an RGBA image. */
function cropRgba(png: PNG, width: number, height: number): Uint8Array {
  if (png.width === width && png.height === height) return png.data;
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const from = y * png.width * 4;
    out.set(png.data.subarray(from, from + width * 4), y * width * 4);
  }
  return out;
}

function cropMask(mask: Uint8Array, fullWidth: number, width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) out.set(mask.subarray(y * fullWidth, y * fullWidth + width), y * width);
  return out;
}

function fillRect(mask: Uint8Array, r: Rect, value: number, width: number, height: number): void {
  const x1 = Math.min(width, r.x + r.width);
  const y1 = Math.min(height, r.y + r.height);
  for (let y = Math.max(0, r.y); y < y1; y++) mask.fill(value, y * width + Math.max(0, r.x), y * width + x1);
}

/**
 * One byte per pixel, 1 where the comparison skips the pixel: everything outside the compare
 * regions (when there are any), and everything inside an ignore region.
 */
function ignoreMaskFor(ignore: Rect[], compare: Rect[], width: number, height: number): Uint8Array | null {
  if (ignore.length === 0 && compare.length === 0) return null;
  const mask = new Uint8Array(width * height);
  if (compare.length > 0) {
    mask.fill(1);
    for (const r of compare) fillRect(mask, r, 0, width, height);
  }
  for (const r of ignore) fillRect(mask, r, 1, width, height);
  return mask;
}

export function roundPercent(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Compares `job.current` with `job.baseline` (both PNG bytes). Pure: no I/O.
 * With `baseline: null` it only checks that `current` decodes.
 */
export function compareImages(job: DiffJob): DiffJobResult {
  let current: PNG;
  try {
    current = decode(job.current);
  } catch (err) {
    return { kind: 'invalid_image', message: `Image could not be decoded: ${message(err)}` };
  }
  if (!job.baseline) return { kind: 'validated', width: current.width, height: current.height };

  let baseline: PNG;
  try {
    baseline = decode(job.baseline);
  } catch (err) {
    return { kind: 'error', code: 'diff_failed', message: `Baseline image could not be decoded: ${message(err)}` };
  }

  const width = Math.max(current.width, baseline.width);
  const height = Math.max(current.height, baseline.height);
  if (width * height > job.maxPixels) {
    return {
      kind: 'error',
      code: 'diff_failed',
      message: `Images of ${baseline.width}×${baseline.height} and ${current.width}×${current.height} need a ${width}×${height} comparison canvas (${width * height} pixels); the limit is ${job.maxPixels}.`,
    };
  }
  const overlapWidth = Math.min(current.width, baseline.width);
  const overlapHeight = Math.min(current.height, baseline.height);
  const sizeChanged = current.width !== baseline.width || current.height !== baseline.height;

  const ignore = ignoreMaskFor(job.ignoreRegions, job.compareRegions ?? [], width, height);
  // The same pixels in different PNG bytes (another encoder, metadata): nothing to compare.
  const identical = samePixels(current, baseline);
  const overlapIgnore = ignore && sizeChanged ? cropMask(ignore, width, overlapWidth, overlapHeight) : ignore;
  const overlapDiff = new Uint8Array(overlapWidth * overlapHeight * 4);
  if (!identical)
    pixelmatch(
      cropRgba(baseline, overlapWidth, overlapHeight),
      cropRgba(current, overlapWidth, overlapHeight),
      overlapDiff,
      overlapWidth,
      overlapHeight,
      {
        threshold: job.colorThreshold,
        includeAA: false,
        diffColor: [255, 0, 0],
        ...(overlapIgnore ? { ignoreMask: overlapIgnore } : {}),
      },
    );

  // pixelmatch draws unchanged pixels in grey and changed ones in pure red; outside the
  // overlap every pixel that is not ignored counts as changed. Rows of the overlap are copied
  // whole (a per-pixel copy cost about 47 ms at 1280×800); only the mask is built per pixel.
  const mask = new Uint8Array(width * height);
  const diffImage = sizeChanged ? new Uint8Array(width * height * 4) : overlapDiff;
  let pixels = 0;
  if (!identical) {
    for (let y = 0; y < height; y++) {
      if (sizeChanged && y < overlapHeight) {
        diffImage.set(overlapDiff.subarray(y * overlapWidth * 4, (y + 1) * overlapWidth * 4), y * width * 4);
      }
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        const d = i * 4;
        if (x < overlapWidth && y < overlapHeight) {
          const o = (y * overlapWidth + x) * 4;
          if (overlapDiff[o] === 255 && overlapDiff[o + 1] === 0 && overlapDiff[o + 2] === 0) {
            mask[i] = 1;
            pixels += 1;
          }
        } else if (ignore?.[i]) {
          diffImage[d] = 255;
          diffImage[d + 1] = 255;
          diffImage[d + 2] = 255;
          diffImage[d + 3] = 255;
        } else {
          diffImage[d] = 255;
          diffImage[d + 1] = 0;
          diffImage[d + 2] = 0;
          diffImage[d + 3] = 255;
          mask[i] = 1;
          pixels += 1;
        }
      }
    }
  }

  // With compare regions the share is of the pixels they compare, so a small region is not
  // drowned by the rest of the canvas; otherwise it is of the whole canvas.
  let compared = width * height;
  if (ignore && (job.compareRegions?.length ?? 0) > 0) {
    compared = 0;
    for (const skipped of ignore) if (!skipped) compared += 1;
  }
  const exactPercent = compared > 0 ? (pixels / compared) * 100 : 0;
  const result = exactPercent > job.tolerancePercent ? 'changed' : 'unchanged';
  const percent = roundPercent(exactPercent);
  const dimensions = sizeChanged
    ? {
        baseline: { width: baseline.width, height: baseline.height },
        current: { width: current.width, height: current.height },
      }
    : null;
  const regions = extractRegions(mask, width, height);
  // Element changes only when both screenshots came with elements; otherwise the diff is as before.
  const elements =
    job.elements && pixels > 0
      ? elementChanges(job.elements.baseline, job.elements.current, regions.cells, regions.regions)
      : null;
  // Fingerprints need both images' pixels at every place, so a resized screenshot gets none; a
  // truncated region list would leave changes out of the change key.
  let changeKey: string | null = null;
  if (result === 'changed' && !sizeChanged) {
    for (const r of regions.regions) r.fingerprint = regionFingerprint(r, mask, baseline.data, current.data, width);
    if (!regions.truncated && regions.regions.length > 0) {
      changeKey = changeKeyOf(regions.regions.map((r) => r.fingerprint as string));
    }
  }
  const summary = summarize({
    regions: regions.regions,
    regionCount: regions.total,
    pixels,
    percent,
    width,
    height,
    dimensions,
    withinTolerance: result === 'unchanged',
    tolerancePercent: job.tolerancePercent,
    changes: elements
      ? { items: elements.changes, truncated: elements.truncated, explained: elements.explained }
      : undefined,
  });

  return {
    kind: 'compared',
    result,
    diff: {
      percent,
      pixels,
      colorThreshold: job.colorThreshold,
      tolerancePercent: job.tolerancePercent,
      dimensions,
      regions: regions.regions,
      regionsTruncated: regions.truncated,
      summary,
      ...(job.elements ? { changes: elements?.changes ?? [], changesTruncated: elements?.truncated ?? false } : {}),
    },
    diffPng: pixels > 0 ? encode(width, height, diffImage) : null,
    changeKey,
  };
}
