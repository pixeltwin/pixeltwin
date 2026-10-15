import { createHash } from 'node:crypto';
import { AppError } from '../errors';
import { imageKey } from '../storage/storage';
import type { Deps, ImageLimits } from './deps';

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export interface PngSize {
  width: number;
  height: number;
}

function invalid(detail: string): AppError {
  return new AppError('invalid_image', 422, detail);
}

/**
 * Cheap checks before any decoding: size limit, PNG signature, IHDR dimensions, pixel limit.
 * Full decoding happens later in a diff worker.
 */
export function readPngHeader(bytes: Uint8Array, limits: ImageLimits): PngSize {
  if (bytes.byteLength > limits.maxImageBytes) {
    throw invalid(`Image is ${bytes.byteLength} bytes; the limit is ${limits.maxImageBytes}.`);
  }
  if (bytes.byteLength < 24 || !PNG_SIGNATURE.every((b, i) => bytes[i] === b)) {
    throw invalid('Image is not a PNG.');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (String.fromCharCode(...bytes.subarray(12, 16)) !== 'IHDR') throw invalid('PNG is missing its IHDR header.');
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  if (width === 0 || height === 0) throw invalid('PNG has zero width or height.');
  if (width * height > limits.maxImagePixels) {
    throw invalid(`Image is ${width}×${height} (${width * height} pixels); the limit is ${limits.maxImagePixels}.`);
  }
  return { width, height };
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Stores the PNG once per content hash and records it in `images`. Returns the sha. */
export async function storeImage(
  deps: Pick<Deps, 'db' | 'storage'>,
  bytes: Uint8Array,
  size: PngSize,
): Promise<string> {
  const sha = sha256Hex(bytes);
  const key = imageKey(sha);
  if (!(await deps.storage.exists(key))) await deps.storage.put(key, bytes);
  await deps.db
    .insertInto('images')
    .values({ sha, width: size.width, height: size.height, bytes: bytes.byteLength, createdAt: Date.now() })
    .onConflict((oc) => oc.column('sha').doNothing())
    .execute();
  return sha;
}

export function loadImage(deps: Pick<Deps, 'storage'>, sha: string): Promise<Uint8Array | null> {
  return deps.storage.get(imageKey(sha));
}

/** Stored dimensions of the given images; unknown shas are absent from the map. */
export async function imageSizes(deps: Pick<Deps, 'db'>, shas: string[]): Promise<Map<string, PngSize>> {
  const wanted = [...new Set(shas)];
  if (wanted.length === 0) return new Map();
  const rows = await deps.db
    .selectFrom('images')
    .select(['sha', 'width', 'height'])
    .where('sha', 'in', wanted)
    .execute();
  return new Map(rows.map((r) => [r.sha, { width: r.width, height: r.height }]));
}
