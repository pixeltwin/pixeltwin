import { makeThumb, THUMB_EDGES, type ThumbMode, thumbSize, topCrop } from '../diff/thumb';
import type { Rect } from '../diff/types';
import { thumbKey } from '../storage/storage';
import type { Deps } from './deps';
import { loadImage } from './images';

/**
 * Card thumbnails (thumb.ts): made on first request, stored next to the image (`thumbs/…`) and
 * served from storage after that. Images are content-addressed, so a thumbnail never changes.
 */

/** Thumbnails being made right now, so cards asking at once wait for one job. */
const making = new Map<string, Promise<Uint8Array | null>>();

/**
 * Crops (a change group's before and after) are not stored: there is one per group and image, and
 * nothing would delete them with the image. The last few are kept here; browsers cache them.
 */
const CROPS_KEPT = 64;
const crops = new Map<string, Uint8Array>();

/** Width and height from the PNG's IHDR (stored images were checked on upload). */
function pngSize(bytes: Uint8Array): { width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/**
 * The thumbnail of image `sha` whose longer side is at most `edge`; null for an unknown image. An
 * image that fits already is served as it is. When the worker fails, the full image is served
 * (and nothing is stored), so a card still shows its screenshot. `top`: only the top of the image
 * (topCrop, a full page's card), stored like the whole one; it is the same for every card.
 */
export async function loadThumb(
  deps: Pick<Deps, 'storage' | 'runThumb'>,
  sha: string,
  edge: number,
  mode: ThumbMode,
  options: { crop?: Rect | undefined; top?: boolean } = {},
): Promise<Uint8Array | null> {
  if (options.crop) return loadCrop(deps, sha, edge, mode, options.crop);
  const top = options.top ?? false;
  const key = thumbKey(sha, edge, mode, top);
  const stored = await deps.storage.get(key);
  if (stored) return stored;
  let pending = making.get(key);
  if (!pending) {
    pending = (async () => {
      const image = await loadImage(deps, sha);
      if (!image) return null;
      const size = pngSize(image);
      const crop = top ? topCrop(size) : undefined;
      const part = crop ?? size;
      const out = thumbSize(part, edge);
      if (out.width === size.width && part.height === size.height && mode === 'plain') return image;
      const job = { thumb: true as const, png: image, edge, mode, crop };
      const result = deps.runThumb ? await deps.runThumb(job) : makeThumb(job);
      if (result.kind !== 'thumb') return image;
      await deps.storage.put(key, result.png);
      return result.png;
    })().finally(() => making.delete(key));
    making.set(key, pending);
  }
  return pending;
}

/** A part of image `sha`, scaled down to fit `edge`; made on request, kept in memory (CROPS_KEPT). */
async function loadCrop(
  deps: Pick<Deps, 'storage' | 'runThumb'>,
  sha: string,
  edge: number,
  mode: ThumbMode,
  crop: Rect,
): Promise<Uint8Array | null> {
  const key = `${sha}-${edge}-${mode}-${crop.x},${crop.y},${crop.width},${crop.height}`;
  const kept = crops.get(key);
  if (kept) {
    // Most recently used last: the first entry is the one to forget.
    crops.delete(key);
    crops.set(key, kept);
    return kept;
  }
  let pending = making.get(key);
  if (!pending) {
    pending = (async () => {
      const image = await loadImage(deps, sha);
      if (!image) return null;
      const job = { thumb: true as const, png: image, edge, mode, crop };
      const result = deps.runThumb ? await deps.runThumb(job) : makeThumb(job);
      if (result.kind !== 'thumb') return null;
      crops.set(key, result.png);
      for (const old of crops.keys()) {
        if (crops.size <= CROPS_KEPT) break;
        crops.delete(old);
      }
      return result.png;
    })().finally(() => making.delete(key));
    making.set(key, pending);
  }
  return pending;
}

/** Every thumbnail key an image can have: deleted with the image. */
export function thumbKeys(sha: string): string[] {
  return THUMB_EDGES.flatMap((edge) =>
    [false, true].flatMap((top) => [thumbKey(sha, edge, 'plain', top), thumbKey(sha, edge, 'diff', top)]),
  );
}
