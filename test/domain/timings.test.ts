import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { addTimings, finalizeBuild, getBuild } from '../../src/domain/builds';
import { createTestDeps, type TestDeps } from '../helpers/deps';
import { appError } from '../helpers/errors';
import { makePng } from '../helpers/png';
import { openBuild, seedProject, submit } from '../helpers/scenario';

describe('timings: how long pixeltwin took in a run', () => {
  let deps: TestDeps;

  beforeEach(async () => {
    deps = await createTestDeps();
    await seedProject(deps);
  });

  afterEach(async () => {
    await deps.handle.close();
  });

  test('each check records the server time it took; the build adds them up', async () => {
    const buildId = await openBuild(deps);
    const a = (await submit(deps, buildId, makePng(100, 100), { name: 'a' })).check;
    const b = (await submit(deps, buildId, makePng(100, 100), { name: 'b' })).check;
    expect(a.compareMs).toBeGreaterThanOrEqual(0);
    const { timing } = await getBuild(deps, buildId);
    expect(timing).toEqual({
      checks: 0,
      screenshotMs: 0,
      uploadMs: 0,
      retakes: 0,
      compareMs: (a.compareMs ?? 0) + (b.compareMs ?? 0),
    });
  });

  test('the SDK adds its own times from each worker, also after the build is finalized', async () => {
    const buildId = await openBuild(deps);
    await addTimings(deps, buildId, { checks: 3, screenshotMs: 900, uploadMs: 400, retakes: 1 });
    await finalizeBuild(deps, buildId);
    await addTimings(deps, buildId, { checks: 2, screenshotMs: 100, uploadMs: 50, retakes: 0 });
    expect((await getBuild(deps, buildId)).timing).toMatchObject({
      checks: 5,
      screenshotMs: 1000,
      uploadMs: 450,
      retakes: 1,
    });
    expect((await appError(addTimings(deps, buildId, { checks: -1 }))).code).toBe('validation_failed');
  });
});
