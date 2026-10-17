import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Project } from '../../src/db/schema';
import type { Region } from '../../src/diff/types';
import { createArea } from '../../src/domain/areas';
import { removeBuilds } from '../../src/domain/builds';
import { covered, flakySignal, type HistoryEntry, noisyScreens, screenHistory } from '../../src/domain/flaky';
import { approveCheck, rejectCheck } from '../../src/domain/reviews';
import { snapshotKey } from '../../src/domain/snapshot-key';
import { createTestDeps, type TestDeps } from '../helpers/deps';
import { BLACK, makePng, WHITE } from '../helpers/png';
import { openBuild, seedBaseline, seedProject, submit } from '../helpers/scenario';

const clock: Region = { x: 150, y: 4, width: 30, height: 12, pixels: 200 };

let n = 0;
/** A history entry: `sha` names the screenshot, `result` what the comparison said. */
function entry(
  sha: string,
  result: HistoryEntry['result'],
  review: HistoryEntry['review'] = 'none',
  regions: Region[] = [],
) {
  n += 1;
  return {
    checkId: `chk_${n}`,
    buildId: `bld_${n}`,
    buildNumber: n,
    imageSha: sha,
    result,
    review,
    reviewedBy: null,
    regions: result === 'changed' ? (regions.length > 0 ? regions : [clock]) : [],
    createdAt: n * 1000,
  } satisfies HistoryEntry;
}

describe('flaky signal', () => {
  test('a screen that goes back and forth between two screenshots is flaky', () => {
    const history = [
      entry('A', 'unchanged'),
      entry('B', 'changed', 'rejected'),
      entry('A', 'unchanged'),
      entry('B', 'changed', 'pending'),
      entry('A', 'unchanged'),
    ];
    const signal = flakySignal(history);
    expect(signal).toEqual({
      score: 0.75,
      flips: 3,
      checks: 5,
      lastSeen: history[4]?.createdAt as number,
      unstableArea: { x: 150, y: 4, width: 30, height: 12 },
    });
  });

  test('changes that are approved and kept are not flips; one revert is not enough', () => {
    expect(
      flakySignal([
        entry('A', 'unchanged'),
        entry('B', 'changed', 'approved'),
        entry('B', 'unchanged'),
        entry('C', 'changed', 'approved'),
        entry('C', 'unchanged'),
      ]),
    ).toBeNull();
    // A change, approved, then reverted and approved again: one flip.
    expect(
      flakySignal([
        entry('A', 'unchanged'),
        entry('B', 'changed', 'approved'),
        entry('A', 'changed', 'approved'),
        entry('A', 'unchanged'),
      ]),
    ).toBeNull();
  });

  test('a rejected change that goes away by itself counts, also with a new screenshot each time', () => {
    const signal = flakySignal([
      entry('A', 'unchanged'),
      entry('B', 'changed', 'rejected'),
      entry('C', 'unchanged'),
      entry('D', 'changed', 'pending'),
      entry('E', 'unchanged'),
    ]);
    expect(signal?.flips).toBe(2);
  });

  test('screenshots that differ only where nothing is compared are no flips', () => {
    // The clock is ignored already: every check is unchanged, though each screenshot differs.
    expect(flakySignal([entry('A', 'unchanged'), entry('B', 'unchanged'), entry('A', 'unchanged')])).toBeNull();
  });

  test('the unstable area is where changes recur; a one-off change elsewhere is left out', () => {
    const banner: Region = { x: 0, y: 100, width: 200, height: 40, pixels: 8000 };
    const shifted: Region = { x: 140, y: 2, width: 36, height: 14, pixels: 300 };
    const signal = flakySignal([
      entry('A', 'unchanged'),
      entry('B', 'changed', 'rejected', [clock, banner]),
      entry('A', 'unchanged'),
      entry('C', 'changed', 'rejected', [shifted]),
      entry('A', 'unchanged'),
    ]);
    expect(signal?.unstableArea).toEqual({ x: 140, y: 2, width: 40, height: 14 });
  });

  test('an ignore area over the unstable area means the screen is taken care of', () => {
    const history = [entry('A', 'unchanged'), entry('B', 'changed'), entry('A', 'unchanged'), entry('B', 'changed')];
    expect(flakySignal(history)).not.toBeNull();
    expect(flakySignal(history, [{ x: 146, y: 0, width: 38, height: 20 }])).toBeNull();
    expect(flakySignal(history, [{ x: 150, y: 0, width: 10, height: 20 }])).not.toBeNull();
    expect(
      covered({ x: 0, y: 0, width: 10, height: 10 }, [
        { x: 0, y: 0, width: 5, height: 10 },
        { x: 5, y: 0, width: 5, height: 10 },
      ]),
    ).toBe(true);
  });
});

