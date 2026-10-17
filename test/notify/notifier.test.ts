import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Project } from '../../src/db/schema';
import { createArea } from '../../src/domain/areas';
import { promoteBranch } from '../../src/domain/baselines';
import { finalizeBuild } from '../../src/domain/builds';
import { updateIntegration } from '../../src/domain/integrations';
import { updateProject } from '../../src/domain/projects';
import { approveCheck, rejectCheck, resetReview } from '../../src/domain/reviews';
import { hmacSha256Hex } from '../../src/domain/secrets';
import { createWebhook, listDeliveries } from '../../src/domain/webhooks';
import { silentLogger } from '../../src/log';
import type { WebhookPayload } from '../../src/notify/messages';
import { Notifier } from '../../src/notify/notifier';
import { createTestDeps, type TestDeps } from '../helpers/deps';
import {
  FAKE_GITLAB_TOKEN,
  FAKE_TOKEN,
  type FakeGitHub,
  startFakeGitHub,
  startFakeGitLab,
  startReceiver,
} from '../helpers/fake-hosts';
import { BLACK, makePng, WHITE } from '../helpers/png';
import { openBuild, seedBaseline, seedProject, submit } from '../helpers/scenario';

const PUBLIC_URL = 'https://pt.example.com';
const white = makePng(100, 100);
const changed = makePng(100, 100, WHITE, [{ x: 10, y: 10, width: 10, height: 10, color: BLACK }]);

