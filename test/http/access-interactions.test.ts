import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { addMember } from '../../src/domain/members';
import { createProject } from '../../src/domain/projects';
import { createWebhook } from '../../src/domain/webhooks';
import { createTestApp, problemOf, type TestApp } from '../helpers/app';
import { FAKE_TOKEN, type FakeGitHub, startFakeGitHub } from '../helpers/fake-hosts';
import { BLACK, type FilledRect, makePng, type Rgba, WHITE } from '../helpers/png';
import { html, postForm } from '../helpers/ui';

// Per-project access (feat/project-access) meets what main gained meanwhile: pull request
// integrations and webhooks (pr-status), agent suggestions and policy (agent-review), change
// groups, flaky history and noisy screens (change-groups).

const GREY: Rgba = [120, 120, 120, 255];
/** A screen with a header logo `logo` wide and a body; the logo change is the same on every screen. */
const screen = (height: number, body: FilledRect, logo: number) =>
  makePng(200, height, WHITE, [
    { x: 0, y: 0, width: 200, height: 20, color: GREY },
    { x: 10, y: 4, width: logo, height: 12, color: BLACK },
    body,
  ]);
const b64 = (png: Uint8Array) => Buffer.from(png).toString('base64');
const box = (x: number, y: number): FilledRect => ({ x, y, width: 40, height: 40, color: BLACK });

type User = { cookie: string; id: string };

