import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readPngHeader, storeImage } from '../../src/domain/images';
import { DAY_MS, runRetention } from '../../src/domain/retention';
import { DatabaseStorage } from '../../src/storage/database';
import { LocalStorage } from '../../src/storage/local';
import { MemoryStorage } from '../../src/storage/memory';
import { imageKey, type Storage } from '../../src/storage/storage';
import { createTestDb } from '../helpers/db';
import { makePng } from '../helpers/png';

const SHA = 'ab'.repeat(32);

describe('imageKey', () => {
  test('shards by the first four hex characters', () => {
    expect(imageKey(SHA)).toBe(`images/ab/ab/${SHA}.png`);
  });

  test('rejects anything but a lowercase sha256', () => {
    expect(() => imageKey('../etc/passwd')).toThrow('Invalid image sha');
    expect(() => imageKey(SHA.toUpperCase())).toThrow('Invalid image sha');
  });
});

type Made = { storage: Storage; cleanup: () => void | Promise<void> };

function contract(name: string, make: () => Made | Promise<Made>) {
  describe(name, () => {
    let storage: Storage;
    let cleanup: () => void | Promise<void>;

    beforeEach(async () => {
      ({ storage, cleanup } = await make());
    });

    afterEach(async () => {
      await cleanup();
    });

    test('round-trips bytes', async () => {
      await storage.put('images/a/b/c.png', new Uint8Array([1, 2, 3]));
      expect(await storage.get('images/a/b/c.png')).toEqual(new Uint8Array([1, 2, 3]));
      expect(await storage.exists('images/a/b/c.png')).toBe(true);
    });

    test('returns null for a missing key', async () => {
      expect(await storage.get('images/missing.png')).toBeNull();
      expect(await storage.exists('images/missing.png')).toBe(false);
    });

    test('overwrites and deletes', async () => {
      await storage.put('k.png', new Uint8Array([1]));
      await storage.put('k.png', new Uint8Array([2]));
      expect(await storage.get('k.png')).toEqual(new Uint8Array([2]));
      await storage.delete('k.png');
      await storage.delete('k.png');
      expect(await storage.get('k.png')).toBeNull();
    });
  });
}

contract('MemoryStorage', () => ({ storage: new MemoryStorage(), cleanup: () => {} }));

contract('LocalStorage', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pixeltwin-storage-'));
  return { storage: new LocalStorage(dir), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
});

describe('LocalStorage specifics', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pixeltwin-storage-'));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test('leaves no temp files behind', async () => {
    const storage = new LocalStorage(dir);
    await storage.put('images/ab/cd/x.png', new Uint8Array([9]));
    expect(readdirSync(join(dir, 'images/ab/cd'))).toEqual(['x.png']);
  });

  test('refuses keys that escape the root', async () => {
    const storage = new LocalStorage(dir);
    await expect(storage.put('../outside.png', new Uint8Array([1]))).rejects.toThrow('Invalid storage key');
    await expect(storage.get('/etc/passwd')).rejects.toThrow('Invalid storage key');
  });
});

// Images in the database itself (STORAGE=postgres): replicas need no shared disk.
contract('DatabaseStorage', async () => {
  const handle = await createTestDb();
  return { storage: new DatabaseStorage(handle.db), cleanup: () => handle.close() };
});

// With SQLite one connection serves everything, so image GC (a transaction that also deletes the
// bytes) needs Postgres for this storage; the config only allows STORAGE=postgres with Postgres.
test.skipIf(!process.env.TEST_DATABASE_URL)('image GC removes unused bytes from the database storage', async () => {
  const handle = await createTestDb();
  try {
    const storage = new DatabaseStorage(handle.db);
    const deps = {
      db: handle.db,
      storage,
      runDiff: async () => ({ kind: 'error' as const, code: 'diff_failed' as const, message: 'unused' }),
      limits: { maxImageBytes: 10 * 1024 * 1024, maxImagePixels: 40_000_000 },
    };
    const png = makePng(10, 10);
    const sha = await storeImage(deps, png, readPngHeader(png, deps.limits));
    expect(await storage.exists(imageKey(sha))).toBe(true);
    const result = await runRetention(deps, Date.now() + 2 * DAY_MS);
    expect(result.imagesDeleted).toBe(1);
    expect(await storage.exists(imageKey(sha))).toBe(false);
  } finally {
    await handle.close();
  }
});
