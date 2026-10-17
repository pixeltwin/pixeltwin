import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Project } from '../../src/db/schema';
import type { DiffData } from '../../src/diff/types';
import { createArea } from '../../src/domain/areas';
import { findCurrentBaseline } from '../../src/domain/baselines';
import { finalizeBuild, getBuild } from '../../src/domain/builds';
import { checkNeighbors, getCheck, listChecks } from '../../src/domain/checks';
import { dayOf } from '../../src/domain/insight-marks';
import { readDays, refreshInsights } from '../../src/domain/insights';
import { updateProject } from '../../src/domain/projects';
import { approveCheck, listReviews, rejectCheck, resetReview, reviewCheck } from '../../src/domain/reviews';
import { createTestDeps, type TestDeps } from '../helpers/deps';
import { appError } from '../helpers/errors';
import { BLACK, makePng, WHITE } from '../helpers/png';
import { openBuild, seedBaseline, seedProject, submit } from '../helpers/scenario';

const white = makePng(100, 100);
/** 100 of 10 000 pixels differ: 1%. */
const square = makePng(100, 100, WHITE, [{ x: 10, y: 10, width: 10, height: 10, color: BLACK }]);
/** Off-white everywhere: below the colour threshold, so no pixel counts as changed. */
const faint = makePng(100, 100, [254, 254, 254, 255]);
/** The same pixels as `white` in other bytes. */
const reencoded = makePng(100, 100, WHITE, [], { deflateLevel: 1 });

