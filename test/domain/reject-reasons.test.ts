import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Project } from '../../src/db/schema';
import { getCheck } from '../../src/domain/checks';
import { screenHistory } from '../../src/domain/flaky';
import { updateProject } from '../../src/domain/projects';
import { buildRejectionPatterns, hintOf, rejectionPatterns } from '../../src/domain/rejections';
import {
  approveCheck,
  listReviews,
  type ReviewActor,
  rejectCheck,
  resetReview,
  reviewCheck,
} from '../../src/domain/reviews';
import { snapshotKey } from '../../src/domain/snapshot-key';
import { createTestDeps, type TestDeps } from '../helpers/deps';
import { appError } from '../helpers/errors';
import { BLACK, makePng, WHITE } from '../helpers/png';
import { openBuild, seedBaseline, seedProject, submit } from '../helpers/scenario';

const base = makePng(60, 40);
const banner = (x: number) => makePng(60, 40, WHITE, [{ x, y: 4, width: 10, height: 10, color: BLACK }]);
const agent: ReviewActor = { kind: 'token', id: 'tok_agent', name: 'claude' };

describe('reject reasons', () => {
  let deps: TestDeps;
  let project: Project;

  beforeEach(async () => {
    deps = await createTestDeps();
    project = await seedProject(deps);
    for (const name of ['home', 'cart']) await seedBaseline(deps, project, base, { name });
  });

  afterEach(async () => {
    await deps.handle.close();
  });

  /** A build on `branch` with a changed check of each name. */
  async function changed(names: string[], branch = 'main', x = 4) {
    const buildId = await openBuild(deps, 'web', { branch });
    const ids: Record<string, string> = {};
    for (const name of names) ids[name] = (await submit(deps, buildId, banner(x), { name })).check.id;
    return { buildId, ids };
  }

  test('a rejection keeps its category on the check and in the history; undo and approve clear the check', async () => {
    const { ids } = await changed(['home']);
    const id = ids.home as string;
    const rejected = await rejectCheck(deps, id, 'usr_1', { reasonCode: 'not_loaded', reason: 'Spinner still there' });
    expect(rejected).toMatchObject({
      review: 'rejected',
      reviewComment: 'Spinner still there',
      reviewReasonCode: 'not_loaded',
    });
    expect((await listReviews(deps, id))[0]).toMatchObject({
      action: 'rejected',
      reasonCode: 'not_loaded',
      comment: 'Spinner still there',
    });
    expect((await resetReview(deps, id, 'usr_1')).reviewReasonCode).toBeNull();
    await rejectCheck(deps, id, 'usr_1', { reasonCode: 'animation' });
    expect((await approveCheck(deps, id, 'usr_1')).reviewReasonCode).toBeNull();
    // The history keeps every category it was given.
    expect((await listReviews(deps, id)).map((e) => [e.action, e.reasonCode])).toEqual([
      ['approved', null],
      ['rejected', 'animation'],
      ['reset', null],
      ['rejected', 'not_loaded'],
    ]);
  });

  test('codes are checked; a category goes with a rejection only; none is still fine', async () => {
    const { ids } = await changed(['home', 'cart']);
    const invalid = await appError(rejectCheck(deps, ids.home as string, 'usr_1', { reasonCode: 'slow' }));
    expect(invalid).toMatchObject({ status: 422, code: 'validation_failed' });
    const onApprove = await appError(approveCheck(deps, ids.home as string, 'usr_1', { reasonCode: 'not_loaded' }));
    expect(onApprove.errors?.[0]?.path).toBe('reasonCode');
    // Shift+R: a rejection without a reason.
    expect((await rejectCheck(deps, ids.cart as string, 'usr_1')).reviewReasonCode).toBeNull();
  });

  test('under an agent review policy a token must give a category to reject', async () => {
    await updateProject(deps, 'web', { agentReview: 'auto-below' });
    const { ids } = await changed(['home']);
    const err = await appError(reviewCheck(deps, ids.home as string, 'reject', agent, { reason: 'Banner missing' }));
    expect(err.code).toBe('reason_code_required');
    const { check } = await reviewCheck(deps, ids.home as string, 'reject', agent, {
      reason: 'Banner missing',
      reasonCode: 'late_asset',
    });
    expect(check.reviewReasonCode).toBe('late_asset');
  });

  test('patterns: by category and by screen, newest first, without undone rejections', async () => {
    for (let i = 0; i < 3; i++) {
      const { ids } = await changed(['home', 'cart'], 'main', 4 + i);
      await rejectCheck(deps, ids.home as string, 'usr_1', { reasonCode: 'not_loaded', reason: `run ${i}` });
      if (i === 0) await rejectCheck(deps, ids.cart as string, agent, { reasonCode: 'dynamic_data' });
    }
    // A slip: rejected and undone at once.
    const slip = await changed(['cart'], 'main', 20);
    await rejectCheck(deps, slip.ids.cart as string, 'usr_1', { reasonCode: 'real_bug' });
    await resetReview(deps, slip.ids.cart as string, 'usr_1');
    // Another branch, without a category.
    const feature = await changed(['home'], 'feature/x', 30);
    await rejectCheck(deps, feature.ids.home as string, 'usr_1');

    const all = await rejectionPatterns(deps, project.id);
    expect(all.total).toBe(5);
    expect(all.categories.map((c) => [c.code, c.count, c.screens])).toEqual([
      ['not_loaded', 3, 1],
      ['uncategorized', 1, 1],
      ['dynamic_data', 1, 1],
    ]);
    const [home, cart] = all.screens;
    expect(home).toMatchObject({
      snapshotKey: snapshotKey('home', {}),
      name: 'home',
      count: 4,
      byCategory: { not_loaded: 3, uncategorized: 1 },
      top: 'not_loaded',
      tooEarly: 3,
    });
    expect(home?.hint).toBe(
      'Rejected 3× as not_loaded: likely captured before the page finished loading — wait for network idle or for the element before the screenshot.',
    );
    expect(home?.recent.map((r) => [r.branch, r.reasonCode, r.reason])).toEqual([
      ['feature/x', null, null],
      ['main', 'not_loaded', 'run 2'],
      ['main', 'not_loaded', 'run 1'],
      ['main', 'not_loaded', 'run 0'],
    ]);
    expect(cart).toMatchObject({ count: 1, top: 'dynamic_data', tooEarly: 0 });
    expect(cart?.recent[0]?.by).toEqual({ kind: 'token', id: 'tok_agent', name: 'claude' });

    const onMain = await rejectionPatterns(deps, project.id, {
      branch: 'main',
      snapshotKeys: [snapshotKey('home', {})],
    });
    expect(onMain.total).toBe(3);
    expect(onMain.screens.map((s) => s.name)).toEqual(['home']);
    // The limit counts the newest rejections looked at, the undone slip among them.
    expect((await rejectionPatterns(deps, project.id, { limit: 2 })).total).toBe(1);

    // A build's screens, on every branch, each with its check in the build.
    const latest = await changed(['home'], 'feature/y', 40);
    const forBuild = await buildRejectionPatterns(deps, latest.buildId);
    expect(forBuild.screens).toEqual([expect.objectContaining({ name: 'home', count: 4, checkId: latest.ids.home })]);
  });

  test('the hint names the top category, the others, or asks to read the comments', () => {
    expect(hintOf({ animation: 2, dynamic_data: 1, uncategorized: 1 }, 'animation')).toBe(
      'Rejected 2× as animation (also 1× dynamic_data): caught mid-animation — disable animations and transitions for the screenshot, or use retakes.',
    );
    expect(hintOf({ uncategorized: 2 }, null)).toBe('Rejected 2× without a category; read the comments.');
  });

  test("a screen's noise rejections are told with its history; the flaky score stays the screenshots'", async () => {
    const one = await changed(['home'], 'main', 4);
    await rejectCheck(deps, one.ids.home as string, 'usr_1', { reasonCode: 'animation' });
    const two = await changed(['home'], 'main', 8);
    await rejectCheck(deps, two.ids.home as string, 'usr_1', { reasonCode: 'real_bug' });
    const three = await changed(['home'], 'main', 12);
    await rejectCheck(deps, three.ids.home as string, 'usr_1', { reasonCode: 'late_asset' });
    const screen = await screenHistory(deps, {
      projectId: project.id,
      snapshotKey: snapshotKey('home', {}),
      branch: 'main',
    });
    expect(screen?.noiseRejections).toEqual({ count: 2, byCategory: { animation: 1, late_asset: 1 } });
    expect(screen?.flaky).toBeNull();
    expect((await getCheck(deps, three.ids.home as string)).reviewReasonCode).toBe('late_asset');
  });
});
