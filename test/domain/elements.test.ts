import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Project } from '../../src/db/schema';
import type { DiffData, SnapshotElement } from '../../src/diff/types';
import { createArea } from '../../src/domain/areas';
import { promoteBranch } from '../../src/domain/baselines';
import { checkElements, getCheck } from '../../src/domain/checks';
import { DAY_MS, IMAGE_GRACE_MS, runRetention } from '../../src/domain/retention';
import { approveCheck } from '../../src/domain/reviews';
import { createTestDeps, type TestDeps } from '../helpers/deps';
import { appError } from '../helpers/errors';
import { makePng, WHITE } from '../helpers/png';
import { openBuild, seedProject, submit } from '../helpers/scenario';

const BLUE = [0, 112, 243, 255] as [number, number, number, number];
/** A 200×100 page with a blue button at `y`. */
const page = (y: number) => makePng(200, 100, WHITE, [{ x: 20, y, width: 60, height: 20, color: BLUE }]);
const button = (y: number): SnapshotElement => ({
  key: '[data-testid=submit]',
  path: 'main > button',
  tag: 'button',
  role: 'button',
  name: 'Send',
  text: 'Send',
  x: 20,
  y,
  width: 60,
  height: 20,
});

describe('elements of a check', () => {
  let deps: TestDeps;
  let project: Project;

  beforeEach(async () => {
    deps = await createTestDeps();
    project = await seedProject(deps);
  });

  afterEach(async () => {
    await deps.handle.close();
  });

  async function baselineWithElements(branch = 'main') {
    const build = await openBuild(deps, 'web', { branch });
    const { check } = await submit(deps, build, page(20), { elements: [button(20)] });
    await approveCheck(deps, check.id, 'usr_1');
    return check;
  }

  test('a check keeps its elements; the baseline approved from it carries them to the next comparison', async () => {
    const first = await baselineWithElements();
    expect(first.elementCount).toBe(1);
    const build = await openBuild(deps);
    const { check } = await submit(deps, build, page(28), { elements: [button(28)] });
    const diff = check.diff as DiffData;
    expect(diff.changes?.map((c) => c.description)).toEqual(['`button[data-testid=submit]` moved 8 px down']);
    expect(diff.summary).toStartWith('`button[data-testid=submit]` moved 8 px down.');
    expect(await checkElements(deps, check.id)).toEqual({ current: [button(28)], baseline: [button(20)] });
  });

  test('without elements on either side the diff has no changes and the region summary', async () => {
    await baselineWithElements();
    const build = await openBuild(deps);
    const { check } = await submit(deps, build, page(28));
    expect(check.elementCount).toBeNull();
    expect(check.diff).not.toHaveProperty('changes');
    expect((check.diff as DiffData).summary).toMatch(/changed regions?; largest/);
  });

  test('an identical screenshot with elements lists no changes', async () => {
    await baselineWithElements();
    const { check } = await submit(deps, await openBuild(deps), page(20), { elements: [button(20)] });
    expect(check.result).toBe('unchanged');
    expect((check.diff as DiffData).changes).toEqual([]);
  });

  test('comparing again after an area changed keeps the element changes', async () => {
    await baselineWithElements();
    const { check } = await submit(deps, await openBuild(deps), page(28), { elements: [button(28)] });
    const { check: again } = await createArea(deps, check.id, 'usr_1', {
      kind: 'ignore',
      x: 150,
      y: 0,
      width: 50,
      height: 50,
    });
    expect((again.diff as DiffData).changes).toHaveLength(1);
  });

  test('more than 300 elements, or a malformed one, is refused', async () => {
    const build = await openBuild(deps);
    const many = Array.from({ length: 301 }, (_, i) => ({ ...button(0), key: `#e${i}` }));
    expect((await appError(submit(deps, build, page(20), { elements: many }))).code).toBe('validation_failed');
    const bad = [{ ...button(0), width: 0 }];
    expect((await appError(submit(deps, build, page(20), { elements: bad }))).code).toBe('validation_failed');
  });

  test('unknown element fields from a newer SDK are dropped, not refused', async () => {
    const build = await openBuild(deps);
    const { check } = await submit(deps, build, page(20), { elements: [{ ...button(20), shadow: 'none' }] });
    expect((await checkElements(deps, check.id)).current).toEqual([button(20)]);
  });

  test('a promoted baseline and a baseline whose check retention deleted keep their elements', async () => {
    await baselineWithElements('feature');
    expect(await promoteBranch(deps, 'web', 'feature', 'usr_1')).toEqual({ promoted: 1 });
    // Everything older than the retention period goes; baselines stay, with their elements.
    await deps.db
      .updateTable('builds')
      .set({ createdAt: Date.now() - (project.retentionDays + 1) * DAY_MS })
      .execute();
    await deps.db
      .updateTable('elementSets')
      .set({ createdAt: Date.now() - 2 * IMAGE_GRACE_MS })
      .execute();
    const result = await runRetention(deps);
    expect(result.buildsDeleted).toBe(1);
    expect(result.elementSetsDeleted).toBe(0);

    const { check } = await submit(deps, await openBuild(deps), page(28), { elements: [button(28)] });
    expect(check.baseline?.branch).toBe('main');
    expect((check.diff as DiffData).changes).toHaveLength(1);
  });

  test('retention deletes element sets nothing points at any more', async () => {
    const build = await openBuild(deps);
    const { check } = await submit(deps, build, page(20), { elements: [button(20)] });
    await submit(deps, build, page(20), { elements: [button(21)] }); // replaces the check in place
    await deps.db
      .updateTable('elementSets')
      .set({ createdAt: Date.now() - 2 * IMAGE_GRACE_MS })
      .execute();
    expect((await runRetention(deps)).elementSetsDeleted).toBe(1);
    expect((await checkElements(deps, check.id)).current).toEqual([button(21)]);
    expect((await getCheck(deps, check.id)).elementCount).toBe(1);
  });
});
