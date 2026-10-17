import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { finalizeBuild } from '../../src/domain/builds';
import { readPngHeader, sha256Hex, storeImage } from '../../src/domain/images';
import { createProject } from '../../src/domain/projects';
import { DAY_MS, IMAGE_GRACE_MS, runRetention } from '../../src/domain/retention';
import { approveCheck } from '../../src/domain/reviews';
import { imageKey, thumbKey } from '../../src/storage/storage';
import { createTestDeps, type TestDeps } from '../helpers/deps';
import { BLACK, makePng, WHITE } from '../helpers/png';
import { openBuild, submit } from '../helpers/scenario';

const NOW = Date.now();
const white = makePng(60, 60);
const withSquare = makePng(60, 60, WHITE, [{ x: 5, y: 5, width: 10, height: 10, color: BLACK }]);

describe('retention', () => {
  let deps: TestDeps;

  beforeEach(async () => {
    deps = await createTestDeps();
    await createProject(deps, { slug: 'web', name: 'Web', retentionDays: 30 });
  });

  afterEach(async () => {
    await deps.handle.close();
  });

  const age = (table: 'builds' | 'images', ms: number) =>
    deps.db
      .updateTable(table)
      .set({ createdAt: NOW - ms })
      .execute();

  test('deletes builds older than their project allows, finalized or abandoned, and keeps baselines', async () => {
    const old = await openBuild(deps);
    const { check } = await submit(deps, old, white);
    await approveCheck(deps, check.id, 'usr_1');
    await finalizeBuild(deps, old);
    const abandoned = await openBuild(deps);
    await age('builds', 31 * DAY_MS);
    const recent = await openBuild(deps);

    const result = await runRetention(deps, NOW);
    expect(result.buildsDeleted).toBe(2);
    const builds = await deps.db.selectFrom('builds').select('id').execute();
    expect(builds.map((b) => b.id)).toEqual([recent]);
    expect(builds.map((b) => b.id)).not.toContain(abandoned);
    expect(await deps.db.selectFrom('checks').selectAll().execute()).toEqual([]);

    const baselines = await deps.db.selectFrom('baselines').selectAll().execute();
    expect(baselines).toHaveLength(1);
    expect(baselines[0]?.sourceCheckId).toBeNull();
    expect(await deps.storage.exists(imageKey(sha256Hex(white)))).toBe(true);
  });

  test('each project keeps builds for its own number of days', async () => {
    await createProject(deps, { slug: 'long', name: 'Long', retentionDays: 365 });
    await openBuild(deps, 'web');
    await openBuild(deps, 'long');
    await age('builds', 100 * DAY_MS);
    expect((await runRetention(deps, NOW)).buildsDeleted).toBe(1);
    const left = await deps.db
      .selectFrom('builds')
      .innerJoin('projects', 'projects.id', 'builds.projectId')
      .select('projects.slug')
      .execute();
    expect(left.map((r) => r.slug)).toEqual(['long']);
  });

  test('collects unreferenced images after the grace period, never referenced ones', async () => {
    const baselineBuild = await openBuild(deps);
    const first = await submit(deps, baselineBuild, white);
    await approveCheck(deps, first.check.id, 'usr_1');
    const changedBuild = await openBuild(deps);
    const changed = await submit(deps, changedBuild, withSquare);
    const orphan = makePng(7, 7);
    const orphanSha = await storeImage(deps, orphan, readPngHeader(orphan, deps.limits));
    await age('images', IMAGE_GRACE_MS + 1000);

    await deps.storage.put(thumbKey(orphanSha, 320, 'plain'), orphan);
    await deps.storage.put(thumbKey(orphanSha, 640, 'diff'), orphan);
    await deps.storage.put(thumbKey(orphanSha, 960, 'diff', true), orphan);
    const result = await runRetention(deps, NOW);
    expect(result.imagesDeleted).toBe(1);
    expect(await deps.storage.exists(imageKey(orphanSha))).toBe(false);
    expect(await deps.storage.exists(thumbKey(orphanSha, 320, 'plain'))).toBe(false);
    expect(await deps.storage.exists(thumbKey(orphanSha, 640, 'diff'))).toBe(false);
    expect(await deps.storage.exists(thumbKey(orphanSha, 960, 'diff', true))).toBe(false);
    const kept = (await deps.db.selectFrom('images').select('sha').execute()).map((r) => r.sha).sort();
    expect(kept).toEqual([sha256Hex(white), sha256Hex(withSquare), changed.check.diffImageSha as string].sort());
  });

  test('young images and images stored again recently are kept', async () => {
    const orphan = makePng(7, 7);
    const sha = await storeImage(deps, orphan, readPngHeader(orphan, deps.limits));
    expect((await runRetention(deps, NOW)).imagesDeleted).toBe(0);

    await age('images', IMAGE_GRACE_MS + 1000);
    await storeImage(deps, orphan, readPngHeader(orphan, deps.limits));
    expect((await runRetention(deps, Date.now())).imagesDeleted).toBe(0);
    expect(await deps.storage.exists(imageKey(sha))).toBe(true);
  });

  test('handles more than one batch', async () => {
    const values = Array.from({ length: 520 }, (_, i) => ({
      sha: i.toString(16).padStart(64, '0'),
      width: 1,
      height: 1,
      bytes: 1,
      createdAt: NOW - IMAGE_GRACE_MS - 1000,
    }));
    for (let i = 0; i < values.length; i += 100) {
      await deps.db
        .insertInto('images')
        .values(values.slice(i, i + 100))
        .execute();
    }
    expect((await runRetention(deps, NOW)).imagesDeleted).toBe(520);
    expect(await deps.db.selectFrom('images').selectAll().execute()).toEqual([]);
  });

  test('an image stored again while clean-up deletes it keeps its bytes', async () => {
    const png = makePng(9, 9);
    const sha = await storeImage(deps, png, readPngHeader(png, deps.limits));
    await age('images', IMAGE_GRACE_MS + 1000);
    const original = deps.storage.delete.bind(deps.storage);
    let reuse: Promise<string> | undefined;
    deps.storage.delete = async (key: string) => {
      // A concurrent upload of the same screenshot, given time to get as far as it can.
      reuse ??= storeImage(deps, png, readPngHeader(png, deps.limits));
      await Bun.sleep(50);
      return original(key);
    };
    await runRetention(deps, NOW);
    await reuse;
    expect(await deps.db.selectFrom('images').select('sha').where('sha', '=', sha).executeTakeFirst()).toBeDefined();
    expect(await deps.storage.exists(imageKey(sha))).toBe(true);
  });

  test('a failed storage delete keeps the image row, so the file is collected next time', async () => {
    const png = makePng(9, 9);
    const sha = await storeImage(deps, png, readPngHeader(png, deps.limits));
    await age('images', IMAGE_GRACE_MS + 1000);
    const original = deps.storage.delete.bind(deps.storage);
    deps.storage.delete = async () => {
      throw new Error('storage unavailable');
    };
    await expect(runRetention(deps, NOW)).rejects.toThrow('storage unavailable');
    expect(await deps.db.selectFrom('images').select('sha').where('sha', '=', sha).executeTakeFirst()).toBeDefined();
    deps.storage.delete = original;
    expect((await runRetention(deps, NOW)).imagesDeleted).toBe(1);
    expect(await deps.storage.exists(imageKey(sha))).toBe(false);
  });
});
