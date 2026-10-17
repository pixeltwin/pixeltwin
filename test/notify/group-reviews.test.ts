import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Project } from '../../src/db/schema';
import { finalizeBuild } from '../../src/domain/builds';
import { getCheck } from '../../src/domain/checks';
import { listGroups, resetGroup, reviewGroup } from '../../src/domain/groups';
import { updateIntegration } from '../../src/domain/integrations';
import { updateProject } from '../../src/domain/projects';
import { listReviews, type ReviewActor } from '../../src/domain/reviews';
import { createWebhook } from '../../src/domain/webhooks';
import { silentLogger } from '../../src/log';
import type { WebhookPayload } from '../../src/notify/messages';
import { Notifier } from '../../src/notify/notifier';
import { createTestDeps, type TestDeps } from '../helpers/deps';
import { appError } from '../helpers/errors';
import { FAKE_TOKEN, type FakeGitHub, startFakeGitHub, startReceiver } from '../helpers/fake-hosts';
import { BLACK, type FilledRect, makePng, type Rgba, WHITE } from '../helpers/png';
import { openBuild, seedBaseline, seedProject, submit } from '../helpers/scenario';

// Change groups (feat/change-groups) meet pull request statuses and webhooks (feat/pr-status) and
// the agent review policy (feat/agent-review): a group review goes through the same review core as
// a single one, so each applied member is announced, the build is synced once, and a token's group
// review becomes suggestions where its single reviews would.

const PUBLIC_URL = 'https://pt.example.com';
const GREY: Rgba = [120, 120, 120, 255];
const AGENT: ReviewActor = { kind: 'token', id: 'tok_agent', name: 'claude' };
const REASON = 'Made the logo wider, as the task asked.';

/**
 * A screen `height` px tall: a header whose logo is `logo` wide and a body of its own. The logo's
 * change is the same on every screen (one group), but a taller screen changes a smaller share of
 * its pixels: 240 of 32 000 (0.75 %) at 160 px, 240 of 128 000 (0.19 %) at 640 px.
 */
const screen = (height: number, body: FilledRect, logo: number) =>
  makePng(200, height, WHITE, [
    { x: 0, y: 0, width: 200, height: 20, color: GREY },
    { x: 10, y: 4, width: logo, height: 12, color: BLACK },
    body,
  ]);

const SCREENS = {
  home: { height: 160, body: { x: 20, y: 60, width: 80, height: 40, color: BLACK } },
  pricing: { height: 640, body: { x: 120, y: 300, width: 50, height: 50, color: BLACK } },
} as const;

