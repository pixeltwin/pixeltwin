import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Project } from '../../src/db/schema';
import { findCurrentBaseline } from '../../src/domain/baselines';
import { finalizeBuild, getBuild } from '../../src/domain/builds';
import { approveBuild, approveCheck, rejectCheck } from '../../src/domain/reviews';
import { snapshotKey } from '../../src/domain/snapshot-key';
import { createTestDeps, type TestDeps } from '../helpers/deps';
import { appError } from '../helpers/errors';
import { BLACK, makePng, WHITE } from '../helpers/png';
import { openBuild, seedBaseline, seedProject, submit } from '../helpers/scenario';

const white = makePng(100, 100);
const withSquare = makePng(100, 100, WHITE, [{ x: 10, y: 10, width: 10, height: 10, color: BLACK }]);
const KEY = snapshotKey('home', {});

describe('reviews', () => {
  let deps: TestDeps;
  let project: Project;

  beforeEach(async () => {
    deps = await createTestDeps();
    project = await seedProject(deps);
  });

  afterEach(async () => {
    await deps.handle.close();
  });

  test('approving makes the image the baseline for the next build', async () => {
    const first = await openBuild(deps);
    const { check } = await submit(deps, first, white);
    const approved = await approveCheck(deps, check.id, 'usr_1', { comment: 'looks right' });
    expect(approved).toMatchObject({ review: 'approved', reviewedBy: 'usr_1', reviewComment: 'looks right' });
    expect((await getBuild(deps, first)).verdict).toBe('passed');

    const second = await openBuild(deps);
    expect((await submit(deps, second, white)).check.result).toBe('unchanged');
  });

  test('approving on a feature branch leaves main untouched', async () => {
    const mainBaseline = await seedBaseline(deps, project, white);
    const buildId = await openBuild(deps, 'web', { branch: 'feature/x' });
    const { check } = await submit(deps, buildId, withSquare);
    await approveCheck(deps, check.id, 'usr_1');
    expect((await findCurrentBaseline(deps.db, project.id, KEY, 'main'))?.id).toBe(mainBaseline.id);
    expect((await findCurrentBaseline(deps.db, project.id, KEY, 'feature/x'))?.imageSha).toBe(check.imageSha);
  });

  test('reject, then change your mind and approve', async () => {
    await seedBaseline(deps, project, white);
    const buildId = await openBuild(deps);
    const { check } = await submit(deps, buildId, withSquare);
    expect((await rejectCheck(deps, check.id, 'usr_1', { comment: 'broken' })).review).toBe('rejected');
    expect((await getBuild(deps, buildId)).verdict).toBe('rejected');
    expect((await approveCheck(deps, check.id, 'usr_2')).review).toBe('approved');
    expect((await getBuild(deps, buildId)).verdict).toBe('passed');
  });

  test('only reviewable checks can be approved or rejected', async () => {
    await seedBaseline(deps, project, white);
    const buildId = await openBuild(deps);
    const unchanged = (await submit(deps, buildId, white)).check;
    const notReviewable = await appError(approveCheck(deps, unchanged.id, 'usr_1'));
    expect(notReviewable.code).toBe('check_not_reviewable');
    expect(notReviewable.status).toBe(409);

    const changed = (await submit(deps, buildId, withSquare, { name: 'other' })).check;
    await approveCheck(deps, changed.id, 'usr_1');
    expect((await appError(rejectCheck(deps, changed.id, 'usr_1'))).code).toBe('check_not_reviewable');
    expect((await appError(approveCheck(deps, 'chk_missing', 'usr_1'))).code).toBe('check_not_found');
  });

  test('concurrent approvals create one baseline', async () => {
    const buildId = await openBuild(deps);
    const { check } = await submit(deps, buildId, white);
    const results = await Promise.allSettled([
      approveCheck(deps, check.id, 'usr_1'),
      approveCheck(deps, check.id, 'usr_2'),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const baselines = await deps.db.selectFrom('baselines').selectAll().where('snapshotKey', '=', KEY).execute();
    expect(baselines).toHaveLength(1);
  });

  test('approve all approves only pending checks, also after finalize', async () => {
    await seedBaseline(deps, project, white);
    const buildId = await openBuild(deps);
    await submit(deps, buildId, white);
    await submit(deps, buildId, withSquare, { name: 'a' });
    await submit(deps, buildId, withSquare, { name: 'b' });
    await finalizeBuild(deps, buildId);
    expect(await approveBuild(deps, buildId, 'usr_1')).toEqual({ approved: 2 });
    const build = await getBuild(deps, buildId);
    expect(build.verdict).toBe('passed');
    expect(build.counts.review).toMatchObject({ approved: 2, none: 1, pending: 0 });
    expect(await approveBuild(deps, buildId, 'usr_1')).toEqual({ approved: 0 });
  });
});
