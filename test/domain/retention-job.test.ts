import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { migrateToLatest, openDatabase } from '../../src/db/database';
import { readPngHeader, storeImage } from '../../src/domain/images';
import { IMAGE_GRACE_MS } from '../../src/domain/retention';
import { type RetentionJob, startRetentionJob } from '../../src/domain/retention-job';
import { createLogger } from '../../src/log';
import { imageKey } from '../../src/storage/storage';
import { createTestDeps, type TestDeps } from '../helpers/deps';
import { makePng } from '../helpers/png';

function recordingLogger() {
  const lines: Array<Record<string, unknown>> = [];
  return { logger: createLogger('debug', (line) => lines.push(JSON.parse(line))), lines };
}

describe('retention job', () => {
  let deps: TestDeps;
  let job: RetentionJob | undefined;

  beforeEach(async () => {
    deps = await createTestDeps();
  });

  afterEach(async () => {
    await job?.stop();
    job = undefined;
    await deps.handle.close();
  });

  async function oldOrphan(): Promise<string> {
    const png = makePng(5, 5);
    const sha = await storeImage(deps, png, readPngHeader(png, deps.limits));
    await deps.db
      .updateTable('images')
      .set({ createdAt: Date.now() - IMAGE_GRACE_MS - 1000 })
      .execute();
    return sha;
  }

  test('runs on schedule and logs what it removed', async () => {
    const sha = await oldOrphan();
    const { logger, lines } = recordingLogger();
    job = startRetentionJob({ deps, handle: deps.handle, logger, firstRunDelayMs: 0, intervalMs: 60_000 });
    // The image goes first, the log line after the pass: wait for both.
    const logged = () => lines.some((l) => l.msg === 'retention');
    for (let i = 0; i < 100 && ((await deps.storage.exists(imageKey(sha))) || !logged()); i++) await Bun.sleep(10);
    expect(await deps.storage.exists(imageKey(sha))).toBe(false);
    expect(lines.find((l) => l.msg === 'retention')).toMatchObject({ buildsDeleted: 0, imagesDeleted: 1 });
  });

  test('a failing pass is logged, not thrown, and the next pass still runs', async () => {
    const sha = await oldOrphan();
    const { logger, lines } = recordingLogger();
    const original = deps.storage.delete.bind(deps.storage);
    let fail = true;
    deps.storage.delete = async (key: string) => {
      if (fail) throw new Error('storage unavailable');
      return original(key);
    };
    job = startRetentionJob({ deps, handle: deps.handle, logger, firstRunDelayMs: 60_000 });
    expect(await job.runNow()).toBeNull();
    expect(lines.find((l) => l.msg === 'retention failed')).toMatchObject({ error: 'storage unavailable' });

    fail = false;
    expect(await job.runNow()).toEqual({ buildsDeleted: 0, imagesDeleted: 1 });
    expect(await deps.storage.exists(imageKey(sha))).toBe(false);
  });

  test('overlapping calls share one pass', async () => {
    const { logger } = recordingLogger();
    job = startRetentionJob({ deps, handle: deps.handle, logger, firstRunDelayMs: 60_000 });
    const [a, b] = [job.runNow(), job.runNow()];
    expect(a).toBe(b);
    await a;
  });

  test.if(Boolean(process.env.TEST_DATABASE_URL))('only one replica runs a pass at a time on Postgres', async () => {
    const url = process.env.TEST_DATABASE_URL as string;
    const replicaA = openDatabase(url);
    const replicaB = openDatabase(url);
    await migrateToLatest(replicaA.db);
    const { logger } = recordingLogger();
    // Replica A holds the lock while its storage delete is slow.
    await oldOrphan();
    const slowStorage = {
      ...deps.storage,
      exists: deps.storage.exists.bind(deps.storage),
      get: deps.storage.get.bind(deps.storage),
      put: deps.storage.put.bind(deps.storage),
      check: deps.storage.check.bind(deps.storage),
      delete: async (key: string) => {
        await Bun.sleep(300);
        await deps.storage.delete(key);
      },
    };
    const a = startRetentionJob({
      deps: { db: replicaA.db, storage: slowStorage },
      handle: replicaA,
      logger,
      firstRunDelayMs: 60_000,
    });
    const b = startRetentionJob({
      deps: { db: replicaB.db, storage: deps.storage },
      handle: replicaB,
      logger,
      firstRunDelayMs: 60_000,
    });
    try {
      const first = a.runNow();
      await Bun.sleep(100);
      expect(await b.runNow()).toBeNull();
      expect(await first).toEqual({ buildsDeleted: 0, imagesDeleted: 1 });
    } finally {
      await a.stop();
      await b.stop();
      await replicaA.close();
      await replicaB.close();
    }
  });
});