describe('project access on the routes main added', () => {
  let t: TestApp;
  let gh: FakeGitHub;
  let admin: User;
  let maintainer: User;
  let reviewer: User;
  let viewer: User;
  let outsider: User;
  let agent: { token: string };
  let buildId: string;
  let groupId: string;
  let suggested: string;
  let webHook: string;
  let otherHook: string;
  const checks: Record<string, string> = {};

  async function upload(id: string, name: string, png: Uint8Array) {
    const ci = await t.tokenAs('web', ['write']);
    const res = await t.request('POST', `/api/v1/builds/${id}/checks`, {
      as: ci,
      json: { name, imageBase64: b64(png) },
    });
    expect(res.status).toBeLessThan(300);
    return ((await res.json()) as { id: string }).id;
  }

  beforeEach(async () => {
    t = await createTestApp();
    gh = startFakeGitHub();
    await createProject(t.deps, { slug: 'web', name: 'Web' });
    await createProject(t.deps, { slug: 'other', name: 'Other' });
    admin = await t.userAs('admin', 'root@example.com');
    maintainer = await t.userAs('reviewer', 'maintainer@example.com', { projects: [] });
    await addMember(t.deps, 'web', { email: 'maintainer@example.com', role: 'maintainer' });
    reviewer = await t.userAs('reviewer', 'reviewer@example.com', { projects: ['web'] });
    viewer = await t.userAs('viewer', 'viewer@example.com', { projects: ['web'] });
    // A maintainer elsewhere: a role in another project opens nothing here.
    outsider = await t.userAs('reviewer', 'outsider@example.com', { projects: [] });
    await addMember(t.deps, 'other', { email: 'outsider@example.com', role: 'maintainer' });

    let res = await t.request('PATCH', '/api/v1/projects/web/integration', {
      as: admin,
      json: { provider: 'github', baseUrl: gh.url, token: FAKE_TOKEN, repository: 'acme/shop' },
    });
    expect(res.status).toBe(200);
    webHook = (await createWebhook(t.deps, 'web', { url: 'https://hooks.example.com/web', events: ['check.reviewed'] }))
      .webhook.id;
    otherHook = (
      await createWebhook(t.deps, 'other', { url: 'https://hooks.example.com/o', events: ['check.reviewed'] })
    ).webhook.id;

    // Baselines: home and pricing (the same logo change: a group) and cart (a change of its own).
    const ci = await t.tokenAs('web', ['write']);
    const open = async (input: Record<string, unknown>) =>
      (
        (await (await t.request('POST', '/api/v1/projects/web/builds', { as: ci, json: input })).json()) as {
          id: string;
        }
      ).id;
    const first = await open({});
    for (const id of [
      await upload(first, 'home', screen(160, box(20, 60), 40)),
      await upload(first, 'pricing', screen(640, box(120, 300), 40)),
      await upload(first, 'cart', screen(300, box(20, 100), 40)),
    ]) {
      expect((await t.request('POST', `/api/v1/checks/${id}/approve`, { as: admin })).status).toBe(200);
    }
    buildId = await open({ branch: 'feature/logo', commitSha: 'abc1234', repository: 'acme/shop', pullRequest: 42 });
    checks.home = await upload(buildId, 'home', screen(160, box(20, 60), 60));
    checks.pricing = await upload(buildId, 'pricing', screen(640, box(120, 300), 60));
    checks.cart = await upload(buildId, 'cart', screen(300, box(100, 100), 40));
    res = await t.request('POST', `/api/v1/builds/${buildId}/finalize`, { as: ci, json: {} });
    expect(res.status).toBe(200);
    const groups = (await (await t.request('GET', `/api/v1/builds/${buildId}/groups`, { as: viewer })).json()) as {
      items: Array<{ id: string; size: number }>;
    };
    expect(groups.items.map((g) => g.size)).toEqual([2]);
    groupId = groups.items[0]?.id as string;

    // An agent under "suggest" suggests approving the cart.
    res = await t.request('PATCH', '/api/v1/projects/web', { as: maintainer, json: { agentReview: 'suggest' } });
    expect(res.status).toBe(200);
    agent = await t.tokenAs('web', ['read', 'review']);
    res = await t.request('POST', `/api/v1/checks/${checks.cart}/approve`, {
      as: agent,
      json: { reason: 'Moved the cart box, as asked.' },
    });
    expect(((await res.json()) as { outcome: string }).outcome).toBe('suggested');
    suggested = checks.cart as string;
    await t.notifier.drain();
    expect(gh.statuses.at(-1)?.state).toBe('pending');
  });

  afterEach(async () => {
    gh.stop();
    await t.close();
  });

  test('a user outside the project gets 404 on groups, webhooks, the integration, noisy screens and suggestions', async () => {
    const calls: Array<[string, string, unknown?]> = [
      ['GET', `/api/v1/builds/${buildId}/groups`],
      ['POST', `/api/v1/builds/${buildId}/groups/${groupId}/approve`, {}],
      ['POST', `/api/v1/builds/${buildId}/groups/${groupId}/reset`, {}],
      ['GET', '/api/v1/projects/web/integration'],
      ['PATCH', '/api/v1/projects/web/integration', { commitStatus: false }],
      ['DELETE', '/api/v1/projects/web/integration'],
      ['GET', '/api/v1/projects/web/webhooks'],
      ['POST', '/api/v1/projects/web/webhooks', { url: 'https://evil.example.com', events: ['check.reviewed'] }],
      ['GET', `/api/v1/projects/web/webhooks/${webHook}`],
      ['PATCH', `/api/v1/projects/web/webhooks/${webHook}`, { enabled: false }],
      ['GET', `/api/v1/projects/web/webhooks/${webHook}/deliveries`],
      ['POST', `/api/v1/projects/web/webhooks/${webHook}/test`, {}],
      ['DELETE', `/api/v1/projects/web/webhooks/${webHook}`],
      ['GET', '/api/v1/projects/web/noisy-screens'],
      ['GET', `/api/v1/checks/${checks.home}/history`],
      ['GET', `/api/v1/checks/${checks.home}/elements`],
      ['POST', `/api/v1/checks/${suggested}/suggestion/accept`, {}],
      ['POST', `/api/v1/checks/${suggested}/suggestion/dismiss`, {}],
      ['PATCH', '/api/v1/projects/web', { agentReview: 'off' }],
    ];
    for (const [method, path, json] of calls) {
      const res = await t.request(method, path, { as: outsider, json });
      const problem = await problemOf(res);
      expect({ path, method, status: res.status }).toEqual({ path, method, status: 404 });
      expect(problem.code).toMatch(/^(project|build|check)_not_found$/);
    }
    for (const path of [
      '/ui/p/web/noisy',
      `/ui/p/web/settings/webhooks/${webHook}`,
      '/ui/p/web/settings/webhooks/new',
      `/ui/builds/${buildId}`,
    ]) {
      expect({ path, status: (await t.request('GET', path, { as: outsider })).status }).toEqual({ path, status: 404 });
    }
    for (const path of [
      `/ui/builds/${buildId}/groups/${groupId}/approve`,
      `/ui/checks/${suggested}/suggestion/accept`,
      '/ui/p/web/settings/integration',
      `/ui/p/web/settings/webhooks/${webHook}/test`,
      `/ui/p/web/settings/webhooks/${webHook}/delete`,
    ]) {
      expect({ path, status: (await postForm(t, path, {}, outsider)).status }).toEqual({ path, status: 404 });
    }
    // Nothing changed behind the 404s.
    expect((await t.deps.db.selectFrom('webhooks').select('id').execute()).length).toBe(2);
    expect(
      (await t.request('GET', `/api/v1/checks/${suggested}`, { as: admin }).then((r) => r.json())).suggestion,
    ).not.toBeNull();
  });

  test('a reviewer member approves the group and accepts the suggestion, and the pull request turns green', async () => {
    const group = await t.request('POST', `/api/v1/builds/${buildId}/groups/${groupId}/approve`, {
      as: reviewer,
      json: { reason: 'New logo.' },
    });
    expect(group.status).toBe(200);
    expect(((await group.json()) as { changed: string[] }).changed.sort()).toEqual(
      [checks.home, checks.pricing].sort(),
    );
    await t.notifier.drain();
    expect(gh.statuses.at(-1)?.state).toBe('pending');

    const accept = await t.request('POST', `/api/v1/checks/${suggested}/suggestion/accept`, { as: reviewer });
    expect(accept.status).toBe(200);
    expect(((await accept.json()) as { review: string }).review).toBe('approved');
    await t.notifier.drain();
    expect(gh.statuses.at(-1)?.state).toBe('success');
    const build = (await (await t.request('GET', `/api/v1/builds/${buildId}`, { as: viewer })).json()) as {
      verdict: string;
    };
    expect(build.verdict).toBe('passed');
  });

  test('the same works from the UI forms for a reviewer member', async () => {
    let res = await postForm(t, `/ui/builds/${buildId}/groups/${groupId}/approve`, {}, reviewer);
    expect(res.status).toBe(303);
    res = await postForm(t, `/ui/checks/${suggested}/suggestion/accept`, {}, reviewer);
    expect(res.status).toBe(303);
    await t.notifier.drain();
    expect(gh.statuses.at(-1)?.state).toBe('success');
  });

  test('a viewer member sees groups, history and noisy screens but may not review them (403)', async () => {
    for (const path of [
      `/api/v1/builds/${buildId}/groups`,
      `/api/v1/checks/${checks.home}/history`,
      `/api/v1/checks/${checks.home}/elements`,
      '/api/v1/projects/web/noisy-screens',
    ]) {
      expect({ path, status: (await t.request('GET', path, { as: viewer })).status }).toEqual({ path, status: 200 });
    }
    expect((await t.request('GET', '/ui/p/web/noisy', { as: viewer })).status).toBe(200);
    for (const [path, json] of [
      [`/api/v1/builds/${buildId}/groups/${groupId}/approve`, {}],
      [`/api/v1/builds/${buildId}/groups/${groupId}/reject`, {}],
      [`/api/v1/builds/${buildId}/groups/${groupId}/reset`, {}],
      [`/api/v1/checks/${suggested}/suggestion/accept`, undefined],
      [`/api/v1/checks/${suggested}/suggestion/dismiss`, undefined],
    ] as const) {
      const res = await t.request('POST', path, { as: viewer, json });
      expect({ path, status: res.status, code: (await problemOf(res)).code }).toEqual({
        path,
        status: 403,
        code: 'forbidden',
      });
    }
    expect((await postForm(t, `/ui/builds/${buildId}/groups/${groupId}/approve`, {}, viewer)).status).toBe(403);
    expect((await postForm(t, `/ui/checks/${suggested}/suggestion/accept`, {}, viewer)).status).toBe(403);
    // The pages offer no review buttons to a viewer.
    expect(await html(await t.request('GET', `/ui/checks/${suggested}`, { as: viewer }))).not.toContain(
      '/suggestion/accept',
    );
  });

  test('a maintainer manages the integration, webhooks and agent policy of their project only', async () => {
    expect(
      (await t.request('PATCH', '/api/v1/projects/web/integration', { as: maintainer, json: { prComment: false } }))
        .status,
    ).toBe(200);
    const created = await t.request('POST', '/api/v1/projects/web/webhooks', {
      as: maintainer,
      json: { url: 'https://hooks.example.com/new', events: ['member.added'] },
    });
    expect(created.status).toBe(201);
    expect(
      (
        await t.request('PATCH', `/api/v1/projects/web/webhooks/${webHook}`, {
          as: maintainer,
          json: { enabled: false },
        })
      ).status,
    ).toBe(200);
    expect(
      (await t.request('GET', `/api/v1/projects/web/webhooks/${webHook}/deliveries`, { as: maintainer })).status,
    ).toBe(200);
    expect((await t.request('GET', '/ui/p/web/settings', { as: maintainer })).status).toBe(200);
    expect((await t.request('GET', `/ui/p/web/settings/webhooks/${webHook}`, { as: maintainer })).status).toBe(200);
    expect(
      (await t.request('PATCH', '/api/v1/projects/web', { as: maintainer, json: { agentReview: 'auto-below' } }))
        .status,
    ).toBe(200);

    // Another project's: hidden. Another project's webhook through this project: not found here.
    for (const [method, path] of [
      ['GET', '/api/v1/projects/other/integration'],
      ['GET', `/api/v1/projects/other/webhooks/${otherHook}`],
      ['POST', `/api/v1/projects/other/webhooks/${otherHook}/test`],
    ] as const) {
      expect((await t.request(method, path, { as: maintainer, json: method === 'POST' ? {} : undefined })).status).toBe(
        404,
      );
    }
    for (const [method, path] of [
      ['GET', `/api/v1/projects/web/webhooks/${otherHook}`],
      ['GET', `/api/v1/projects/web/webhooks/${otherHook}/deliveries`],
      ['PATCH', `/api/v1/projects/web/webhooks/${otherHook}`],
      ['POST', `/api/v1/projects/web/webhooks/${otherHook}/test`],
      ['DELETE', `/api/v1/projects/web/webhooks/${otherHook}`],
    ] as const) {
      const res = await t.request(method, path, {
        as: maintainer,
        json: method === 'GET' || method === 'DELETE' ? undefined : {},
      });
      expect({ path, method, code: (await problemOf(res)).code }).toEqual({ path, method, code: 'webhook_not_found' });
    }
    expect((await t.request('GET', `/ui/p/web/settings/webhooks/${otherHook}`, { as: maintainer })).status).toBe(404);
    expect((await postForm(t, `/ui/p/web/settings/webhooks/${otherHook}/delete`, {}, maintainer)).status).toBe(404);
    expect((await t.deps.db.selectFrom('webhooks').select('id').where('id', '=', otherHook).execute()).length).toBe(1);

    // A reviewer is no maintainer: integration, webhooks and the policy hold secrets or decide for agents.
    for (const [method, path, json] of [
      ['GET', '/api/v1/projects/web/integration', undefined],
      ['GET', '/api/v1/projects/web/webhooks', undefined],
      ['PATCH', '/api/v1/projects/web', { agentReview: 'off' }],
    ] as const) {
      expect((await t.request(method, path, { as: reviewer, json })).status).toBe(403);
    }
    expect((await t.request('GET', `/ui/p/web/settings/webhooks/${webHook}`, { as: reviewer })).status).toBe(403);
  });

  test('review history names a token by its name and a removed member by their email', async () => {
    const group = await t.request('POST', `/api/v1/builds/${buildId}/groups/${groupId}/approve`, { as: reviewer });
    expect(group.status).toBe(200);
    const removed = await t.request('DELETE', `/api/v1/projects/web/members/${reviewer.id}`, { as: maintainer });
    expect(removed.status).toBe(204);
    // The removed member no longer sees the project…
    expect((await t.request('GET', `/ui/checks/${checks.home}`, { as: reviewer })).status).toBe(404);
    // …but their review stays in the history, with their name.
    const home = await html(await t.request('GET', `/ui/checks/${checks.home}`, { as: viewer }));
    expect(home).toContain('reviewer@example.com');
    const events = (await (await t.request('GET', `/api/v1/checks/${checks.home}/reviews`, { as: viewer })).json()) as {
      items: Array<{ actor: string; actorKind: string }>;
    };
    expect(events.items[0]).toMatchObject({ actor: reviewer.id, actorKind: 'user' });
    const cart = await html(await t.request('GET', `/ui/checks/${suggested}`, { as: viewer }));
    expect(cart).toContain('token “test”');
  });
});
