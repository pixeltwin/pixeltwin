import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Project } from '../../src/db/schema';
import { findCurrentBaseline } from '../../src/domain/baselines';
import { finalizeBuild, getBuild } from '../../src/domain/builds';
import { approveBuild, approveCheck, rejectCheck } from '../../src/domain/reviews';
import { snapshotKey } from '../../src/domain/snapshot-key';
import type { AppError } from '../../src/errors';
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
    expect(await approveBuild(deps, buildId, 'usr_1')).toEqual({ approved: 2, suggested: 0 });
    const build = await getBuild(deps, buildId);
    expect(build.verdict).toBe('passed');
    expect(build.counts.review).toMatchObject({ approved: 2, none: 1, pending: 0 });
    expect(await approveBuild(deps, buildId, 'usr_1')).toEqual({ approved: 0, suggested: 0 });
  });

  test('concurrent approve-all calls approve each pending check once', async () => {
    const buildId = await openBuild(deps);
    for (let i = 0; i < 10; i++) await submit(deps, buildId, white, { name: `s${i}` });
    const results = await Promise.allSettled([1, 2, 3, 4].map(() => approveBuild(deps, buildId, 'usr_1')));
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled', 'fulfilled', 'fulfilled']);
    const approved = results.reduce((n, r) => n + (r.status === 'fulfilled' ? r.value.approved : 0), 0);
    expect(approved).toBe(10);
    expect(await deps.db.selectFrom('baselines').selectAll().execute()).toHaveLength(10);
  });

  test('approve-all racing a single approval still approves everything once', async () => {
    const buildId = await openBuild(deps);
    const checks = [];
    for (let i = 0; i < 5; i++) checks.push((await submit(deps, buildId, white, { name: `s${i}` })).check);
    const [all, one] = await Promise.allSettled([
      approveBuild(deps, buildId, 'usr_1'),
      approveCheck(deps, checks[2]?.id ?? '', 'usr_2'),
    ]);
    // Approve-all never fails because of the single approval. The single approval either wins
    // or finds the check already approved (409), which is the documented behaviour.
    expect(all?.status).toBe('fulfilled');
    if (one?.status === 'rejected') expect((one.reason as AppError).code).toBe('check_not_reviewable');
    const approvedByAll = all?.status === 'fulfilled' ? all.value.approved : 0;
    expect(approvedByAll + (one?.status === 'fulfilled' ? 1 : 0)).toBe(5);
    expect(await deps.db.selectFrom('baselines').selectAll().execute()).toHaveLength(5);
    expect((await getBuild(deps, buildId)).verdict).toBe('passed');
  });
});
