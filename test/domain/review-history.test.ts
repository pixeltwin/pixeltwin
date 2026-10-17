import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Migrator } from 'kysely/migration';
import { migrateToLatest } from '../../src/db/database';
import { migrationProvider } from '../../src/db/migrations';
import type { Project } from '../../src/db/schema';
import { createProjectToken } from '../../src/domain/auth/tokens';
import { approveBuild, approveCheck, listReviews, rejectCheck, resetReview } from '../../src/domain/reviews';
import { createTestDeps, type TestDeps } from '../helpers/deps';
import { appError } from '../helpers/errors';
import { BLACK, makePng, WHITE } from '../helpers/png';
import { openBuild, seedBaseline, seedProject, submit } from '../helpers/scenario';

const white = makePng(100, 100);
const withSquare = makePng(100, 100, WHITE, [{ x: 10, y: 10, width: 10, height: 10, color: BLACK }]);

describe('review history', () => {
  let deps: TestDeps;
  let project: Project;

  beforeEach(async () => {
    deps = await createTestDeps();
    project = await seedProject(deps);
  });

  afterEach(async () => {
    await deps.handle.close();
  });

  async function changedCheck(name = 'home') {
    await seedBaseline(deps, project, white, { name });
    const buildId = await openBuild(deps);
    const { check } = await submit(deps, buildId, withSquare, { name });
    return { buildId, check };
  }

  test('every approval, rejection and undo is kept, newest first, with who did it', async () => {
    const { check } = await changedCheck();
    await approveCheck(deps, check.id, 'usr_1', { comment: 'looks right' });
    await resetReview(deps, check.id, 'usr_2');
    await rejectCheck(deps, check.id, 'usr_3', { comment: 'button too wide' });

    const history = await listReviews(deps, check.id);
    expect(history.map(({ action, actor, comment }) => ({ action, actor, comment }))).toEqual([
      { action: 'rejected', actor: 'usr_3', comment: 'button too wide' },
      { action: 'reset', actor: 'usr_2', comment: null },
      { action: 'approved', actor: 'usr_1', comment: 'looks right' },
    ]);
    expect(history[0]?.id).toMatch(/^rev_/);
    expect(history[0]?.checkId).toBe(check.id);
    expect(history[0]?.createdAt).toBeGreaterThanOrEqual(history[2]?.createdAt ?? Infinity);
  });

  test('Approve all records an approval for each check it approved', async () => {
    await seedBaseline(deps, project, white, { name: 'home' });
    await seedBaseline(deps, project, white, { name: 'cart' });
    const buildId = await openBuild(deps);
    const home = (await submit(deps, buildId, withSquare, { name: 'home' })).check;
    const cart = (await submit(deps, buildId, withSquare, { name: 'cart' })).check;
    await approveCheck(deps, cart.id, 'usr_2');

    expect(await approveBuild(deps, buildId, 'usr_1')).toEqual({ approved: 1, suggested: 0 });
    expect((await listReviews(deps, home.id)).map((e) => [e.action, e.actor])).toEqual([['approved', 'usr_1']]);
    expect((await listReviews(deps, cart.id)).map((e) => [e.action, e.actor])).toEqual([['approved', 'usr_2']]);
  });

  test('a review that is refused leaves no trace', async () => {
    const { check } = await changedCheck();
    await approveCheck(deps, check.id, 'usr_1');
    expect((await appError(approveCheck(deps, check.id, 'usr_2'))).code).toBe('check_not_reviewable');
    expect((await appError(rejectCheck(deps, check.id, 'usr_2'))).code).toBe('check_not_reviewable');
    const newer = await openBuild(deps);
    const later = (await submit(deps, newer, white)).check;
    await approveCheck(deps, later.id, 'usr_1');
    expect((await appError(resetReview(deps, check.id, 'usr_2'))).code).toBe('review_not_resettable');
    expect((await listReviews(deps, check.id)).map((e) => e.actor)).toEqual(['usr_1']);
  });

  test('a check that does not exist is a 404', async () => {
    expect((await appError(listReviews(deps, 'chk_missing'))).code).toBe('check_not_found');
  });

  test('the history goes with its build', async () => {
    const { buildId, check } = await changedCheck();
    await approveCheck(deps, check.id, 'usr_1');
    await deps.db.deleteFrom('builds').where('id', '=', buildId).execute();
    expect(await deps.db.selectFrom('reviewEvents').selectAll().execute()).toEqual([]);
  });

  test('the migration turns each existing review into the first entry of its history', async () => {
    const { check } = await changedCheck();
    const pending = (await changedCheck('cart')).check;
    await rejectCheck(deps, check.id, 'usr_1', { comment: 'broken' });
    const reviewedAt = (
      await deps.db.selectFrom('checks').select('reviewedAt').where('id', '=', check.id).executeTakeFirst()
    )?.reviewedAt;

    const migrator = new Migrator({ db: deps.db, provider: migrationProvider });
    expect((await migrator.migrateTo('0003_build_numbers')).error).toBeUndefined();
    expect(await migrateToLatest(deps.db)).toEqual([
      '0004_review_events',
      '0005_snapshot_areas',
      '0006_outdated_checks',
      '0007_stored_objects',
      '0008_parallel_builds',
      '0009_auto_approve_new',
      '0010_timings',
      '0011_integrations',
      '0012_agent_review',
    ]);

    expect(await listReviews(deps, check.id)).toEqual([
      {
        id: `rev_${check.id.slice(4)}`,
        checkId: check.id,
        projectId: project.id,
        action: 'rejected',
        actor: 'usr_1',
        actorKind: 'user',
        actorName: null,
        comment: 'broken',
        createdAt: reviewedAt ?? 0,
      },
    ]);
    expect(await listReviews(deps, pending.id)).toEqual([]);
  });

  test('the agent review migration names who acted in earlier reviews: a token, auto-approve or a user', async () => {
    const { token, view } = await createProjectToken(deps, project.slug, { name: 'claude', scopes: ['review'] });
    expect(token).toBeString();
    const one = (await changedCheck('one')).check;
    const two = (await changedCheck('two')).check;
    const three = (await changedCheck('three')).check;
    await approveCheck(deps, one.id, { kind: 'token', id: view.id, name: 'claude' });
    await approveCheck(deps, two.id, 'auto');
    await approveCheck(deps, three.id, 'usr_1');

    const migrator = new Migrator({ db: deps.db, provider: migrationProvider });
    expect((await migrator.migrateTo('0010_timings')).error).toBeUndefined();
    expect(await migrateToLatest(deps.db)).toEqual(['0011_integrations', '0012_agent_review']);

    const kind = async (id: string) => (await listReviews(deps, id)).map((e) => [e.actorKind, e.actorName]);
    expect(await kind(one.id)).toEqual([['token', 'claude']]);
    expect(await kind(two.id)).toEqual([['auto', null]]);
    expect(await kind(three.id)).toEqual([['user', null]]);
  });
});