describe('notifications', () => {
  let deps: TestDeps;
  let project: Project;
  let gh: FakeGitHub;
  let receiver: ReturnType<typeof startReceiver>;
  let receiverStatus: number;
  let clock: number;
  let notifier: Notifier;

  const makeNotifier = () =>
    new Notifier({
      deps,
      publicUrl: PUBLIC_URL,
      logger: silentLogger,
      blockPrivate: false,
      autoDeliver: false,
      codeHost: { sleep: async () => {} },
      now: () => clock,
    });

  beforeEach(async () => {
    deps = await createTestDeps();
    project = await seedProject(deps);
    gh = startFakeGitHub();
    receiverStatus = 200;
    receiver = startReceiver(() => receiverStatus);
    clock = Date.now();
    notifier = makeNotifier();
    deps.events = notifier;
  });

  afterEach(async () => {
    gh.stop();
    receiver.stop();
    await deps.handle.close();
  });

  async function connectGitHub(extra: Record<string, unknown> = {}) {
    await updateIntegration(deps, 'web', {
      baseUrl: gh.url,
      token: FAKE_TOKEN,
      repository: 'acme/shop',
      ...extra,
    });
  }

  /** A finalized build on feature/login for PR #42 with one changed check waiting for review. */
  async function changedBuild(input: Record<string, unknown> = {}) {
    await seedBaseline(deps, project, white, { variant: { browser: 'chromium' } });
    const buildId = await openBuild(deps, 'web', {
      branch: 'feature/login',
      commitSha: 'abc1234',
      pullRequest: 42,
      ...input,
    });
    const { check } = await submit(deps, buildId, changed, { variant: { browser: 'chromium' } });
    await finalizeBuild(deps, buildId);
    return { buildId, checkId: check.id };
  }

  test('finalize posts a pending status and a comment; approving turns the status green and edits the comment', async () => {
    await connectGitHub();
    const { buildId, checkId } = await changedBuild();
    await notifier.drain();
    expect(gh.statuses).toEqual([
      {
        repo: 'acme/shop',
        sha: 'abc1234',
        state: 'pending',
        description: '1 screenshot to review',
        context: 'pixeltwin/web',
        target_url: `${PUBLIC_URL}/ui/builds/${buildId}`,
      },
    ]);
    expect(gh.comments.size).toBe(1);
    const [comment] = [...gh.comments.values()];
    expect(comment?.pr).toBe(42);
    expect(comment?.body).toContain(`<!-- pixeltwin:build:${buildId} -->`);
    expect(comment?.body).toContain(`[home](${PUBLIC_URL}/ui/checks/${checkId})`);

    await approveCheck(deps, checkId, 'usr_1');
    await notifier.drain();
    expect(gh.statuses.at(-1)).toMatchObject({ state: 'success', description: '1 screenshot passed (1 approved)' });
    // Edited in place: still one comment, now saying it passed.
    expect(gh.comments.size).toBe(1);
    expect(gh.comments.get(comment?.id ?? 0)?.body).toContain('Passed');

    await rejectCheck(deps, checkId, 'usr_1').catch(() => {});
    await resetReview(deps, checkId, 'usr_1');
    await rejectCheck(deps, checkId, 'usr_1');
    await notifier.drain();
    // Three changes queued before the worker ran make one update.
    expect(gh.statuses.at(-1)).toMatchObject({ state: 'failure', description: '1 screenshot rejected' });
    expect(gh.statuses).toHaveLength(3);
  });

  test('GitLab: the commit status and one merge request note per build, edited in place', async () => {
    const gl = startFakeGitLab();
    try {
      await updateIntegration(deps, 'web', {
        provider: 'gitlab',
        baseUrl: gl.url,
        token: FAKE_GITLAB_TOKEN,
        repository: 'group/sub/shop',
      });
      const { buildId, checkId } = await changedBuild({ pullRequest: 7 });
      await notifier.drain();
      expect(gl.statuses).toEqual([
        {
          repo: 'group/sub/shop',
          sha: 'abc1234',
          state: 'pending',
          name: 'pixeltwin/web',
          description: '1 screenshot to review',
          target_url: `${PUBLIC_URL}/ui/builds/${buildId}`,
        },
      ]);
      expect([...gl.notes.values()].map((n) => n.pr)).toEqual([7]);
      await rejectCheck(deps, checkId, 'usr_1');
      await notifier.drain();
      expect(gl.statuses.at(-1)).toMatchObject({ state: 'failed', description: '1 screenshot rejected' });
      expect(gl.notes.size).toBe(1);
      expect([...gl.notes.values()][0]?.body).toContain('Rejected');
    } finally {
      gl.stop();
    }
  });

  test('an open build is not reported; a repeated finalize is not announced again', async () => {
    await connectGitHub();
    await seedBaseline(deps, project, white);
    const buildId = await openBuild(deps, 'web', { branch: 'feature/login', commitSha: 'abc', pullRequest: 1 });
    const { check } = await submit(deps, buildId, changed);
    await approveCheck(deps, check.id, 'usr_1');
    await notifier.drain();
    expect(gh.requests).toHaveLength(0);
    await finalizeBuild(deps, buildId);
    await notifier.drain();
    expect(gh.statuses).toHaveLength(1);
    await finalizeBuild(deps, buildId);
    await notifier.drain();
    expect(gh.statuses).toHaveLength(1);
  });

  test('the repository comes from the build, else from the settings; without one the error is kept', async () => {
    await connectGitHub({ repository: null });
    await changedBuild({ repository: 'acme/from-ci' });
    await notifier.drain();
    expect(gh.statuses[0]?.repo).toBe('acme/from-ci');

    const { buildId } = await changedBuild({ externalId: 'two' });
    await notifier.drain();
    const sync = await deps.db
      .selectFrom('integrationSyncs')
      .selectAll()
      .where('buildId', '=', buildId)
      .executeTakeFirst();
    expect(sync?.lastError).toContain('No repository');
  });

  test('GitHub refusing (bad token) is kept as the error and not retried; GitHub down is retried later', async () => {
    await updateIntegration(deps, 'web', { baseUrl: gh.url, token: 'ghp_wrong9999', repository: 'acme/shop' });
    const { buildId } = await changedBuild();
    await notifier.drain();
    let sync = await deps.db
      .selectFrom('integrationSyncs')
      .selectAll()
      .where('buildId', '=', buildId)
      .executeTakeFirst();
    expect(sync?.lastError).toContain('401');
    expect(sync?.lastError).not.toContain('ghp_wrong9999');
    expect(sync?.done).toBe(sync?.requested as number);

    await connectGitHub();
    gh.failNext(502, 3);
    await approveCheck(deps, (await deps.db.selectFrom('checks').select('id').executeTakeFirstOrThrow()).id, 'usr_1');
    await notifier.drain();
    sync = await deps.db.selectFrom('integrationSyncs').selectAll().where('buildId', '=', buildId).executeTakeFirst();
    expect(sync?.lastError).toContain('502');
    expect(Number(sync?.dueAt)).toBeGreaterThan(clock);
    expect(gh.statuses).toHaveLength(0);
    clock += 60_000;
    await notifier.drain();
    expect(gh.statuses.at(-1)?.state).toBe('success');
  });

  test('webhooks: signed JSON for build.finalized, build.verdict_changed and check.reviewed', async () => {
    const { webhook, secret } = await createWebhook(deps, 'web', {
      url: receiver.url,
      events: ['build.finalized', 'build.verdict_changed', 'check.reviewed'],
    });
    expect(secret).toStartWith('whsec_');
    const { buildId, checkId } = await changedBuild();
    await approveCheck(deps, checkId, 'usr_1');
    await notifier.drain();
    const events = receiver.received.map((r) => r.headers['x-pixeltwin-event']);
    expect(events.sort()).toEqual(['build.finalized', 'build.verdict_changed', 'check.reviewed']);
    for (const hook of receiver.received) {
      expect(hook.headers['x-pixeltwin-signature']).toBe(`sha256=${hmacSha256Hex(secret ?? '', hook.body)}`);
      const payload = JSON.parse(hook.body) as WebhookPayload;
      expect(hook.headers['x-pixeltwin-delivery']).toBe(payload.id);
      expect(payload.project).toEqual({ id: project.id, slug: 'web', name: 'web' });
      expect(payload.build?.id).toBe(buildId);
    }
    const byEvent = Object.fromEntries(
      receiver.received.map((r) => [r.headers['x-pixeltwin-event'], JSON.parse(r.body)]),
    );
    expect(byEvent['build.finalized'].build.verdict).toBe('pending');
    expect(byEvent['build.verdict_changed'].build).toMatchObject({ verdict: 'passed', previousVerdict: 'pending' });
    expect(byEvent['check.reviewed']).toMatchObject({
      check: { id: checkId, review: 'approved', url: `${PUBLIC_URL}/ui/checks/${checkId}` },
      review: { action: 'approved', actor: { id: 'usr_1', name: 'a deleted account' } },
    });
    const deliveries = await listDeliveries(deps, 'web', webhook.id);
    expect(deliveries.map((d) => d.state)).toEqual(['delivered', 'delivered', 'delivered']);
    expect(deliveries[0]?.statusCode).toBe(200);
  });

  test('a verdict that comes back to what was announced is not a change; auto-approve is not a review', async () => {
    await createWebhook(deps, 'web', { url: receiver.url, events: ['build.verdict_changed', 'check.reviewed'] });
    await updateProject(deps, 'web', { autoApproveNew: true });
    const buildId = await openBuild(deps, 'web', { branch: 'main' });
    await submit(deps, buildId, white, { name: 'fresh' });
    await finalizeBuild(deps, buildId);
    await notifier.drain();
    expect(receiver.received).toHaveLength(0);
  });

  test('Slack format posts { text, blocks }', async () => {
    await createWebhook(deps, 'web', { url: receiver.url, events: ['build.finalized'], format: 'slack' });
    await changedBuild();
    await notifier.drain();
    const body = JSON.parse(receiver.received[0]?.body ?? '{}');
    expect(body.text).toContain('build #1 on feature/login needs review');
    expect(Array.isArray(body.blocks)).toBe(true);
  });

  test('a failing receiver is retried with backoff; a 4xx is not; deliveries are kept to the last 20', async () => {
    const { webhook } = await createWebhook(deps, 'web', { url: receiver.url, events: ['build.finalized'] });
    receiverStatus = 503;
    await changedBuild();
    await notifier.drain();
    let [delivery] = await listDeliveries(deps, 'web', webhook.id);
    expect(delivery).toMatchObject({ state: 'pending', attempts: 1, statusCode: 503 });
    receiverStatus = 200;
    clock += 11_000;
    await notifier.drain();
    [delivery] = await listDeliveries(deps, 'web', webhook.id);
    expect(delivery).toMatchObject({ state: 'delivered', attempts: 2, statusCode: 200 });

    receiverStatus = 410;
    await changedBuild({ externalId: 'gone' });
    await notifier.drain();
    [delivery] = await listDeliveries(deps, 'web', webhook.id);
    expect(delivery).toMatchObject({ state: 'failed', attempts: 1, statusCode: 410 });

    receiverStatus = 200;
    for (let i = 0; i < 25; i++) await notifier.sendTest(project.id, webhook.id);
    const kept = await deps.db
      .selectFrom('webhookDeliveries')
      .select('id')
      .where('webhookId', '=', webhook.id)
      .execute();
    expect(kept).toHaveLength(20);
  });

  test('two replicas on one database send each delivery and each GitHub update once', async () => {
    await connectGitHub();
    await createWebhook(deps, 'web', { url: receiver.url, events: ['build.finalized'] });
    const other = makeNotifier();
    for (let i = 0; i < 5; i++) await changedBuild({ externalId: `run-${i}`, commitSha: `sha${i}` });
    await Promise.all([notifier.runOnce(), other.runOnce(), notifier.runOnce(), other.runOnce()]);
    await Promise.all([notifier.drain(), other.drain()]);
    expect(receiver.received).toHaveLength(5);
    expect(new Set(receiver.received.map((r) => r.headers['x-pixeltwin-delivery'])).size).toBe(5);
    expect(gh.statuses).toHaveLength(5);
    expect(gh.comments.size).toBe(5);
  });

  test('drawing an area that hides the change, and promoting a branch, change verdicts', async () => {
    await createWebhook(deps, 'web', { url: receiver.url, events: ['build.verdict_changed'] });
    const { checkId } = await changedBuild();
    await createArea(deps, checkId, 'usr_1', { kind: 'ignore', x: 0, y: 0, width: 50, height: 50 });
    await notifier.drain();
    expect(JSON.parse(receiver.received[0]?.body ?? '{}').build).toMatchObject({
      verdict: 'passed',
      previousVerdict: 'pending',
    });

    // main waits on a screen that a branch approved; promoting the branch decides it.
    const mainBuild = await openBuild(deps, 'web', { branch: 'main', externalId: 'main-1' });
    const mainCheck = await submit(deps, mainBuild, changed, { name: 'promo' });
    await finalizeBuild(deps, mainBuild);
    const branchBuild = await openBuild(deps, 'web', { branch: 'feature/promo', externalId: 'b-1' });
    const branchCheck = await submit(deps, branchBuild, changed, { name: 'promo' });
    await approveCheck(deps, branchCheck.check.id, 'usr_1');
    receiver.received.length = 0;
    await notifier.drain();
    receiver.received.length = 0;
    expect(mainCheck.check.review).toBe('pending');
    await promoteBranch(deps, 'web', 'feature/promo', 'usr_1');
    await notifier.drain();
    expect(receiver.received.map((r) => JSON.parse(r.body).build)).toContainEqual(
      expect.objectContaining({ id: mainBuild, verdict: 'outdated', previousVerdict: 'pending' }),
    );
  });
});
