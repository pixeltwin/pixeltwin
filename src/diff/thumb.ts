import { PNG } from 'pngjs';
import type { Rect, Size } from './types';

/**
 * Thumbnails for the build page's cards: a screenshot scaled down so its longer side is at most
 * `edge` pixels. A full-page screenshot is megabytes and paints top to bottom while it arrives;
 * its thumbnail is a few dozen kilobytes. Runs in a diff worker (decoding is the slow part).
 */

/**
 * The longer sides thumbnails are made at: few sizes, so few files per image. 960 is a large card
 * (about 460 px wide) on a 2× screen; 640 a compact one.
 */
export const THUMB_EDGES = [320, 640, 960] as const;
export type ThumbEdge = (typeof THUMB_EDGES)[number];

/**
 * `plain` averages pixels. `diff` keeps a diff image's changed pixels (pure red) red wherever one
 * falls in an output pixel, so a one-pixel change is still there in the thumbnail.
 */
export type ThumbMode = 'plain' | 'diff';

export interface ThumbJob {
  thumb: true;
  png: Uint8Array;
  edge: number;
  mode: ThumbMode;
  /** Only this part of the image (a change group's crop), clamped to the image. */
  crop?: Rect | undefined;
}

export type ThumbJobResult =
  | { kind: 'thumb'; png: Uint8Array; width: number; height: number }
  | { kind: 'error'; code: 'diff_timeout' | 'diff_failed'; message: string };

export type ThumbRunner = (job: ThumbJob) => Promise<ThumbJobResult>;

/** The edge asked for (`?w=`), rounded up to a size thumbnails are made at; the biggest past it. */
export function thumbEdge(asked: number | undefined): ThumbEdge {
  const largest = THUMB_EDGES[THUMB_EDGES.length - 1] as ThumbEdge;
  if (asked === undefined || !Number.isFinite(asked)) return largest;
  return THUMB_EDGES.find((edge) => edge >= asked) ?? largest;
}

/** Taller than this many times its width, a screenshot is a full page: a card shows a part of it. */
export const TALL_RATIO = 2.5;
/** Width to height of the part of a full page a card shows. */
export const TALL_ASPECT = 1.6;

/** A full-page screenshot (phone screens, about 2.2 times as tall as wide, are not). */
export function isTall(size: Size): boolean {
  return size.height > size.width * TALL_RATIO;
}

/** The top of an image, TALL_ASPECT wide to high (all of it when it is not that tall). */
export function topCrop(size: Size): Rect {
  return { x: 0, y: 0, width: size.width, height: Math.min(size.height, Math.round(size.width / TALL_ASPECT)) };
}

/**
 * The part of a full page a card shows: its top, unless the topmost change lies below it; then
 * a band as tall as the top around that change (its start, when the change is taller than that).
 */
export function tallView(size: Size, regions: Rect[]): { crop: Rect; top: boolean } {
  const top = topCrop(size);
  const first = [...regions].sort((a, b) => a.y - b.y)[0];
  if (!first || first.y + first.height <= top.height) return { crop: top, top: true };
  const y = first.height >= top.height - 32 ? first.y - 16 : Math.round(first.y + first.height / 2 - top.height / 2);
  return { crop: { ...top, y: Math.max(0, Math.min(y, size.height - top.height)) }, top: false };
}

/** The thumbnail's size for an image of `size`: the same when it already fits, never larger. */
export function thumbSize(size: Size, edge: number): Size {
  const longer = Math.max(size.width, size.height);
  if (longer <= edge) return { width: size.width, height: size.height };
  const scale = edge / longer;
  return {
    width: Math.max(1, Math.round(size.width * scale)),
    height: Math.max(1, Math.round(size.height * scale)),
  };
}

/** Where each output pixel's source span starts along one axis (`out + 1` entries). */
function spans(source: number, out: number): Int32Array {
  const starts = new Int32Array(out + 1);
  for (let i = 0; i <= out; i++) starts[i] = Math.floor((i * source) / out);
  // Every output pixel covers at least one source pixel.
  for (let i = 1; i <= out; i++) starts[i] = Math.max(starts[i] as number, (starts[i - 1] as number) + 1);
  starts[out] = source;
  return starts;
}

