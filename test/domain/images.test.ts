import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readPngHeader, sha256Hex, storeImage } from '../../src/domain/images';
import { AppError } from '../../src/errors';
import { imageKey } from '../../src/storage/storage';
import { createTestDeps, type TestDeps } from '../helpers/deps';
import { makePng } from '../helpers/png';

const limits = { maxImageBytes: 1_000_000, maxImagePixels: 10_000 };

function headerError(bytes: Uint8Array, custom = limits): AppError {
  try {
    readPngHeader(bytes, custom);
  } catch (err) {
    if (err instanceof AppError) return err;
    throw err;
  }
  throw new Error('expected an AppError');
}

describe('readPngHeader', () => {
  test('reads width and height', () => {
    expect(readPngHeader(makePng(40, 25), limits)).toEqual({ width: 40, height: 25 });
  });

  test('rejects non-PNG bytes', () => {
    const err = headerError(new TextEncoder().encode('GIF89a this is not a png at all'));
    expect(err.code).toBe('invalid_image');
    expect(err.status).toBe(422);
    expect(err.detail).toBe('Image is not a PNG.');
  });

  test('enforces the byte limit before anything else', () => {
    expect(headerError(makePng(10, 10), { maxImageBytes: 10, maxImagePixels: 10_000 }).detail).toContain(
      'the limit is 10',
    );
  });

  test('enforces the pixel limit from the header', () => {
    expect(headerError(makePng(200, 100)).detail).toBe('Image is 200×100 (20000 pixels); the limit is 10000.');
  });

  test('rejects zero dimensions', () => {
    const bytes = makePng(1, 1);
    new DataView(bytes.buffer).setUint32(16, 0);
    expect(headerError(bytes).detail).toBe('PNG has zero width or height.');
  });
});

describe('storeImage', () => {
  let deps: TestDeps;

  beforeEach(async () => {
    deps = await createTestDeps();
  });

  afterEach(async () => {
    await deps.handle.close();
  });

  test('stores bytes once per content hash', async () => {
    const png = makePng(10, 10);
    const sha = await storeImage(deps, png, { width: 10, height: 10 });
    await storeImage(deps, png, { width: 10, height: 10 });
    expect(sha).toBe(sha256Hex(png));
    expect(deps.storage.puts).toBe(1);
    expect(await deps.storage.get(imageKey(sha))).toEqual(png);
    const rows = await deps.db.selectFrom('images').selectAll().execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ sha, width: 10, height: 10, bytes: png.byteLength });
  });
});
