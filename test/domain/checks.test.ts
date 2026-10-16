import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Project } from '../../src/db/schema';
import { compareImages } from '../../src/diff/compare';
import type { DiffData } from '../../src/diff/types';
import { finalizeBuild, getBuild } from '../../src/domain/builds';
import { getCheck, listChecks } from '../../src/domain/checks';
import { sha256Hex } from '../../src/domain/images';
import { updateProject } from '../../src/domain/projects';
import { imageKey } from '../../src/storage/storage';
import { createTestDeps, type TestDeps } from '../helpers/deps';
import { appError } from '../helpers/errors';
import { BLACK, makePng, WHITE } from '../helpers/png';
import { openBuild, seedBaseline, seedProject, submit } from '../helpers/scenario';

const white = makePng(100, 100);
const withSquare = makePng(100, 100, WHITE, [{ x: 10, y: 10, width: 10, height: 10, color: BLACK }]);

describe('submitCheck', () => {
  let deps: TestDeps;
  let project: Project;

  beforeEach(async () => {
    deps = await createTestDeps();
    project = await seedProject(deps);
  });

  afterEach(async () => {
    await deps.handle.close();
  });

  test('a snapshot without a baseline is new and pending', async () => {
    const buildId = await openBuild(deps);
    const { check, created } = await submit(deps, buildId, white, { variant: { browser: 'chromium' } });
    expect(created).toBe(true);
    expect(check).toMatchObject({
      buildId,
      name: 'home',
      variant: { browser: 'chromium' },
      result: 'new',
      review: 'pending',
      baseline: null,
      diff: null,
      diffImageSha: null,
      colorThreshold: 0.1,
      tolerancePercent: 0,
    });
    expect(check.id).toStartWith('chk_');
    expect(await deps.storage.exists(imageKey(sha256Hex(white)))).toBe(true);
    expect((await getBuild(deps, buildId)).verdict).toBe('pending');
  });

  test('an identical image is unchanged without running a diff', async () => {
    await seedBaseline(deps, project, white);
    const buildId = await openBuild(deps);
    const { check } = await submit(deps, buildId, white);
    expect(check.result).toBe('unchanged');
    expect(check.review).toBe('none');
    expect((check.diff as DiffData).summary).toBe('Identical to baseline.');
    expect(deps.diffJobs).toHaveLength(0);
    expect((await getBuild(deps, buildId)).verdict).toBe('passed');
  });

  test('a changed image is pending with regions and a stored diff image', async () => {
    const baseline = await seedBaseline(deps, project, white);
    const buildId = await openBuild(deps);
    const { check } = await submit(deps, buildId, withSquare);
    expect(check.result).toBe('changed');
    expect(check.review).toBe('pending');
    expect(check.baseline).toEqual({ id: baseline.id, branch: 'main', fallback: false, imageSha: baseline.imageSha });
    expect((check.diff as DiffData).regions).toEqual([{ x: 10, y: 10, width: 10, height: 10, pixels: 100 }]);
    expect(check.diffImageSha).toMatch(/^[0-9a-f]{64}$/);
    expect(await deps.storage.exists(imageKey(check.diffImageSha as string))).toBe(true);
  });

  test('a feature branch falls back to the base branch baseline', async () => {
    await seedBaseline(deps, project, white);
    const buildId = await openBuild(deps, 'web', { branch: 'feature/login' });
    const { check } = await submit(deps, buildId, white);
    expect(check.result).toBe('unchanged');
    expect(check.baseline).toMatchObject({ branch: 'main', fallback: true });
  });

  test('project thresholds apply unless the check overrides them', async () => {
    await updateProject(deps, 'web', { tolerancePercent: 2 });
    await seedBaseline(deps, project, white);
    const buildId = await openBuild(deps);
    expect((await submit(deps, buildId, withSquare)).check).toMatchObject({ result: 'unchanged', tolerancePercent: 2 });
    expect((await submit(deps, buildId, withSquare, { tolerancePercent: 0 })).check.result).toBe('changed');
  });

  test('resubmitting a snapshot replaces the check in place', async () => {
    await seedBaseline(deps, project, white);
    const buildId = await openBuild(deps);
    const first = await submit(deps, buildId, withSquare);
    const second = await submit(deps, buildId, white);
    expect(second.created).toBe(false);
    expect(second.check.id).toBe(first.check.id);
    expect(second.check.result).toBe('unchanged');
    expect((await listChecks(deps, buildId)).items).toHaveLength(1);
  });

  test('concurrent submissions of one snapshot leave one check', async () => {
    const buildId = await openBuild(deps);
    const results = await Promise.allSettled([submit(deps, buildId, white), submit(deps, buildId, withSquare)]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    expect((await listChecks(deps, buildId)).items).toHaveLength(1);
  });

  test('a finalized build rejects new checks with 409', async () => {
    const buildId = await openBuild(deps);
    await finalizeBuild(deps, buildId);
    const err = await appError(submit(deps, buildId, white));
    expect(err.code).toBe('build_finalized');
    expect(err.status).toBe(409);
  });

  test('an invalid image is a 422 and stores nothing', async () => {
    const buildId = await openBuild(deps);
    const corrupt = makePng(10, 10).slice(0, 40);
    const err = await appError(submit(deps, buildId, corrupt));
    expect(err.code).toBe('invalid_image');
    expect(deps.storage.objects.size).toBe(0);
    expect(await deps.db.selectFrom('checks').selectAll().execute()).toEqual([]);
  });

  test('invalid metadata is a 422 with field paths', async () => {
    const buildId = await openBuild(deps);
    const err = await appError(submit(deps, buildId, white, { name: '', colour: 'red' }));
    expect(err.code).toBe('validation_failed');
    expect(err.errors?.map((e) => e.path)).toContain('name');
  });

  test('a diff failure is recorded as an error result', async () => {
    const failing = await createTestDeps(async () => ({ kind: 'error', code: 'diff_timeout', message: 'too slow' }));
    try {
      const p = await seedProject(failing);
      await seedBaseline(failing, p, white);
      const buildId = await openBuild(failing);
      const { check } = await submit(failing, buildId, withSquare);
      expect(check).toMatchObject({ result: 'error', review: 'none', diff: { error: { code: 'diff_timeout' } } });
      expect((await getBuild(failing, buildId)).verdict).toBe('error');
    } finally {
      await failing.handle.close();
    }
  });

  test('a baseline image missing from storage is an error result, not a crash', async () => {
    await seedBaseline(deps, project, white);
    deps.storage.objects.clear();
    const buildId = await openBuild(deps);
    const { check } = await submit(deps, buildId, withSquare);
    expect(check).toMatchObject({ result: 'error', diff: { error: { code: 'diff_failed' } } });
  });

  test('differently shaped images whose combined canvas exceeds the pixel limit are an error result', async () => {
    deps.limits.maxImagePixels = 5000;
    await seedBaseline(deps, project, makePng(100, 10));
    const buildId = await openBuild(deps);
    const { check } = await submit(deps, buildId, makePng(10, 100));
    expect(check).toMatchObject({ result: 'error', diff: { error: { code: 'diff_failed' } } });
  });

  test('lists checks with filters', async () => {
    await seedBaseline(deps, project, white);
    const buildId = await openBuild(deps);
    await submit(deps, buildId, white);
    const changed = await submit(deps, buildId, withSquare, { name: 'other', variant: { v: '1' } });
    await submit(deps, buildId, withSquare, { name: 'third' });
    expect((await listChecks(deps, buildId)).items).toHaveLength(3);
    expect((await listChecks(deps, buildId, { result: 'new' })).items.map((c) => c.name)).toEqual(['other', 'third']);
    expect((await listChecks(deps, buildId, { review: 'none' })).items.map((c) => c.name)).toEqual(['home']);
    expect(await getCheck(deps, changed.check.id)).toEqual(changed.check);
    expect((await appError(getCheck(deps, 'chk_missing'))).code).toBe('check_not_found');
  });

  test('lists checks newest first and finds them by name or variant', async () => {
    const buildId = await openBuild(deps);
    await submit(deps, buildId, white, { name: 'Home page', variant: { browser: 'chromium' } });
    await submit(deps, buildId, white, { name: 'cart', variant: { browser: 'webkit' } });
    await submit(deps, buildId, white, { name: 'footer_100%', variant: { browser: 'chromium' } });
    const names = async (options: Parameters<typeof listChecks>[2]) =>
      (await listChecks(deps, buildId, options)).items.map((c) => c.name);

    expect(await names({ order: 'desc' })).toEqual(['footer_100%', 'cart', 'Home page']);
    expect(await names({})).toEqual(['Home page', 'cart', 'footer_100%']);
    expect(await names({ q: 'HOME' })).toEqual(['Home page']);
    expect(await names({ q: 'webkit' })).toEqual(['cart']);
    // % and _ are searched for literally, not as wildcards.
    expect(await names({ q: '_100%' })).toEqual(['footer_100%']);
    expect(await names({ q: '%' })).toEqual(['footer_100%']);
    // Newest first pages backwards through the build.
    const first = await listChecks(deps, buildId, { order: 'desc', limit: 2 });
    expect(first.items.map((c) => c.name)).toEqual(['footer_100%', 'cart']);
    expect(await names({ order: 'desc', cursor: first.nextCursor ?? '' })).toEqual(['Home page']);
  });
});

describe('submitCheck racing finalize', () => {
  test('a check whose diff is still running when the build is finalized is rejected', async () => {
    const slow = await createTestDeps(async (job) => {
      await Bun.sleep(100);
      return compareImages(job);
    });
    try {
      const project = await seedProject(slow);
      await seedBaseline(slow, project, white);
      const buildId = await openBuild(slow);
      const submission = submit(slow, buildId, withSquare);
      await Bun.sleep(20);
      const finalized = await finalizeBuild(slow, buildId);
      expect(finalized.verdict).toBe('empty');

      const err = await appError(submission);
      expect(err.code).toBe('build_finalized');
      const build = await getBuild(slow, buildId);
      expect(build.verdict).toBe('empty');
      expect(build.counts.total).toBe(0);
    } finally {
      await slow.handle.close();
    }
  });
});