describe('change groups and pull request notifications', () => {
  let deps: TestDeps;
  let project: Project;
  let gh: FakeGitHub;
  let receiver: ReturnType<typeof startReceiver>;
  let notifier: Notifier;
  let buildId: string;
  let groupId: string;
  const ids: Record<string, string> = {};

  beforeEach(async () => {
    deps = await createTestDeps();
    project = await seedProject(deps);
    gh = startFakeGitHub();
    receiver = startReceiver();
    notifier = new Notifier({
      deps,
      publicUrl: PUBLIC_URL,
      logger: silentLogger,
      blockPrivate: false,
      autoDeliver: false,
      codeHost: { sleep: async () => {} },
    });
    deps.events = notifier;
    await updateIntegration(deps, 'web', { baseUrl: gh.url, token: FAKE_TOKEN, repository: 'acme/shop' });
    await createWebhook(deps, 'web', { url: receiver.url, events: ['build.verdict_changed', 'check.reviewed'] });

    for (const [name, { height, body }] of Object.entries(SCREENS)) {
      await seedBaseline(deps, project, screen(height, body, 40), { name });
    }
    buildId = await openBuild(deps, 'web', { branch: 'feature/logo', commitSha: 'abc1234', pullRequest: 42 });
    for (const [name, { height, body }] of Object.entries(SCREENS)) {
      ids[name] = (await submit(deps, buildId, screen(height, body, 60), { name })).check.id;
    }
    await finalizeBuild(deps, buildId);
    await notifier.drain();
    expect(gh.statuses.map((s) => s.state)).toEqual(['pending']);
    const [group] = await listGroups(deps, buildId);
    expect(group?.size).toBe(2);
    groupId = group?.id as string;
  });

  afterEach(async () => {
    gh.stop();
    receiver.stop();
    await deps.handle.close();
  });

  const events = () => receiver.received.map((r) => r.headers['x-pixeltwin-event']);
  const payloads = (event: string) =>
    receiver.received
      .filter((r) => r.headers['x-pixeltwin-event'] === event)
      .map((r) => JSON.parse(r.body) as WebhookPayload);
  const syncsRequested = async () =>
    Number(
      (
        await deps.db
          .selectFrom('integrationSyncs')
          .select('requested')
          .where('buildId', '=', buildId)
          .executeTakeFirst()
      )?.requested ?? 0,
    );

  test('a person approving the group turns the PR green with one sync and sends check.reviewed per check', async () => {
    const before = await syncsRequested();
    const result = await reviewGroup(deps, buildId, groupId, 'approve', 'usr_1', { reason: 'New logo.' });
    expect(result.changed.sort()).toEqual([ids.home, ids.pricing].sort());
    expect(result.suggested).toEqual([]);
    expect(result.verdict).toBe('passed');
    // One sync for the whole group, not one per check.
    expect(await syncsRequested()).toBe(before + 1);

    await notifier.drain();
    expect(gh.statuses.map((s) => s.state)).toEqual(['pending', 'success']);
    expect(events().filter((e) => e === 'build.verdict_changed')).toHaveLength(1);
    const reviewed = payloads('check.reviewed');
    expect(reviewed.map((p) => p.check?.id).sort()).toEqual([ids.home, ids.pricing].sort());
    for (const p of reviewed) {
      expect(p.review).toEqual({
        action: 'approved',
        reason: 'New logo.',
        actor: { id: 'usr_1', kind: 'user', name: 'a deleted account' },
      });
    }
    const [event] = await listReviews(deps, ids.home as string);
    expect(event).toMatchObject({ action: 'approved', actorKind: 'user', comment: 'New logo.' });
  });

  test('a token under "suggest" only suggests: nothing is announced and the PR stays pending', async () => {
    await updateProject(deps, 'web', { agentReview: 'suggest' });
    expect((await appError(reviewGroup(deps, buildId, groupId, 'approve', AGENT))).code).toBe('reason_required');

    const before = await syncsRequested();
    const result = await reviewGroup(deps, buildId, groupId, 'approve', AGENT, { reason: REASON });
    expect(result.changed).toEqual([]);
    expect(result.suggested.sort()).toEqual([ids.home, ids.pricing].sort());
    expect(result.skipped).toEqual([]);
    expect(result.verdict).toBe('pending');
    expect(result.group.checks.map((c) => c.suggestion)).toEqual(['approve', 'approve']);
    expect(await syncsRequested()).toBe(before);

    await notifier.drain();
    expect(gh.statuses.map((s) => s.state)).toEqual(['pending']);
    expect(events()).toEqual([]);
    const check = await getCheck(deps, ids.home as string);
    expect(check.review).toBe('pending');
    expect(check.suggestion).toMatchObject({
      action: 'approve',
      reason: REASON,
      by: { kind: 'token', name: 'claude' },
    });
    expect((await listReviews(deps, ids.home as string))[0]).toMatchObject({
      action: 'suggested_approval',
      actorKind: 'token',
      actorName: 'claude',
      comment: REASON,
    });
  });

  test('a token under "auto-below" applies the members within the limit and suggests the rest', async () => {
    await updateProject(deps, 'web', { agentReview: 'auto-below', agentMaxDiffPercent: 0.5 });
    const result = await reviewGroup(deps, buildId, groupId, 'approve', AGENT, { reason: REASON });
    // pricing changed 0.19 % of its pixels (applies), home 0.75 % (above the limit: a suggestion).
    expect(result.changed).toEqual([ids.pricing as string]);
    expect(result.suggested).toEqual([ids.home as string]);
    expect(result.verdict).toBe('pending');

    await notifier.drain();
    const reviewed = payloads('check.reviewed');
    expect(reviewed.map((p) => p.check?.id)).toEqual([ids.pricing]);
    expect(reviewed[0]?.review).toEqual({
      action: 'approved',
      reason: REASON,
      actor: { id: AGENT.id, kind: 'token', name: 'token “claude”' },
    });
    expect(events()).not.toContain('build.verdict_changed');
    expect(gh.statuses.at(-1)?.state).toBe('pending');
    expect((await listReviews(deps, ids.pricing as string))[0]).toMatchObject({
      action: 'approved',
      actorKind: 'token',
      actorName: 'claude',
    });
    expect((await getCheck(deps, ids.home as string)).suggestion?.action).toBe('approve');
  });

  test('resetting the group undoes exactly what the group review changed and announces it', async () => {
    const approved = await reviewGroup(deps, buildId, groupId, 'approve', 'usr_1');
    await notifier.drain();
    expect(gh.statuses.at(-1)?.state).toBe('success');
    const before = await syncsRequested();
    receiver.received.length = 0;

    const reset = await resetGroup(deps, buildId, groupId, 'usr_1', { checkIds: approved.changed });
    expect(reset.changed.sort()).toEqual([...approved.changed].sort());
    expect(reset.verdict).toBe('pending');
    expect(await syncsRequested()).toBe(before + 1);

    await notifier.drain();
    expect(gh.statuses.at(-1)?.state).toBe('pending');
    expect(events().filter((e) => e === 'build.verdict_changed')).toHaveLength(1);
    const reviewed = payloads('check.reviewed');
    expect(reviewed.map((p) => p.check?.id).sort()).toEqual([ids.home, ids.pricing].sort());
    expect(reviewed.every((p) => p.review?.action === 'reset')).toBe(true);
  });
});
