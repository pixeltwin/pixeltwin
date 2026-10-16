import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { checkNeighbors } from '../../src/domain/checks';
import { imageSizes, sha256Hex } from '../../src/domain/images';
import { approveCheck } from '../../src/domain/reviews';
import { createTestDeps, type TestDeps } from '../helpers/deps';
import { makePng } from '../helpers/png';
import { openBuild, seedBaseline, seedProject, submit } from '../helpers/scenario';

describe('check navigation and image sizes', () => {
  let deps: TestDeps;

  beforeEach(async () => {
    deps = await createTestDeps();
  });

  afterEach(async () => {
    await deps.handle.close();
  });

  test('previous, next and the next pending check, newest first, wrapping around', async () => {
    const project = await seedProject(deps);
    await seedBaseline(deps, project, makePng(10, 10), { name: 'b' });
    const buildId = await openBuild(deps);
    const a = (await submit(deps, buildId, makePng(10, 10), { name: 'a' })).check;
    const b = (await submit(deps, buildId, makePng(10, 10), { name: 'b' })).check;
    const c = (await submit(deps, buildId, makePng(10, 10), { name: 'c' })).check;
    expect(b.review).toBe('none');

    // Newest first (c, b, a): next is the next older check; the pending search wraps to the newest.
    expect(await checkNeighbors(deps, a)).toEqual({ previous: b.id, next: null, nextPending: c.id });
    expect(await checkNeighbors(deps, c)).toEqual({ previous: null, next: b.id, nextPending: a.id });
    await approveCheck(deps, a.id, 'usr_1');
    expect((await checkNeighbors(deps, c)).nextPending).toBeNull();
  });

  test('imageSizes returns stored dimensions', async () => {
    const project = await seedProject(deps);
    const png = makePng(30, 20);
    await seedBaseline(deps, project, png);
    const sizes = await imageSizes(deps, [sha256Hex(png), 'f'.repeat(64)]);
    expect([...sizes.entries()]).toEqual([[sha256Hex(png), { width: 30, height: 20 }]]);
    expect((await imageSizes(deps, [])).size).toBe(0);
  });
});