/**
 * Scales RGBA pixels down by averaging every source pixel into the output pixel it falls in (a
 * box filter: sharp text stays readable, nothing shimmers). Pure, so it is tested on its own.
 */
export function downscale(data: Uint8Array, size: Size, out: Size, mode: ThumbMode): Uint8Array<ArrayBuffer> {
  const { width, height } = size;
  const xs = spans(width, out.width);
  const ys = spans(height, out.height);
  const result = new Uint8Array(out.width * out.height * 4);
  const sums = new Float64Array(out.width * 4);
  const red = new Uint8Array(out.width);
  for (let oy = 0; oy < out.height; oy++) {
    sums.fill(0);
    red.fill(0);
    const y0 = ys[oy] as number;
    const y1 = ys[oy + 1] as number;
    for (let y = y0; y < y1; y++) {
      let p = y * width * 4;
      for (let ox = 0; ox < out.width; ox++) {
        const x1 = xs[ox + 1] as number;
        let r = 0;
        let g = 0;
        let b = 0;
        let a = 0;
        for (let x = xs[ox] as number; x < x1; x++, p += 4) {
          const pr = data[p] as number;
          const pg = data[p + 1] as number;
          const pb = data[p + 2] as number;
          if (mode === 'diff' && pr === 255 && pg === 0 && pb === 0) red[ox] = 1;
          r += pr;
          g += pg;
          b += pb;
          a += data[p + 3] as number;
        }
        const s = ox * 4;
        sums[s] = (sums[s] as number) + r;
        sums[s + 1] = (sums[s + 1] as number) + g;
        sums[s + 2] = (sums[s + 2] as number) + b;
        sums[s + 3] = (sums[s + 3] as number) + a;
      }
    }
    for (let ox = 0; ox < out.width; ox++) {
      const o = (oy * out.width + ox) * 4;
      if (red[ox]) {
        result.set([255, 0, 0, 255], o);
        continue;
      }
      const count = (y1 - y0) * ((xs[ox + 1] as number) - (xs[ox] as number));
      const s = ox * 4;
      for (let k = 0; k < 4; k++) result[o + k] = Math.round((sums[s + k] as number) / count);
    }
  }
  return result;
}

/** `crop` inside an image of `size`, at least one pixel; null when it lies outside. */
export function clampCrop(crop: Rect, size: Size): Rect | null {
  const x = Math.max(0, crop.x);
  const y = Math.max(0, crop.y);
  const width = Math.min(crop.width, size.width - x);
  const height = Math.min(crop.height, size.height - y);
  return width >= 1 && height >= 1 ? { x, y, width, height } : null;
}

/** The pixels of `crop` (RGBA rows copied out of the image). */
function cropPixels(data: Uint8Array, size: Size, crop: Rect): Uint8Array {
  const out = new Uint8Array(crop.width * crop.height * 4);
  for (let y = 0; y < crop.height; y++) {
    const from = ((crop.y + y) * size.width + crop.x) * 4;
    out.set(data.subarray(from, from + crop.width * 4), y * crop.width * 4);
  }
  return out;
}

/** Decodes the PNG, scales it (or its crop) down to fit `edge` and encodes the thumbnail. */
export function makeThumb(job: ThumbJob): ThumbJobResult {
  const png = PNG.sync.read(Buffer.from(job.png.buffer, job.png.byteOffset, job.png.byteLength));
  let pixels: Uint8Array = png.data;
  let size: Size = { width: png.width, height: png.height };
  if (job.crop) {
    const crop = clampCrop(job.crop, size);
    if (!crop) return { kind: 'error', code: 'diff_failed', message: 'The crop lies outside the image.' };
    pixels = cropPixels(pixels, size, crop);
    size = { width: crop.width, height: crop.height };
  }
  const out = thumbSize(size, job.edge);
  const data = downscale(pixels, size, out, job.mode);
  let opaque = true;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] !== 255) {
      opaque = false;
      break;
    }
  }
  const thumb = new PNG({ width: out.width, height: out.height });
  thumb.data = Buffer.from(data.buffer);
  // Screenshots are opaque: RGB is a quarter smaller. One fixed filter keeps encoding fast.
  const bytes = PNG.sync.write(thumb, { colorType: opaque ? 2 : 6, filterType: 4, deflateLevel: 6 });
  return { kind: 'thumb', png: new Uint8Array(bytes), width: out.width, height: out.height };
}
