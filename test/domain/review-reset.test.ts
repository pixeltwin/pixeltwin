import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Project } from '../../src/db/schema';
import { findCurrentBaseline } from '../../src/domain/baselines';
import { finalizeBuild, getBuild } from '../../src/domain/builds';
import { getCheck } from '../../src/domain/checks';
import { approveCheck, rejectCheck, resetReview } from '../../src/domain/reviews';
import { snapshotKey } from '../../src/domain/snapshot-key';
import { createTestDeps, type TestDeps } from '../helpers/deps';
import { appError } from '../helpers/errors';
import { BLACK, makePng, WHITE } from '../helpers/png';
import { openBuild, seedBaseline, seedProject, submit } from '../helpers/scenario';

const white = makePng(100, 100);
const withSquare = makePng(100, 100, WHITE, [{ x: 10, y: 10, width: 10, height: 10, color: BLACK }]);
const KEY = snapshotKey('home', {});

describe('resetting a review (undo)', () => {
  let deps: TestDeps;
  let project: Project;

  beforeEach(async () => {
    deps = await createTestDeps();
    project = await seedProject(deps);
  });

  afterEach(async () => {
    await deps.handle.close();
  });

  async function changedCheck() {
    const original = await seedBaseline(deps, project, white);
    const buildId = await openBuild(deps);
    const { check } = await submit(deps, buildId, withSquare);
    return { original, buildId, check };
  }

  test('a rejected check goes back to pending and forgets who rejected it', async () => {
    const { check, buildId } = await changedCheck();
    await rejectCheck(deps, check.id, 'usr_1', { comment: 'wrong colour' });
    const reset = await resetReview(deps, check.id, 'usr_1');
    expect(reset).toMatchObject({ review: 'pending', reviewedBy: null, reviewedAt: null, reviewComment: null });
    expect((await getBuild(deps, buildId)).verdict).toBe('pending');
  });

  test('undoing an approval removes the baseline it created, so the previous one is current again', async () => {
    const { original, check } = await changedCheck();
    await approveCheck(deps, check.id, 'usr_1');
    expect((await findCurrentBaseline(deps.db, project.id, KEY, 'main'))?.sourceCheckId).toBe(check.id);

    const reset = await resetReview(deps, check.id, 'usr_1');
    expect(reset).toMatchObject({ review: 'pending', reviewedBy: null });
    expect((await findCurrentBaseline(deps.db, project.id, KEY, 'main'))?.id).toBe(original.id);
    // The check still compares with the baseline it was diffed against.
    expect(reset.baseline?.id).toBe(original.id);
  });

  test('an approval that a newer baseline replaced cannot be undone', async () => {
    const { check } = await changedCheck();
    await approveCheck(deps, check.id, 'usr_1');
    const later = await openBuild(deps);
    const { check: newer } = await submit(deps, later, white);
    await approveCheck(deps, newer.id, 'usr_1');

    const err = await appError(resetReview(deps, check.id, 'usr_1'));
    expect(err).toMatchObject({ status: 409, code: 'review_not_resettable' });
    expect((await getCheck(deps, check.id)).review).toBe('approved');
    expect((await findCurrentBaseline(deps.db, project.id, KEY, 'main'))?.sourceCheckId).toBe(newer.id);
  });

  test('only approved or rejected checks can be reset', async () => {
    const { check } = await changedCheck();
    expect(await appError(resetReview(deps, check.id, 'usr_1'))).toMatchObject({
      status: 409,
      code: 'check_not_reviewable',
    });
    expect(await appError(resetReview(deps, 'chk_missing', 'usr_1'))).toMatchObject({
      status: 404,
      code: 'check_not_found',
    });
  });

  test('works on finalized builds, like approve', async () => {
    const { check, buildId } = await changedCheck();
    await approveCheck(deps, check.id, 'usr_1');
    await finalizeBuild(deps, buildId);
    expect((await resetReview(deps, check.id, 'usr_1')).review).toBe('pending');
  });
});
