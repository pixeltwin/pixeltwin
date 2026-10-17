import { makeThumb, THUMB_EDGES, type ThumbMode, thumbSize } from '../diff/thumb';
import { thumbKey } from '../storage/storage';
import type { Deps } from './deps';
import { loadImage } from './images';

/**
 * Card thumbnails (thumb.ts): made on first request, stored next to the image (`thumbs/…`) and
 * served from storage after that. Images are content-addressed, so a thumbnail never changes.
 */

/** Thumbnails being made right now, so cards asking at once wait for one job. */
const making = new Map<string, Promise<Uint8Array | null>>();

/** Width and height from the PNG's IHDR (stored images were checked on upload). */
function pngSize(bytes: Uint8Array): { width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/**
 * The thumbnail of image `sha` whose longer side is at most `edge`; null for an unknown image. An
 * image that fits already is served as it is. When the worker fails, the full image is served
 * (and nothing is stored), so a card still shows its screenshot.
 */
export async function loadThumb(
  deps: Pick<Deps, 'storage' | 'runThumb'>,
  sha: string,
  edge: number,
  mode: ThumbMode,
): Promise<Uint8Array | null> {
  const key = thumbKey(sha, edge, mode);
  const stored = await deps.storage.get(key);
  if (stored) return stored;
  let pending = making.get(key);
  if (!pending) {
    pending = (async () => {
      const image = await loadImage(deps, sha);
      if (!image) return null;
      const size = pngSize(image);
      const out = thumbSize(size, edge);
      if (out.width === size.width && mode === 'plain') return image;
      const job = { thumb: true as const, png: image, edge, mode };
      const result = deps.runThumb ? await deps.runThumb(job) : makeThumb(job);
      if (result.kind !== 'thumb') return image;
      await deps.storage.put(key, result.png);
      return result.png;
    })().finally(() => making.delete(key));
    making.set(key, pending);
  }
  return pending;
}

/** Every thumbnail key an image can have: deleted with the image. */
export function thumbKeys(sha: string): string[] {
  return THUMB_EDGES.flatMap((edge) => [thumbKey(sha, edge, 'plain'), thumbKey(sha, edge, 'diff')]);
}
