import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Project } from '../../src/db/schema';
import { finalizeBuild } from '../../src/domain/builds';
import { getCheck } from '../../src/domain/checks';
import { updateIntegration } from '../../src/domain/integrations';
import { updateProject } from '../../src/domain/projects';
import {
  acceptSuggestion,
  approveBuild,
  dismissSuggestion,
  type ReviewActor,
  reviewCheck,
} from '../../src/domain/reviews';
import { createWebhook } from '../../src/domain/webhooks';
import { silentLogger } from '../../src/log';
import type { WebhookPayload } from '../../src/notify/messages';
import { Notifier } from '../../src/notify/notifier';
import { createTestDeps, type TestDeps } from '../helpers/deps';
import { FAKE_TOKEN, type FakeGitHub, startFakeGitHub, startReceiver } from '../helpers/fake-hosts';
import { BLACK, makePng, WHITE } from '../helpers/png';
import { openBuild, seedBaseline, seedProject, submit } from '../helpers/scenario';

// Agent reviews (feat/agent-review) meet pull request statuses and webhooks (feat/pr-status):
// a suggestion is not a review, so the code host and webhooks hear nothing; applying one does.

const PUBLIC_URL = 'https://pt.example.com';
const white = makePng(100, 100);
// 100 changed pixels of 10 000: 1 %.
const changed = makePng(100, 100, WHITE, [{ x: 10, y: 10, width: 10, height: 10, color: BLACK }]);
const AGENT: ReviewActor = { kind: 'token', id: 'tok_agent', name: 'claude' };
const REASON = 'Moved the promo banner up, as the task asked.';

describe('agent reviews and pull request notifications', () => {
  let deps: TestDeps;
  let project: Project;
  let gh: FakeGitHub;
  let receiver: ReturnType<typeof startReceiver>;
  let notifier: Notifier;

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
  });

  afterEach(async () => {
    gh.stop();
    receiver.stop();
    await deps.handle.close();
  });

  /** A finalized build for PR #42 with one changed check waiting; its pending status already posted. */
  async function changedBuild() {
    await seedBaseline(deps, project, white);
    const buildId = await openBuild(deps, 'web', { branch: 'feature/promo', commitSha: 'abc1234', pullRequest: 42 });
    const { check } = await submit(deps, buildId, changed);
    await finalizeBuild(deps, buildId);
    await notifier.drain();
    expect(gh.statuses.map((s) => s.state)).toEqual(['pending']);
    return { buildId, checkId: check.id };
  }

  const events = () => receiver.received.map((r) => r.headers['x-pixeltwin-event']);
  const payloadOf = (event: string) =>
    JSON.parse(
      receiver.received.find((r) => r.headers['x-pixeltwin-event'] === event)?.body ?? 'null',
    ) as WebhookPayload | null;

  test('a suggestion keeps the status pending and sends no check.reviewed; accepting it turns the PR green', async () => {
    await updateProject(deps, 'web', { agentReview: 'suggest' });
    const { checkId } = await changedBuild();

    const { outcome } = await reviewCheck(deps, checkId, 'approve', AGENT, { reason: REASON });
    expect(outcome).toBe('suggested');
    await notifier.drain();
    expect(gh.statuses.map((s) => s.state)).toEqual(['pending']);
    expect(events()).toEqual([]);
    expect((await getCheck(deps, checkId)).review).toBe('pending');

    await acceptSuggestion(deps, checkId, 'usr_1');
    await notifier.drain();
    expect(gh.statuses.at(-1)).toMatchObject({ state: 'success', description: '1 screenshot passed (1 approved)' });
    expect(events().sort()).toEqual(['build.verdict_changed', 'check.reviewed']);
    // The person's review, with the agent's reason.
    expect(payloadOf('check.reviewed')?.review).toEqual({
      action: 'approved',
      reason: REASON,
      actor: { id: 'usr_1', kind: 'user', name: 'a deleted account' },
    });
  });

  test('an accepted rejection suggestion turns the status red', async () => {
    await updateProject(deps, 'web', { agentReview: 'suggest' });
    const { checkId } = await changedBuild();
    await reviewCheck(deps, checkId, 'reject', AGENT, { reason: 'The banner overlaps the menu.' });
    await notifier.drain();
    expect(gh.statuses).toHaveLength(1);
    await acceptSuggestion(deps, checkId, 'usr_1');
    await notifier.drain();
    expect(gh.statuses.at(-1)?.state).toBe('failure');
    expect(payloadOf('check.reviewed')?.review).toMatchObject({
      action: 'rejected',
      reason: 'The banner overlaps the menu.',
    });
  });

  test('dismissing a suggestion sends nothing', async () => {
    await updateProject(deps, 'web', { agentReview: 'suggest' });
    const { checkId } = await changedBuild();
    await reviewCheck(deps, checkId, 'approve', AGENT, { reason: REASON });
    await dismissSuggestion(deps, checkId, 'usr_1', { reason: 'Not yet.' });
    await notifier.drain();
    expect(gh.statuses).toHaveLength(1);
    expect(events()).toEqual([]);
  });

  test('approve-all by a token under "suggest" only suggests: no status, no webhook, no sync queued', async () => {
    await updateProject(deps, 'web', { agentReview: 'suggest' });
    const { buildId } = await changedBuild();
    const before = await deps.db.selectFrom('integrationSyncs').select('requested').executeTakeFirstOrThrow();
    expect(await approveBuild(deps, buildId, AGENT, { reason: REASON })).toEqual({ approved: 0, suggested: 1 });
    const after = await deps.db.selectFrom('integrationSyncs').select('requested').executeTakeFirstOrThrow();
    expect(after.requested).toBe(before.requested);
    await notifier.drain();
    expect(gh.statuses).toHaveLength(1);
    expect(events()).toEqual([]);
  });

  test('approve-all by a token under "auto-below" applies small diffs and announces them as the token', async () => {
    await updateProject(deps, 'web', { agentReview: 'auto-below', agentMaxDiffPercent: 5 });
    const { buildId, checkId } = await changedBuild();
    expect(await approveBuild(deps, buildId, AGENT, { reason: REASON })).toEqual({ approved: 1, suggested: 0 });
    await notifier.drain();
    expect(gh.statuses.at(-1)?.state).toBe('success');
    const reviewed = payloadOf('check.reviewed');
    expect(reviewed?.check?.id).toBe(checkId);
    expect(reviewed?.review).toEqual({
      action: 'approved',
      reason: REASON,
      actor: { id: 'tok_agent', kind: 'token', name: 'token “claude”' },
    });
  });

  test('a token approving one check under "auto-below" turns the status green', async () => {
    await updateProject(deps, 'web', { agentReview: 'auto-below', agentMaxDiffPercent: 5 });
    const { checkId } = await changedBuild();
    const { outcome } = await reviewCheck(deps, checkId, 'approve', AGENT, { reason: REASON });
    expect(outcome).toBe('applied');
    await notifier.drain();
    expect(gh.statuses.at(-1)?.state).toBe('success');
    expect(payloadOf('check.reviewed')?.review?.actor.kind).toBe('token');
  });

  test('a diff above the limit becomes a suggestion and the status stays pending', async () => {
    await updateProject(deps, 'web', { agentReview: 'auto-below', agentMaxDiffPercent: 0.5 });
    const { checkId } = await changedBuild();
    const { outcome } = await reviewCheck(deps, checkId, 'approve', AGENT, { reason: REASON });
    expect(outcome).toBe('suggested');
    await notifier.drain();
    expect(gh.statuses).toHaveLength(1);
    expect(events()).toEqual([]);
  });
});
