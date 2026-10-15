import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import { extractRegions } from './regions';
import { summarize } from './summary';
import type { DiffJob, DiffJobResult, Rect } from './types';

function decode(bytes: Uint8Array): PNG {
  return PNG.sync.read(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
}

function encode(width: number, height: number, data: Uint8Array): Uint8Array {
  const png = new PNG({ width, height });
  png.data = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return new Uint8Array(PNG.sync.write(png));
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

/** One byte per pixel, 1 inside any ignore region. */
function ignoreMaskFor(regions: Rect[], width: number, height: number): Uint8Array | null {
  if (regions.length === 0) return null;
  const mask = new Uint8Array(width * height);
  for (const r of regions) {
    const x1 = Math.min(width, r.x + r.width);
    const y1 = Math.min(height, r.y + r.height);
    for (let y = Math.max(0, r.y); y < y1; y++) mask.fill(1, y * width + Math.max(0, r.x), y * width + x1);
  }
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
  const overlapWidth = Math.min(current.width, baseline.width);
  const overlapHeight = Math.min(current.height, baseline.height);
  const sizeChanged = current.width !== baseline.width || current.height !== baseline.height;

  const ignore = ignoreMaskFor(job.ignoreRegions, width, height);
  const overlapIgnore = ignore && sizeChanged ? cropMask(ignore, width, overlapWidth, overlapHeight) : ignore;
  const overlapDiff = new Uint8Array(overlapWidth * overlapHeight * 4);
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
  // overlap every pixel that is not ignored counts as changed.
  const mask = new Uint8Array(width * height);
  const diffImage = new Uint8Array(width * height * 4);
  let pixels = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (x < overlapWidth && y < overlapHeight) {
        const o = (y * overlapWidth + x) * 4;
        diffImage.set(overlapDiff.subarray(o, o + 4), i * 4);
        if (overlapDiff[o] === 255 && overlapDiff[o + 1] === 0 && overlapDiff[o + 2] === 0) {
          mask[i] = 1;
          pixels += 1;
        }
      } else if (ignore?.[i]) {
        diffImage.set([255, 255, 255, 255], i * 4);
      } else {
        diffImage.set([255, 0, 0, 255], i * 4);
        mask[i] = 1;
        pixels += 1;
      }
    }
  }

  const exactPercent = (pixels / (width * height)) * 100;
  const result = exactPercent > job.tolerancePercent ? 'changed' : 'unchanged';
  const percent = roundPercent(exactPercent);
  const dimensions = sizeChanged
    ? {
        baseline: { width: baseline.width, height: baseline.height },
        current: { width: current.width, height: current.height },
      }
    : null;
  const regions = extractRegions(mask, width, height);
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
    },
    diffPng: pixels > 0 ? encode(width, height, diffImage) : null,
  };
}
