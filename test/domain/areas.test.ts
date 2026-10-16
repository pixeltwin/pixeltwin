import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Project } from '../../src/db/schema';
import { createArea, deleteArea, listAreas } from '../../src/domain/areas';
import { getBuild } from '../../src/domain/builds';
import { approveCheck } from '../../src/domain/reviews';
import { createTestDeps, type TestDeps } from '../helpers/deps';
import { appError } from '../helpers/errors';
import { BLACK, makePng, WHITE } from '../helpers/png';
import { openBuild, seedBaseline, seedProject, submit } from '../helpers/scenario';

const white = makePng(100, 100);
// A changing clock top-left and a changed button bottom-right.
const clock = { x: 10, y: 10, width: 10, height: 10, color: BLACK };
const button = { x: 70, y: 70, width: 10, height: 10, color: BLACK };
const clockOnly = makePng(100, 100, WHITE, [clock]);
const both = makePng(100, 100, WHITE, [clock, button]);
const overClock = { x: 5, y: 5, width: 20, height: 20 };

describe('ignore and compare areas', () => {
  let deps: TestDeps;
  let project: Project;

  beforeEach(async () => {
    deps = await createTestDeps();
    project = await seedProject(deps);
    await seedBaseline(deps, project, white);
  });

  afterEach(async () => {
    await deps.handle.close();
  });

  async function changed(png = clockOnly, branch = 'main') {
    const buildId = await openBuild(deps, 'web', { branch });
    return { buildId, check: (await submit(deps, buildId, png)).check };
  }

  test('an ignore area over the change makes the check unchanged at once', async () => {
    const { buildId, check } = await changed();
    expect(check).toMatchObject({ result: 'changed', review: 'pending' });

    const { area, check: after } = await createArea(deps, check.id, 'usr_1', { kind: 'ignore', ...overClock });
    expect(area).toMatchObject({ kind: 'ignore', ...overClock, snapshotKey: check.snapshotKey, createdBy: 'usr_1' });
    expect(area.id).toMatch(/^are_/);
    expect(after).toMatchObject({ result: 'unchanged', review: 'none', diffImageSha: null });
    expect((await getBuild(deps, buildId)).verdict).toBe('passed');
  });

  test('the area applies to every later check of the snapshot, on any branch', async () => {
    const { check } = await changed();
    await createArea(deps, check.id, 'usr_1', { kind: 'ignore', ...overClock });
    expect((await changed(clockOnly, 'feature/x')).check.result).toBe('unchanged');
    const next = (await changed(both)).check;
    expect(next.result).toBe('changed');
    expect(isDiff(next.diff) && next.diff.regions.map((r) => [r.x, r.y])).toEqual([[70, 70]]);
  });

  test('a compare area limits the comparison to itself', async () => {
    const { check } = await changed(both);
    const { check: after } = await createArea(deps, check.id, 'usr_1', {
      kind: 'compare',
      x: 50,
      y: 50,
      width: 50,
      height: 50,
    });
    expect(after.result).toBe('changed');
    expect(isDiff(after.diff) && after.diff.pixels).toBe(100);
  });

  test('deleting the area brings the change back', async () => {
    const { check } = await changed();
    const { area } = await createArea(deps, check.id, 'usr_1', { kind: 'ignore', ...overClock });
    const after = await deleteArea(deps, check.id, area.id);
    expect(after).toMatchObject({ result: 'changed', review: 'pending' });
    expect(await listAreas(deps, check.id)).toEqual([]);
  });

  test('a reviewed check keeps its review; only its diff follows the areas', async () => {
    const { check } = await changed();
    await approveCheck(deps, check.id, 'usr_1');
    const { check: after } = await createArea(deps, check.id, 'usr_2', { kind: 'ignore', ...overClock });
    expect(after).toMatchObject({ result: 'unchanged', review: 'approved' });
  });

  test('areas belong to their snapshot', async () => {
    const { check } = await changed();
    await createArea(deps, check.id, 'usr_1', { kind: 'ignore', ...overClock });
    await seedBaseline(deps, project, white, { name: 'cart' });
    const buildId = await openBuild(deps);
    expect((await submit(deps, buildId, clockOnly, { name: 'cart' })).check.result).toBe('changed');
    expect((await listAreas(deps, check.id)).map((a) => a.kind)).toEqual(['ignore']);
  });

  test('bad areas are refused', async () => {
    const { check } = await changed();
    expect((await appError(createArea(deps, check.id, 'usr_1', { kind: 'blur', ...overClock }))).code).toBe(
      'validation_failed',
    );
    expect(
      (await appError(createArea(deps, check.id, 'usr_1', { kind: 'ignore', x: 0, y: 0, width: 0, height: 5 }))).code,
    ).toBe('validation_failed');
    expect((await appError(createArea(deps, 'chk_missing', 'usr_1', { kind: 'ignore', ...overClock }))).code).toBe(
      'check_not_found',
    );
    expect((await appError(deleteArea(deps, check.id, 'are_missing'))).code).toBe('area_not_found');
  });
});

function isDiff(diff: unknown): diff is { pixels: number; regions: Array<{ x: number; y: number }> } {
  return typeof diff === 'object' && diff !== null && 'regions' in diff;
}