describe('screen history', () => {
  let deps: TestDeps;
  let project: Project;
  const plain = makePng(200, 100);
  const withAd = (x: number) => makePng(200, 100, WHITE, [{ x, y: 60, width: 30, height: 20, color: BLACK }]);
  const HOME = snapshotKey('home', {});

  beforeEach(async () => {
    deps = await createTestDeps();
    project = await seedProject(deps);
    await seedBaseline(deps, project, plain);
  });

  afterEach(async () => {
    await deps.handle.close();
  });

  /** Posts home to a new build of `branch`; a changed check is rejected unless told otherwise. */
  async function run(png: Uint8Array, branch = 'main', approve = false) {
    const buildId = await openBuild(deps, 'web', { branch });
    const { check } = await submit(deps, buildId, png);
    if (check.result === 'changed') await (approve ? approveCheck : rejectCheck)(deps, check.id, 'usr_1');
    return { buildId, check };
  }

  test('an ad that comes and goes makes the screen flaky on its branch, newest last', async () => {
    const runs = [];
    for (const png of [plain, withAd(10), plain, withAd(120), plain, withAd(10), plain]) runs.push(await run(png));
    // Another branch with its own, steady change is not flaky and does not mix in.
    await seedBaseline(deps, project, plain, { branch: 'feature' });
    for (let i = 0; i < 3; i++) await run(withAd(60), 'feature', i === 0);

    const main = await screenHistory(deps, { projectId: project.id, snapshotKey: HOME, branch: 'main' });
    expect(main?.history.map((h) => h.checkId)).toEqual(runs.map((r) => r.check.id));
    // The ad comes back at 10 twice (and goes away three times); at 120 it was seen once.
    expect(main?.flaky).toMatchObject({ flips: 4, checks: 7, score: 0.67 });
    expect(main?.flaky?.unstableArea).toEqual({ x: 10, y: 60, width: 30, height: 20 });
    const feature = await screenHistory(deps, { projectId: project.id, snapshotKey: HOME, branch: 'feature' });
    expect(feature?.history).toHaveLength(3);
    expect(feature?.flaky).toBeNull();

    const noisy = await noisyScreens(deps, project.id);
    expect(noisy.map((s) => [s.name, s.branch])).toEqual([['home', 'main']]);

    // Ignoring the area that keeps changing takes care of it.
    const area = main?.flaky?.unstableArea;
    if (!area) throw new Error('no unstable area');
    await createArea(deps, runs[6]?.check.id as string, 'usr_1', { kind: 'ignore', ...area });
    expect(await noisyScreens(deps, project.id)).toEqual([]);
  });

  test('only the last 20 checks count, and deleted builds drop out of the history', async () => {
    const runs = [];
    for (let i = 0; i < 6; i++) runs.push(await run(i % 2 ? withAd(10) : plain));
    for (let i = 0; i < 20; i++) runs.push(await run(plain));
    const steady = await screenHistory(deps, { projectId: project.id, snapshotKey: HOME, branch: 'main' });
    expect(steady?.history).toHaveLength(20);
    expect(steady?.flaky).toBeNull();

    await removeBuilds(
      deps.db,
      runs.slice(6).map((r) => r.buildId),
    );
    const left = await screenHistory(deps, { projectId: project.id, snapshotKey: HOME, branch: 'main' });
    expect(left?.history).toHaveLength(6);
    expect(left?.flaky?.flips).toBe(4);
  });
});
