import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { getIntegration } from '../../src/domain/integrations';
import { createTestApp, type TestApp } from '../helpers/app';
import { startReceiver } from '../helpers/fake-hosts';
import { html, location, postForm } from '../helpers/ui';

describe('UI: pull requests and webhooks settings', () => {
  let t: TestApp;
  let admin: { cookie: string; id: string };

  beforeEach(async () => {
    t = await createTestApp();
    admin = await t.userAs('admin');
    await t.request('POST', '/api/v1/projects', { as: admin, json: { slug: 'web', name: 'Web' } });
  });

  afterEach(async () => {
    await t.close();
  });

  const get = async (path: string, as: { cookie: string } = admin) => html(await t.request('GET', path, { as }));

  test('the settings page has the code host form, says secrets are unencrypted and where to point the webhook', async () => {
    const page = await get('/ui/p/web/settings');
    expect(page).toContain('id="integration-title">Pull requests</h2>');
    expect(page).toContain('Tokens and secrets are stored unencrypted');
    expect(page).toContain('<option value="gitlab" data-hint="Token: a project access token');
    expect(page).toContain('http://pixeltwin.test/api/v1/integrations/github/webhook');
    expect(page).toContain('id="webhooks-title">Webhooks</h2>');
    expect(page).toContain('No webhooks yet.');
  });

  test('saving GitLab with a token keeps the token out of the page', async () => {
    const res = await postForm(
      t,
      '/ui/p/web/settings/integration',
      {
        provider: 'gitlab',
        repository: 'group/sub/shop',
        // The field still showed GitHub's default: it means "the default", so GitLab's.
        baseUrl: 'https://api.github.com',
        token: 'glpat-secret-value-wxyz',
        commitStatus: 'on',
        prComment: 'on',
      },
      admin,
    );
    expect(res.status).toBe(303);
    expect(location(res)).toBe('/ui/p/web/settings?done=integration-saved#integration-title');
    expect(await getIntegration(t.deps, 'web')).toMatchObject({
      provider: 'gitlab',
      baseUrl: 'https://gitlab.com',
      repository: 'group/sub/shop',
      tokenLast4: 'wxyz',
      autoPromote: false,
    });
    const page = await get('/ui/p/web/settings?done=integration-saved');
    expect(page).toContain('Pull request settings saved.');
    expect(page).toContain('Set, ends in wxyz. Leave empty to keep it.');
    expect(page).not.toContain('glpat-secret-value');
    expect(page).toContain('http://pixeltwin.test/api/v1/integrations/gitlab/webhook');
    expect(page).toContain('Remove GitLab integration');

    // Saving again without a token keeps it.
    await postForm(t, '/ui/p/web/settings/integration', { provider: 'gitlab', repository: 'group/sub/shop' }, admin);
    expect((await getIntegration(t.deps, 'web')).tokenSet).toBe(true);
  });

  test('promote on merge without a secret shows the error in the form', async () => {
    const res = await postForm(
      t,
      '/ui/p/web/settings/integration',
      { provider: 'github', repository: 'acme/shop', autoPromote: 'on' },
      admin,
    );
    expect(res.status).toBe(422);
    const page = await html(res);
    expect(page).toContain('Auto-promote needs the webhook&#39;s secret');
    expect(page).toMatch(/name="autoPromote" checked/);
  });

  test('a webhook: added with a generated secret shown once, tested, listed with its delivery', async () => {
    const receiver = startReceiver();
    try {
      expect(await get('/ui/p/web/settings/webhooks/new')).toContain('action="/ui/p/web/settings/webhooks"');
      const created = await postForm(
        t,
        '/ui/p/web/settings/webhooks',
        { url: receiver.url, events: ['build.finalized', 'check.reviewed'], format: 'slack' },
        admin,
      );
      expect(created.status).toBe(201);
      const page = await html(created);
      const secret = /id="new-webhook-secret">(whsec_[0-9A-Za-z]+)</.exec(page)?.[1];
      expect(secret).toBeDefined();
      const id = /action="\/ui\/p\/web\/settings\/webhooks\/(whk_[^/"]+)\/test"/.exec(page)?.[1] ?? '';

      const tested = await postForm(t, `/ui/p/web/settings/webhooks/${id}/test`, {}, admin);
      expect(location(tested)).toBe(`/ui/p/web/settings/webhooks/${id}?done=webhook-test-ok`);
      const after = await get(`/ui/p/web/settings/webhooks/${id}?done=webhook-test-ok`);
      expect(after).toContain('Test delivered.');
      expect(after).toContain('delivered · 200');
      expect(after).not.toContain(secret ?? 'unreachable');
      expect(JSON.parse(receiver.received[0]?.body ?? '{}').text).toContain('test message');

      const settings = await get('/ui/p/web/settings');
      expect(settings).toContain(receiver.url);
      expect(settings).toContain('build.finalized, check.reviewed');

      const saved = await postForm(
        t,
        `/ui/p/web/settings/webhooks/${id}`,
        { url: receiver.url, events: ['build.verdict_changed'], format: 'json' },
        admin,
      );
      expect(location(saved)).toBe(`/ui/p/web/settings/webhooks/${id}?done=webhook-saved`);
      // The On box was not sent: the webhook is off now.
      expect(await get(`/ui/p/web/settings/webhooks/${id}`)).toContain('<input type="checkbox" name="enabled"/>');
      expect(await get('/ui/p/web/settings')).toContain('<span class="pill tone-grey">off</span>');

      const deleted = await postForm(t, `/ui/p/web/settings/webhooks/${id}/delete`, {}, admin);
      expect(location(deleted)).toBe('/ui/p/web/settings?done=webhook-deleted#webhooks-title');
    } finally {
      receiver.stop();
    }
  });

  test('a failed test is an error; bad URLs are refused in the form', async () => {
    const bad = await postForm(
      t,
      '/ui/p/web/settings/webhooks',
      { url: 'ftp://x', events: ['build.finalized'] },
      admin,
    );
    expect(bad.status).toBe(422);
    expect(await html(bad)).toContain('Only http:// and https:// URLs can be used');
    const created = await html(
      await postForm(
        t,
        '/ui/p/web/settings/webhooks',
        { url: 'http://127.0.0.1:9/nothing-listens', events: ['build.finalized'] },
        admin,
      ),
    );
    const id = /webhooks\/(whk_[^/"]+)\/test/.exec(created)?.[1] ?? '';
    const tested = await postForm(t, `/ui/p/web/settings/webhooks/${id}/test`, {}, admin);
    const page = await get(location(tested));
    expect(page).toContain('class="flash error"');
    expect(page).toContain('could not connect');
  });

  test('reviewers cannot open or post these pages', async () => {
    const reviewer = await t.userAs('reviewer');
    expect((await t.request('GET', '/ui/p/web/settings/webhooks/new', { as: reviewer })).status).toBe(403);
    expect((await postForm(t, '/ui/p/web/settings/integration', { provider: 'github' }, reviewer)).status).toBe(403);
  });
});
