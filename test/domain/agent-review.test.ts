import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Project } from '../../src/db/schema';
import { createArea } from '../../src/domain/areas';
import { getBuild } from '../../src/domain/builds';
import { getCheck } from '../../src/domain/checks';
import { updateProject } from '../../src/domain/projects';
import {
  acceptSuggestion,
  approveBuild,
  approveCheck,
  dismissSuggestion,
  listReviews,
  type ReviewActor,
  reviewCheck,
} from '../../src/domain/reviews';
import { createTestDeps, type TestDeps } from '../helpers/deps';
import { appError } from '../helpers/errors';
import { BLACK, makePng, WHITE } from '../helpers/png';
import { openBuild, seedBaseline, seedProject, submit } from '../helpers/scenario';

const white = makePng(100, 100);
/** 1 % of the pixels changed. */
const small = makePng(100, 100, WHITE, [{ x: 10, y: 10, width: 10, height: 10, color: BLACK }]);
/** 9 % of the pixels changed. */
const large = makePng(100, 100, WHITE, [{ x: 10, y: 10, width: 30, height: 30, color: BLACK }]);
const agent: ReviewActor = { kind: 'token', id: 'tok_agent', name: 'claude' };

describe('agent review policy', () => {
  let deps: TestDeps;
  let project: Project;

  beforeEach(async () => {
    deps = await createTestDeps();
    project = await seedProject(deps);
  });

  afterEach(async () => {
    await deps.handle.close();
  });

  async function changed(png = small, name = 'home') {
    await seedBaseline(deps, project, white, { name });
    const buildId = await openBuild(deps);
    const { check } = await submit(deps, buildId, png, { name });
    return { buildId, check };
  }

  const policy = (agentReview: Project['agentReview'], agentMaxDiffPercent?: number) =>
    updateProject(deps, 'web', { agentReview, ...(agentMaxDiffPercent === undefined ? {} : { agentMaxDiffPercent }) });

  test('off (the default): a token reviews as a person does; the history names the token', async () => {
    expect(project.agentReview).toBe('off');
    const { check } = await changed();
    const { check: reviewed, outcome } = await reviewCheck(deps, check.id, 'approve', agent, {
      reason: 'Padding change I made on purpose',
    });
    expect(outcome).toBe('applied');
    expect(reviewed.review).toBe('approved');
    expect(reviewed.reviewComment).toBe('Padding change I made on purpose');
    const [event] = await listReviews(deps, check.id);
    expect(event).toMatchObject({
      action: 'approved',
      actor: 'tok_agent',
      actorKind: 'token',
      actorName: 'claude',
      comment: 'Padding change I made on purpose',
    });
  });

  test('off: a reason is optional, and `comment` still works', async () => {
    const one = (await changed(small, 'one')).check;
    const two = (await changed(small, 'two')).check;
    expect((await reviewCheck(deps, one.id, 'reject', agent)).outcome).toBe('applied');
    await reviewCheck(deps, two.id, 'approve', agent, { comment: 'older clients' });
    expect((await listReviews(deps, two.id))[0]?.comment).toBe('older clients');
  });

  test('suggest: a token must give a reason; its review is recorded, the check stays pending', async () => {
    await policy('suggest');
    const { buildId, check } = await changed();
    expect((await appError(reviewCheck(deps, check.id, 'approve', agent))).code).toBe('reason_required');
    expect((await appError(reviewCheck(deps, check.id, 'approve', agent, { reason: '  ' }))).code).toBe(
      'reason_required',
    );

    const { check: suggested, outcome } = await reviewCheck(deps, check.id, 'approve', agent, {
      reason: 'The button moved 4 px: intended',
    });
    expect(outcome).toBe('suggested');
    expect(suggested.review).toBe('pending');
    expect(suggested.suggestion).toEqual({
      action: 'approve',
      reason: 'The button moved 4 px: intended',
      by: { kind: 'token', id: 'tok_agent', name: 'claude' },
      at: expect.any(Number),
    });
    const build = await getBuild(deps, buildId);
    expect(build.verdict).toBe('pending');
    expect(build.counts.suggested).toBe(1);
    expect((await listReviews(deps, check.id)).map((e) => [e.action, e.actorKind])).toEqual([
      ['suggested_approval', 'token'],
    ]);

    // A person's review always applies, and settles the suggestion.
    expect((await reviewCheck(deps, check.id, 'approve', 'usr_1')).outcome).toBe('applied');
    expect((await getCheck(deps, check.id)).suggestion).toBeNull();
  });

  test('suggest: a person accepts a suggestion (with the agent reason) or dismisses it', async () => {
    await policy('suggest');
    const one = (await changed(small, 'one')).check;
    const two = (await changed(small, 'two')).check;
    await reviewCheck(deps, one.id, 'reject', agent, { reason: 'The logo is cut off' });
    await reviewCheck(deps, two.id, 'approve', agent, { reason: 'Intended' });

    const rejected = await acceptSuggestion(deps, one.id, 'usr_1');
    expect(rejected).toMatchObject({ review: 'rejected', reviewedBy: 'usr_1', reviewComment: 'The logo is cut off' });
    expect(rejected.suggestion).toBeNull();
    expect((await listReviews(deps, one.id)).map((e) => [e.action, e.actorKind])).toEqual([
      ['rejected', 'user'],
      ['suggested_rejection', 'token'],
    ]);

    expect((await appError(acceptSuggestion(deps, two.id, agent))).status).toBe(403);
    const dismissed = await dismissSuggestion(deps, two.id, 'usr_1', { reason: 'Not intended' });
    expect(dismissed).toMatchObject({ review: 'pending', suggestion: null });
    expect((await listReviews(deps, two.id))[0]).toMatchObject({
      action: 'suggestion_dismissed',
      actorKind: 'user',
      comment: 'Not intended',
    });
    expect((await appError(dismissSuggestion(deps, two.id, 'usr_1'))).code).toBe('no_suggestion');
    expect((await appError(acceptSuggestion(deps, two.id, 'usr_1'))).code).toBe('no_suggestion');
  });

  test('auto-below: small approvals apply, large ones and new screenshots become suggestions; rejections apply', async () => {
    await policy('auto-below', 2);
    const tiny = (await changed(small, 'tiny')).check;
    const big = (await changed(large, 'big')).check;
    const buildId = await openBuild(deps);
    const fresh = (await submit(deps, buildId, white, { name: 'fresh' })).check;
    const bad = (await changed(large, 'bad')).check;
    const why = { reason: 'checked' };
    expect((await reviewCheck(deps, tiny.id, 'approve', agent, why)).outcome).toBe('applied');
    expect((await reviewCheck(deps, big.id, 'approve', agent, why)).outcome).toBe('suggested');
    expect((await reviewCheck(deps, fresh.id, 'approve', agent, why)).outcome).toBe('suggested');
    expect((await reviewCheck(deps, bad.id, 'reject', agent, why)).outcome).toBe('applied');
    expect((await appError(reviewCheck(deps, bad.id, 'approve', agent))).code).toBe('reason_required');
  });

  test('approving a whole build goes through the policy too', async () => {
    await policy('auto-below', 2);
    await seedBaseline(deps, project, white, { name: 'tiny' });
    await seedBaseline(deps, project, white, { name: 'big' });
    const buildId = await openBuild(deps);
    await submit(deps, buildId, small, { name: 'tiny' });
    await submit(deps, buildId, large, { name: 'big' });
    expect((await appError(approveBuild(deps, buildId, agent))).code).toBe('reason_required');
    expect(await approveBuild(deps, buildId, agent, { reason: 'All intended' })).toEqual({ approved: 1, suggested: 1 });
    expect((await getBuild(deps, buildId)).counts.suggested).toBe(1);
    // People approve everything, suggestions included.
    expect(await approveBuild(deps, buildId, 'usr_1')).toEqual({ approved: 1, suggested: 0 });
    expect((await getBuild(deps, buildId)).counts.suggested).toBe(0);
  });

  test('a suggestion goes when the check is compared again or posted again', async () => {
    await policy('suggest');
    const { buildId, check } = await changed();
    await reviewCheck(deps, check.id, 'approve', agent, { reason: 'Intended' });
    const { check: again } = await createArea(deps, check.id, 'usr_1', {
      kind: 'ignore',
      x: 80,
      y: 80,
      width: 10,
      height: 10,
    });
    expect(again.suggestion).toBeNull();

    await reviewCheck(deps, check.id, 'approve', agent, { reason: 'Intended' });
    const { check: reposted } = await submit(deps, buildId, small);
    expect(reposted.suggestion).toBeNull();
  });

  test('auto-approve-new and people are recorded with their kind', async () => {
    const { check } = await changed();
    await approveCheck(deps, check.id, 'usr_1');
    expect((await listReviews(deps, check.id))[0]).toMatchObject({ actorKind: 'user', actorName: null });
  });
});
