import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Migrator } from 'kysely/migration';
import { migrateToLatest } from '../../src/db/database';
import { migrationProvider } from '../../src/db/migrations';
import type { Project } from '../../src/db/schema';
import { createArea } from '../../src/domain/areas';
import { findCurrentBaseline, promoteBranch } from '../../src/domain/baselines';
import { getBuild } from '../../src/domain/builds';
import { getCheck } from '../../src/domain/checks';
import { approveBuild, approveCheck, rejectCheck, resetReview } from '../../src/domain/reviews';
import { snapshotKey } from '../../src/domain/snapshot-key';
import { createTestDeps, type TestDeps } from '../helpers/deps';
import { appError } from '../helpers/errors';
import { BLACK, makePng, WHITE } from '../helpers/png';
import { openBuild, seedBaseline, seedProject, submit } from '../helpers/scenario';

const white = makePng(100, 100);
const square = (x: number) => makePng(100, 100, WHITE, [{ x, y: 10, width: 10, height: 10, color: BLACK }]);
const HOME = snapshotKey('home', {});

// Builds 2, 3 and 4 of one branch each change the same screen; a reviewer approves #4 first.
describe('checks outdated by a newer approval', () => {
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

  async function changed(png: Uint8Array, options: { branch?: string; name?: string } = {}) {
    const buildId = await openBuild(deps, 'web', { branch: options.branch ?? 'main' });
    const { check } = await submit(deps, buildId, png, { name: options.name ?? 'home' });
    return { buildId, check };
  }

  test('approving a screen in a newer build makes the same screen in older builds outdated', async () => {
    const two = await changed(square(10));
    const three = await changed(square(20));
    const four = await changed(square(30));
    const otherScreen = await changed(square(10), { name: 'cart' });

    await approveCheck(deps, four.check.id, 'usr_1');

    for (const old of [two, three]) {
      expect(await getCheck(deps, old.check.id)).toMatchObject({ review: 'outdated', supersededBy: four.check.id });
      expect((await getBuild(deps, old.buildId)).verdict).toBe('outdated');
    }
    // Another screen, and the newer build itself, are not affected.
    expect((await getCheck(deps, otherScreen.check.id)).review).toBe('pending');
    expect((await getCheck(deps, four.check.id)).review).toBe('approved');
  });

  test('an outdated check can be neither approved nor rejected, so the newer baseline stays', async () => {
    const two = await changed(square(10));
    const four = await changed(square(30));
    await approveCheck(deps, four.check.id, 'usr_1');

    const approve = await appError(approveCheck(deps, two.check.id, 'usr_2'));
    expect(approve).toMatchObject({ status: 409, code: 'check_outdated' });
    expect(approve.message).toContain('#2');
    expect((await appError(rejectCheck(deps, two.check.id, 'usr_2'))).code).toBe('check_outdated');
    expect((await findCurrentBaseline(deps.db, project.id, HOME, 'main'))?.sourceCheckId).toBe(four.check.id);
  });

  test('Approve all on an older build leaves its outdated checks alone', async () => {
    const buildId = await openBuild(deps);
    const old = (await submit(deps, buildId, square(10))).check;
    const cart = (await submit(deps, buildId, square(10), { name: 'cart' })).check;
    const four = await changed(square(30));
    await approveCheck(deps, four.check.id, 'usr_1');

    expect(await approveBuild(deps, buildId, 'usr_2')).toEqual({ approved: 1, suggested: 0 });
    expect((await getCheck(deps, old.id)).review).toBe('outdated');
    expect((await getCheck(deps, cart.id)).review).toBe('approved');
    expect((await findCurrentBaseline(deps.db, project.id, HOME, 'main'))?.sourceCheckId).toBe(four.check.id);
  });

  test('undoing the newer approval brings the older checks back to review', async () => {
    const two = await changed(square(10));
    const four = await changed(square(30));
    await approveCheck(deps, four.check.id, 'usr_1');
    await resetReview(deps, four.check.id, 'usr_1');

    expect(await getCheck(deps, two.check.id)).toMatchObject({ review: 'pending', supersededBy: null });
    expect((await getBuild(deps, two.buildId)).verdict).toBe('pending');
  });

  test('other branches are not affected', async () => {
    const feature = await changed(square(10), { branch: 'feature/x' });
    const four = await changed(square(30));
    await approveCheck(deps, four.check.id, 'usr_1');
    expect((await getCheck(deps, feature.check.id)).review).toBe('pending');
  });

  test('a screen posted late to an older, still open build is outdated at once', async () => {
    const twoId = await openBuild(deps);
    const four = await changed(square(30));
    await approveCheck(deps, four.check.id, 'usr_1');
    const { check } = await submit(deps, twoId, square(10));
    expect(check).toMatchObject({ review: 'outdated', supersededBy: four.check.id });
  });

  test('promoting a newer branch build to main outdates older main builds of that screen', async () => {
    const two = await changed(square(10));
    const feature = await changed(square(30), { branch: 'feature/x' });
    await approveCheck(deps, feature.check.id, 'usr_1');
    await promoteBranch(deps, 'web', 'feature/x', 'usr_1');
    expect(await getCheck(deps, two.check.id)).toMatchObject({ review: 'outdated', supersededBy: feature.check.id });
  });

  test('a promotion also outdates main builds made after the branch build, that still wait for review', async () => {
    const feature = await changed(square(30), { branch: 'feature/x' });
    await approveCheck(deps, feature.check.id, 'usr_1');
    // Merged: main runs with the new screen before anyone promotes.
    const afterMerge = await changed(square(30));
    expect(afterMerge.check.review).toBe('pending');
    await promoteBranch(deps, 'web', 'feature/x', 'usr_1');
    expect(await getCheck(deps, afterMerge.check.id)).toMatchObject({
      review: 'outdated',
      supersededBy: feature.check.id,
    });
    expect((await getBuild(deps, afterMerge.buildId)).verdict).toBe('outdated');
  });

  test('comparing an outdated check again (an area changed) keeps it outdated', async () => {
    const two = await changed(square(10));
    const four = await changed(square(30));
    await approveCheck(deps, four.check.id, 'usr_1');
    const { check } = await createArea(deps, two.check.id, 'usr_1', {
      kind: 'ignore',
      x: 0,
      y: 0,
      width: 5,
      height: 5,
    });
    expect(check.review).toBe('outdated');
  });

  test('the migration marks existing checks that a newer build already decided, and rolls back', async () => {
    const two = await changed(square(10));
    const four = await changed(square(30));
    await approveCheck(deps, four.check.id, 'usr_1');
    const migrator = new Migrator({ db: deps.db, provider: migrationProvider });
    expect((await migrator.migrateTo('0005_snapshot_areas')).error).toBeUndefined();
    const before = await deps.db
      .selectFrom('checks')
      .select('review')
      .where('id', '=', two.check.id)
      .executeTakeFirst();
    expect(before?.review).toBe('pending');

    expect(await migrateToLatest(deps.db)).toEqual([
      '0006_outdated_checks',
      '0007_stored_objects',
      '0008_parallel_builds',
      '0009_auto_approve_new',
      '0010_timings',
      '0011_integrations',
      '0012_agent_review',
      '0013_change_groups',
      '0014_project_members',
      '0015_mail_outbox',
      '0016_reject_reasons',
    ]);
    expect(await getCheck(deps, two.check.id)).toMatchObject({ review: 'outdated', supersededBy: four.check.id });
    // Everything else survived the rebuild, review history included.
    expect(await getCheck(deps, four.check.id)).toMatchObject({ review: 'approved', reviewedBy: 'usr_1' });
    expect(await deps.db.selectFrom('reviewEvents').select('checkId').execute()).toEqual([{ checkId: four.check.id }]);
  });
});
