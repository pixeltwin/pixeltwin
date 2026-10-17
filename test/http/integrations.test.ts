import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { appendBaseline, findCurrentBaseline } from '../../src/domain/baselines';
import { readPngHeader, storeImage } from '../../src/domain/images';
import { hmacSha256Hex } from '../../src/domain/secrets';
import { snapshotKey } from '../../src/domain/snapshot-key';
import { createTestApp, PUBLIC_URL, problemOf, type TestApp } from '../helpers/app';
import { FAKE_TOKEN, type FakeGitHub, startFakeGitHub, startReceiver } from '../helpers/fake-hosts';
import { BLACK, makePng, WHITE } from '../helpers/png';

const white = makePng(60, 40);
const changed = makePng(60, 40, WHITE, [{ x: 5, y: 5, width: 10, height: 10, color: BLACK }]);

describe('integration settings API', () => {
  let t: TestApp;
  let admin: { cookie: string };

  beforeEach(async () => {
    t = await createTestApp();
    admin = await t.userAs('admin');
    await t.request('POST', '/api/v1/projects', { as: admin, json: { slug: 'web', name: 'Web' } });
  });

  afterEach(async () => {
    await t.close();
  });

  test('starts unconfigured on GitHub; the token is write-only (set, last four characters)', async () => {
    const empty = await (await t.request('GET', '/api/v1/projects/web/integration', { as: admin })).json();
    expect(empty).toMatchObject({
      configured: false,
      provider: 'github',
      baseUrl: 'https://api.github.com',
      tokenSet: false,
      commitStatus: true,
      prComment: true,
      autoPromote: false,
      webhookUrl: `${PUBLIC_URL}/api/v1/integrations/github/webhook`,
      encrypted: false,
    });
    const res = await t.request('PATCH', '/api/v1/projects/web/integration', {
      as: admin,
      json: { repository: 'acme/shop', token: 'ghp_secret_value_abcd' },
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain('ghp_secret_value');
    expect(JSON.parse(text)).toMatchObject({
      configured: true,
      repository: 'acme/shop',
      tokenSet: true,
      tokenLast4: 'abcd',
    });
    const stored = await t.deps.db.selectFrom('integrations').select('token').executeTakeFirstOrThrow();
    expect(stored.token).toBe('plain:ghp_secret_value_abcd');
    // Omitted fields stay; null removes the token.
    await t.request('PATCH', '/api/v1/projects/web/integration', { as: admin, json: { prComment: false } });
    const kept = await (await t.request('GET', '/api/v1/projects/web/integration', { as: admin })).json();
    expect(kept).toMatchObject({ tokenSet: true, prComment: false, repository: 'acme/shop' });
    const removed = await t.request('PATCH', '/api/v1/projects/web/integration', { as: admin, json: { token: null } });
    expect(await removed.json()).toMatchObject({ tokenSet: false, tokenLast4: null });
  });

  test('switching to GitLab clears the token, secret and URL; GitLab paths may nest groups', async () => {
    await t.request('PATCH', '/api/v1/projects/web/integration', {
      as: admin,
      json: { token: 'ghp_x_1234', webhookSecret: 'a-secret-of-16-chars', repository: 'acme/shop' },
    });
    const res = await t.request('PATCH', '/api/v1/projects/web/integration', {
      as: admin,
      json: { provider: 'gitlab', repository: 'group/sub/shop' },
    });
    expect(await res.json()).toMatchObject({
      provider: 'gitlab',
      baseUrl: 'https://gitlab.com',
      repository: 'group/sub/shop',
      tokenSet: false,
      webhookSecretSet: false,
      webhookUrl: `${PUBLIC_URL}/api/v1/integrations/gitlab/webhook`,
    });
    const github = await t.request('PATCH', '/api/v1/projects/web/integration', {
      as: admin,
      json: { provider: 'github', repository: 'group/sub/shop' },
    });
    expect((await problemOf(github)).errors?.[0]?.path).toBe('repository');
  });

  test('refuses a non-http URL, and auto-promote without repository and secret', async () => {
    const ftp = await t.request('PATCH', '/api/v1/projects/web/integration', {
      as: admin,
      json: { baseUrl: 'ftp://github.example.com' },
    });
    expect((await problemOf(ftp)).errors?.[0]?.path).toBe('baseUrl');
    const auto = await problemOf(
      await t.request('PATCH', '/api/v1/projects/web/integration', { as: admin, json: { autoPromote: true } }),
    );
    expect(auto.errors?.map((e) => e.path).sort()).toEqual(['repository', 'webhookSecret']);
  });

  test('only admins: reviewers and project tokens get 403', async () => {
    const reviewer = await t.userAs('reviewer');
    const { token } = await t.tokenAs('web', ['read', 'write', 'review']);
    for (const as of [reviewer, { token }]) {
      expect((await t.request('GET', '/api/v1/projects/web/integration', { as })).status).toBe(403);
      expect((await t.request('GET', '/api/v1/projects/web/webhooks', { as })).status).toBe(403);
    }
  });

  test('webhooks: the generated secret is returned once; deliveries and Send test', async () => {
    const receiver = startReceiver();
    try {
      const created = await t.request('POST', '/api/v1/projects/web/webhooks', {
        as: admin,
        json: { url: receiver.url, events: ['check.reviewed', 'build.finalized'] },
      });
      expect(created.status).toBe(201);
      const hook = (await created.json()) as { id: string; secret: string; events: string[]; secretLast4: string };
      expect(hook.secret).toMatch(/^whsec_/);
      expect(hook.events).toEqual(['build.finalized', 'check.reviewed']);
      expect(hook.secretLast4).toBe(hook.secret.slice(-4));
      const listed = await (await t.request('GET', '/api/v1/projects/web/webhooks', { as: admin })).text();
      expect(listed).not.toContain(hook.secret);

      const sent = await t.request('POST', `/api/v1/projects/web/webhooks/${hook.id}/test`, { as: admin });
      expect(await sent.json()).toMatchObject({ event: 'ping', state: 'delivered', statusCode: 200, attempts: 1 });
      const [ping] = receiver.received;
      expect(ping?.headers['x-pixeltwin-signature']).toBe(`sha256=${hmacSha256Hex(hook.secret, ping?.body ?? '')}`);
      expect(JSON.parse(ping?.body ?? '{}')).toMatchObject({ event: 'ping', project: { slug: 'web' } });

      const patched = await t.request('PATCH', `/api/v1/projects/web/webhooks/${hook.id}`, {
        as: admin,
        json: { format: 'slack', enabled: false },
      });
      expect(await patched.json()).toMatchObject({ format: 'slack', enabled: false });
      const deliveries = await (
        await t.request('GET', `/api/v1/projects/web/webhooks/${hook.id}/deliveries`, { as: admin })
      ).json();
      expect(deliveries.items).toHaveLength(1);
      expect((await t.request('DELETE', `/api/v1/projects/web/webhooks/${hook.id}`, { as: admin })).status).toBe(204);
      expect((await t.request('GET', `/api/v1/projects/web/webhooks/${hook.id}`, { as: admin })).status).toBe(404);
    } finally {
      receiver.stop();
    }
  });

  test('webhook URLs must be http(s) without credentials; link-local addresses fail when sent', async () => {
    for (const url of ['file:///etc/passwd', 'gopher://x', 'https://u:p@example.com/hook']) {
      const res = await t.request('POST', '/api/v1/projects/web/webhooks', {
        as: admin,
        json: { url, events: ['build.finalized'] },
      });
      expect((await problemOf(res)).errors?.[0]?.path).toBe('url');
    }
    const { id } = await (
      await t.request('POST', '/api/v1/projects/web/webhooks', {
        as: admin,
        json: { url: 'http://169.254.169.254/latest/meta-data', events: ['build.finalized'] },
      })
    ).json();
    const sent = await (await t.request('POST', `/api/v1/projects/web/webhooks/${id}/test`, { as: admin })).json();
    expect(sent).toMatchObject({ state: 'failed', statusCode: null });
    expect(sent.error).toContain('link-local');
  });
});

describe('builds reach GitHub through the API', () => {
  let t: TestApp;
  let gh: FakeGitHub;

  beforeAll(() => {
    gh = startFakeGitHub();
  });

  afterAll(() => {
    gh.stop();
  });

  beforeEach(async () => {
    t = await createTestApp();
  });

  afterEach(async () => {
    await t.close();
  });

  test('finalize posts pending; approving in pixeltwin turns the commit green without a CI run', async () => {
    const admin = await t.userAs('admin');
    await t.request('POST', '/api/v1/projects', { as: admin, json: { slug: 'web', name: 'Web' } });
    await t.request('PATCH', '/api/v1/projects/web/integration', {
      as: admin,
      json: { baseUrl: gh.url, token: FAKE_TOKEN, repository: 'acme/shop' },
    });
    const { token } = await t.tokenAs('web', ['read', 'write']);
    const build = await (
      await t.request('POST', '/api/v1/projects/web/builds', {
        as: { token },
        json: { branch: 'feature/login', commitSha: 'feedbeef', pullRequest: 42, repository: 'acme/shop' },
      })
    ).json();
    const check = await (
      await t.request('POST', `/api/v1/builds/${build.id}/checks`, {
        as: { token },
        json: { name: 'login', imageBase64: Buffer.from(white).toString('base64') },
      })
    ).json();
    await t.request('POST', `/api/v1/builds/${build.id}/finalize`, { as: { token } });
    await t.notifier.drain();
    expect(gh.statuses.at(-1)).toMatchObject({ sha: 'feedbeef', state: 'pending', context: 'pixeltwin/web' });
    await t.request('POST', `/api/v1/checks/${check.id}/approve`, { as: admin });
    await t.notifier.drain();
    expect(gh.statuses.at(-1)).toMatchObject({ sha: 'feedbeef', state: 'success' });
    const view = await (await t.request('GET', '/api/v1/projects/web/integration', { as: admin })).json();
    expect(view.lastSync).toMatchObject({ buildId: build.id, error: null });
  });
});

describe('inbound code host webhooks (auto-promote)', () => {
  let t: TestApp;
  let projectId: string;
  const SECRET = 'merge-secret-0123456789';

  beforeEach(async () => {
    t = await createTestApp();
    const admin = await t.userAs('admin');
    projectId = (
      await (await t.request('POST', '/api/v1/projects', { as: admin, json: { slug: 'web', name: 'Web' } })).json()
    ).id;
    await t.request('PATCH', '/api/v1/projects/web/integration', {
      as: admin,
      json: { repository: 'Acme/Shop', webhookSecret: SECRET, autoPromote: true },
    });
    // feature/login has an approved screen main does not have.
    const imageSha = await storeImage(t.deps, changed, readPngHeader(changed, t.deps.limits));
    await appendBaseline(t.deps.db, {
      projectId,
      snapshotKey: snapshotKey('login', {}),
      name: 'login',
      variant: '{}',
      branch: 'feature/login',
      imageSha,
      sourceCheckId: null,
      approvedBy: 'usr_seed',
    });
  });

  afterEach(async () => {
    await t.close();
  });

  const githubMerge = {
    action: 'closed',
    repository: { full_name: 'acme/shop' },
    pull_request: {
      number: 42,
      merged: true,
      merge_commit_sha: 'm1',
      head: { ref: 'feature/login' },
      base: { ref: 'main' },
      merged_by: { login: 'octocat' },
    },
  };

  function github(body: unknown, options: { secret?: string; event?: string; headers?: Record<string, string> } = {}) {
    const text = JSON.stringify(body);
    return t.request('POST', '/api/v1/integrations/github/webhook', {
      body: text,
      headers: {
        'content-type': 'application/json',
        'x-github-event': options.event ?? 'pull_request',
        'x-github-delivery': 'd-1',
        'x-hub-signature-256': `sha256=${hmacSha256Hex(options.secret ?? SECRET, text)}`,
        ...options.headers,
      },
    });
  }

  test('a merged pull request promotes its branch once; the actor is the GitHub merge', async () => {
    const res = await github(githubMerge);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      handled: true,
      results: [{ project: 'web', outcome: 'promoted', promoted: 1 }],
    });
    const main = await findCurrentBaseline(t.deps.db, projectId, snapshotKey('login', {}), 'main');
    expect(main?.approvedBy).toBe('github:octocat');
    const again = await (await github(githubMerge)).json();
    expect(again.results).toEqual([{ project: 'web', outcome: 'already_promoted', promoted: 1 }]);
    const merges = await t.deps.db.selectFrom('integrationMerges').selectAll().execute();
    expect(merges).toEqual([
      expect.objectContaining({ pullRequest: 42, mergedBy: 'octocat', promoted: 1, provider: 'github' }),
    ]);
  });

  test('a wrong or missing signature is 401; ping and other events are ignored', async () => {
    expect((await problemOf(await github(githubMerge, { secret: 'not-the-secret-at-all' }))).code).toBe(
      'invalid_signature',
    );
    const unsigned = await t.request('POST', '/api/v1/integrations/github/webhook', {
      json: githubMerge,
      headers: { 'x-github-event': 'pull_request' },
    });
    expect(unsigned.status).toBe(401);
    expect(await (await github({ ...githubMerge, zen: 'hi' }, { event: 'ping' })).json()).toMatchObject({
      handled: false,
      detail: 'Pong: the secret matches.',
    });
    expect((await (await github({ ...githubMerge, action: 'opened' })).json()).handled).toBe(false);
    const closed = { ...githubMerge, pull_request: { ...githubMerge.pull_request, merged: false } };
    expect((await (await github(closed)).json()).handled).toBe(false);
    expect(await findCurrentBaseline(t.deps.db, projectId, snapshotKey('login', {}), 'main')).toBeUndefined();
  });

  test('no session middleware: a stray cookie without Origin does not matter; bad JSON is 400; big bodies 413', async () => {
    const res = await github(githubMerge, { headers: { cookie: 'pt_session=whatever' } });
    expect(res.status).toBe(200);
    const bad = await t.request('POST', '/api/v1/integrations/github/webhook', {
      body: '{not json',
      headers: { 'content-type': 'application/json' },
    });
    expect((await problemOf(bad)).code).toBe('bad_request');
    const big = await t.request('POST', '/api/v1/integrations/github/webhook', {
      body: JSON.stringify({ padding: 'x'.repeat(1_100_000) }),
      headers: { 'content-type': 'application/json' },
    });
    expect(big.status).toBe(413);
  });

  test('auto-promote off: verified, nothing promoted', async () => {
    const admin = await t.userAs('admin');
    await t.request('PATCH', '/api/v1/projects/web/integration', { as: admin, json: { autoPromote: false } });
    expect((await (await github(githubMerge)).json()).results).toEqual([
      { project: 'web', outcome: 'auto_promote_off', promoted: 0 },
    ]);
  });

  test('GitLab: a merged merge request promotes its source branch; X-Gitlab-Token must match', async () => {
    const admin = await t.userAs('admin');
    await t.request('PATCH', '/api/v1/projects/web/integration', {
      as: admin,
      json: { provider: 'gitlab', repository: 'group/sub/shop', webhookSecret: SECRET, autoPromote: true },
    });
    const merge = {
      object_kind: 'merge_request',
      user: { username: 'tanuki' },
      project: { path_with_namespace: 'group/sub/shop' },
      object_attributes: { iid: 7, action: 'merge', source_branch: 'feature/login', target_branch: 'main' },
    };
    const send = (body: unknown, token: string) =>
      t.request('POST', '/api/v1/integrations/gitlab/webhook', {
        json: body,
        headers: { 'x-gitlab-event': 'Merge Request Hook', 'x-gitlab-token': token },
      });
    expect((await send(merge, 'wrong-token-wrong-token')).status).toBe(401);
    const opened = { ...merge, object_attributes: { ...merge.object_attributes, action: 'open' } };
    expect((await (await send(opened, SECRET)).json()).handled).toBe(false);
    expect((await (await send(merge, SECRET)).json()).results).toEqual([
      { project: 'web', outcome: 'promoted', promoted: 1 },
    ]);
    const main = await findCurrentBaseline(t.deps.db, projectId, snapshotKey('login', {}), 'main');
    expect(main?.approvedBy).toBe('gitlab:tanuki');
    expect((await (await send(merge, SECRET)).json()).results[0].outcome).toBe('already_promoted');
  });
});