describe('checks within the tolerance', () => {
  let deps: TestDeps;
  let project: Project;

  beforeEach(async () => {
    deps = await createTestDeps();
    project = await updateProject(deps, (await seedProject(deps)).slug, { tolerancePercent: 2 });
    await seedBaseline(deps, project, white);
  });

  afterEach(async () => {
    await deps.handle.close();
  });

  test('a diff within the tolerance passes, flagged, with its diff image and regions kept', async () => {
    const buildId = await openBuild(deps);
    const { check } = await submit(deps, buildId, square);
    expect(check).toMatchObject({ result: 'unchanged', review: 'none', withinTolerance: true, tolerancePercent: 2 });
    const diff = check.diff as DiffData;
    expect(diff.percent).toBe(1);
    expect(diff.regions).toHaveLength(1);
    expect(diff.summary).toContain('Within tolerance of 2%.');
    expect(check.diffImageSha).toMatch(/^[0-9a-f]{64}$/);
    const build = await getBuild(deps, buildId);
    expect(build.verdict).toBe('passed');
    expect(build.counts).toMatchObject({ withinTolerance: 1, withinTolerancePassed: 1 });
  });

  test('identical screenshots, the same pixels in other bytes and changes under the colour threshold are not flagged', async () => {
    const buildId = await openBuild(deps);
    for (const [name, png] of [
      ['home', white],
      ['home', reencoded],
      ['home', faint],
    ] as const) {
      const { check } = await submit(deps, buildId, png, { name });
      expect({ result: check.result, withinTolerance: check.withinTolerance, diff: check.diffImageSha }).toEqual({
        result: 'unchanged',
        withinTolerance: false,
        diff: null,
      });
    }
    expect((await getBuild(deps, buildId)).counts.withinTolerance).toBe(0);
  });

  test('a diff over the tolerance is changed, not flagged', async () => {
    await updateProject(deps, project.slug, { tolerancePercent: 0.5 });
    const { check } = await submit(deps, await openBuild(deps), square);
    expect(check).toMatchObject({ result: 'changed', review: 'pending', withinTolerance: false });
  });

  test('approving makes its screenshot the baseline, recorded in the history; undo passes it again', async () => {
    const buildId = await openBuild(deps);
    const { check } = await submit(deps, buildId, square);
    const approved = await approveCheck(deps, check.id, 'usr_1', { reason: 'Drift: take the new one' });
    expect(approved).toMatchObject({ review: 'approved', reviewedBy: 'usr_1', withinTolerance: true });
    expect((await findCurrentBaseline(deps.db, project.id, check.snapshotKey, 'main'))?.sourceCheckId).toBe(check.id);
    expect((await listReviews(deps, check.id)).map((e) => [e.action, e.comment])).toEqual([
      ['approved', 'Drift: take the new one'],
    ]);
    const build = await getBuild(deps, buildId);
    expect(build.verdict).toBe('passed');
    expect(build.counts).toMatchObject({ withinTolerance: 1, withinTolerancePassed: 0 });

    const undone = await resetReview(deps, check.id, 'usr_1');
    expect(undone).toMatchObject({ review: 'none', reviewedBy: null });
    expect((await findCurrentBaseline(deps.db, project.id, check.snapshotKey, 'main'))?.sourceCheckId).toBeNull();
  });

  test('rejecting flags it as a real change: the build is rejected until undone', async () => {
    const buildId = await openBuild(deps);
    const { check } = await submit(deps, buildId, square);
    const rejected = await rejectCheck(deps, check.id, 'usr_1', { reasonCode: 'real_bug', reason: 'The icon moved' });
    expect(rejected).toMatchObject({ review: 'rejected', reviewReasonCode: 'real_bug' });
    expect((await getBuild(deps, buildId)).verdict).toBe('rejected');
    // A rejected one can still be approved, as any other.
    expect((await approveCheck(deps, check.id, 'usr_1')).review).toBe('approved');
    await resetReview(deps, check.id, 'usr_1');
    expect((await getCheck(deps, check.id)).review).toBe('none');
    expect((await getBuild(deps, buildId)).verdict).toBe('passed');
  });

  test('an identical check still cannot be reviewed', async () => {
    const { check } = await submit(deps, await openBuild(deps), white);
    const err = await appError(approveCheck(deps, check.id, 'usr_1'));
    expect(err).toMatchObject({ status: 409, code: 'check_not_reviewable' });
    expect((await appError(rejectCheck(deps, check.id, 'usr_1'))).code).toBe('check_not_reviewable');
  });

  test("the project's setting makes such checks wait for review; undo makes them wait again", async () => {
    await updateProject(deps, project.slug, { reviewWithinTolerance: true });
    const buildId = await openBuild(deps);
    const { check } = await submit(deps, buildId, square);
    expect(check).toMatchObject({ result: 'unchanged', review: 'pending', withinTolerance: true });
    const pending = await getBuild(deps, buildId);
    expect(pending.verdict).toBe('pending');
    expect(pending.counts).toMatchObject({ withinTolerance: 1, withinTolerancePassed: 0 });
    await approveCheck(deps, check.id, 'usr_1');
    expect((await getBuild(deps, buildId)).verdict).toBe('passed');
    expect((await resetReview(deps, check.id, 'usr_1')).review).toBe('pending');
    // Identical screenshots still pass by themselves.
    await seedBaseline(deps, project, white, { name: 'about' });
    expect((await submit(deps, buildId, white, { name: 'about' })).check.review).toBe('none');
  });

  test('the SDK overrides the setting per check, both ways', async () => {
    const buildId = await openBuild(deps);
    const strict = await submit(deps, buildId, square, { reviewWithinTolerance: true });
    expect(strict.check.review).toBe('pending');
    await approveCheck(deps, strict.check.id, 'usr_1');
    expect((await resetReview(deps, strict.check.id, 'usr_1')).review).toBe('pending');

    await updateProject(deps, project.slug, { reviewWithinTolerance: true });
    await seedBaseline(deps, project, white, { name: 'about' });
    const lax = await submit(deps, buildId, square, { name: 'about', reviewWithinTolerance: false });
    expect(lax.check).toMatchObject({ review: 'none', withinTolerance: true });
  });

  test('filters: Within tolerance lists them whatever their review; Passed leaves out reviewed ones', async () => {
    for (const name of ['about', 'pricing']) await seedBaseline(deps, project, white, { name });
    const buildId = await openBuild(deps);
    const home = (await submit(deps, buildId, square)).check;
    const about = (await submit(deps, buildId, square, { name: 'about' })).check;
    const pricing = (await submit(deps, buildId, white, { name: 'pricing' })).check;
    await rejectCheck(deps, about.id, 'usr_1');
    const ids = async (status: 'tolerance' | 'passed') =>
      (await listChecks(deps, buildId, { status })).items.map((c) => c.id).sort();
    expect(await ids('tolerance')).toEqual([home.id, about.id].sort());
    expect(await ids('passed')).toEqual([home.id, pricing.id].sort());
    const counts = (await getBuild(deps, buildId)).counts;
    expect(counts).toMatchObject({ withinTolerance: 2, withinTolerancePassed: 1 });
    expect(counts.result.unchanged).toBe(3);
  });

  test('walking the Within tolerance filter goes to the next one not yet decided', async () => {
    for (const name of ['a', 'b', 'c']) await seedBaseline(deps, project, white, { name });
    const buildId = await openBuild(deps);
    const a = (await submit(deps, buildId, square, { name: 'a' })).check;
    const b = (await submit(deps, buildId, white, { name: 'b' })).check;
    const c = (await submit(deps, buildId, square, { name: 'c' })).check;
    // Newest first: from c the next older one within the tolerance is a, skipping the identical b.
    expect((await checkNeighbors(deps, c, { withinTolerance: true })).nextPending).toBe(a.id);
    await approveCheck(deps, a.id, 'usr_1');
    expect((await checkNeighbors(deps, c, { withinTolerance: true })).nextPending).toBeNull();
    expect((await checkNeighbors(deps, b)).nextPending).toBeNull();
  });

  test('an ignore area over the change makes it identical in effect: no longer flagged', async () => {
    const buildId = await openBuild(deps);
    const { check } = await submit(deps, buildId, square);
    const { check: recomputed } = await createArea(deps, check.id, 'usr_1', {
      kind: 'ignore',
      x: 5,
      y: 5,
      width: 20,
      height: 20,
    });
    expect(recomputed).toMatchObject({ result: 'unchanged', withinTolerance: false, diffImageSha: null });
  });

  test("an agent's approval under auto-below is measured by the diff, as for a changed check", async () => {
    await updateProject(deps, project.slug, { agentReview: 'auto-below', agentMaxDiffPercent: 0.5 });
    const { check } = await submit(deps, await openBuild(deps), square);
    const agent = { kind: 'token' as const, id: 'tok_1', name: 'claude' };
    const { outcome, check: after } = await reviewCheck(deps, check.id, 'approve', agent, { reason: 'drift' });
    expect(outcome).toBe('suggested');
    expect(after).toMatchObject({ review: 'none', suggestion: { action: 'approve' } });
  });

  test('insights count them as auto-passed, within the tolerance, unless a person reviewed them', async () => {
    for (const name of ['about', 'pricing']) await seedBaseline(deps, project, white, { name });
    const buildId = await openBuild(deps);
    await submit(deps, buildId, square);
    await submit(deps, buildId, white, { name: 'pricing' });
    const about = (await submit(deps, buildId, square, { name: 'about' })).check;
    await finalizeBuild(deps, buildId);
    await approveCheck(deps, about.id, 'usr_1');
    await refreshInsights(deps);
    const [day] = await readDays(deps, project.id, 'main', dayOf(Date.now()) - 1, dayOf(Date.now()));
    expect(day?.totals).toMatchObject({ checks: 3, autoPassed: 2, withinTolerance: 1, neededReview: 1, approved: 1 });
  });
});
