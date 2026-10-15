import { afterEach, describe, expect, test } from 'bun:test';
import { createProject } from '../../src/domain/projects';
import { UI_CSP } from '../../src/ui/session';
import { createTestApp, PASSWORD, type TestApp } from '../helpers/app';
import { html, location, postForm } from '../helpers/ui';

describe('UI authentication', () => {
  let t: TestApp;

  afterEach(async () => {
    await t.close();
  });

  test('logged-out visitors are sent to the login page with a return path', async () => {
    t = await createTestApp();
    expect(location(await t.request('GET', '/'))).toBe('/ui');
    const res = await t.request('GET', '/ui/builds/bld_x?review=pending');
    expect(res.status).toBe(303);
    expect(location(res)).toBe('/ui/login?next=%2Fui%2Fbuilds%2Fbld_x%3Freview%3Dpending');
    const page = await html(await t.request('GET', '/ui/login?next=%2Fui%2Fbuilds%2Fbld_x'));
    expect(page).toContain('name="next" value="/ui/builds/bld_x"');
  });

  test('login sets the session cookie and returns to the page', async () => {
    t = await createTestApp();
    await t.userAs('viewer', 'ada@example.com');
    const bad = await postForm(t, '/ui/login', { email: 'ada@example.com', password: 'wrong password', next: '/ui' });
    expect(bad.status).toBe(401);
    expect(await html(bad)).toContain('The email or password is wrong.');

    const ok = await postForm(t, '/ui/login', { email: 'ADA@example.com', password: PASSWORD, next: '/ui/p/web' });
    expect(ok.status).toBe(303);
    expect(location(ok)).toBe('/ui/p/web');
    expect(ok.headers.get('set-cookie')).toContain('HttpOnly');
  });

  test('the return path cannot leave the UI', async () => {
    t = await createTestApp();
    await t.userAs('viewer', 'ada@example.com');
    const attempts = [
      '//evil.example',
      'https://evil.example',
      '/api/v1/users',
      '/\\evil.example',
      '/uinot',
      '/ui/../api/v1/users',
      '/ui/%2e%2e/api',
      '/ui/../..//evil.example',
      '/ui/\nx',
    ];
    for (const next of attempts) {
      const res = await postForm(t, '/ui/login', { email: 'ada@example.com', password: PASSWORD, next });
      expect({ next, to: location(res) }).toEqual({ next, to: '/ui' });
    }
  });

  test('first-run setup creates the admin and logs them in', async () => {
    t = await createTestApp({ setupToken: 'setup-secret' });
    expect(location(await t.request('GET', '/ui/login'))).toBe('/ui/setup');
    expect(await html(await t.request('GET', '/ui/setup?token=setup-secret'))).toContain('value="setup-secret"');

    const wrong = await postForm(t, '/ui/setup', { token: 'nope', email: 'root@example.com', password: PASSWORD });
    expect(wrong.status).toBe(403);
    expect(await html(wrong)).toContain('The setup token is wrong.');

    const ok = await postForm(t, '/ui/setup', { token: 'setup-secret', email: 'root@example.com', password: PASSWORD });
    expect(location(ok)).toBe('/ui?done=welcome');
    const cookie = /pt_session=([^;]+)/.exec(ok.headers.get('set-cookie') ?? '')?.[1] ?? '';
    const me = await t.request('GET', '/api/v1/me', { as: { cookie } });
    expect(await me.json()).toMatchObject({ email: 'root@example.com', role: 'admin' });
    expect(location(await t.request('GET', '/ui/setup'))).toBe('/ui/login');
  });

  test('logout ends the session', async () => {
    t = await createTestApp();
    const admin = await t.userAs('admin');
    expect(location(await postForm(t, '/ui/logout', {}, admin))).toBe('/ui/login');
    expect((await t.request('GET', '/ui', { as: admin })).status).toBe(303);
  });

  test('forms from another site are refused', async () => {
    t = await createTestApp();
    const admin = await t.userAs('admin');
    const res = await t.request('POST', '/ui/projects', {
      as: admin,
      body: 'slug=web&name=Web',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://evil.example' },
    });
    expect(res.status).toBe(403);
    expect(await html(res)).toContain('Forms must be submitted from');
  });

  test('pages carry a strict CSP; assets are served; unknown pages are HTML 404s', async () => {
    t = await createTestApp();
    const admin = await t.userAs('admin');
    const page = await t.request('GET', '/ui', { as: admin });
    expect(page.headers.get('content-security-policy')).toBe(UI_CSP);
    expect(page.headers.get('x-frame-options')).toBe('DENY');
    expect((await html(page)).startsWith('<!doctype html>')).toBe(true);
    const css = await t.request('GET', '/ui/assets/app.css');
    expect(css.headers.get('content-type')).toStartWith('text/css');
    expect(await css.text()).toContain('--primary');
    expect((await t.request('GET', '/ui/assets/app.js')).headers.get('content-type')).toStartWith('text/javascript');
    const missing = await t.request('GET', '/ui/nowhere', { as: admin });
    expect(missing.status).toBe(404);
    expect(await html(missing)).toContain('Not found');
  });

  test('asset URLs carry a content hash, so upgrades are never served from a stale cache', async () => {
    t = await createTestApp();
    const page = await html(await t.request('GET', '/ui/login'));
    const css = /href="(\/ui\/assets\/app\.css\?v=[0-9a-f]{12})"/.exec(page)?.[1];
    const js = /src="(\/ui\/assets\/app\.js\?v=[0-9a-f]{12})"/.exec(page)?.[1];
    expect(css).toBeDefined();
    expect(js).toBeDefined();
    const res = await t.request('GET', css ?? '');
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
  });

  test('asset responses never carry the session cookie, even when the session is due for refresh', async () => {
    t = await createTestApp();
    const admin = await t.userAs('admin');
    await t.deps.db
      .updateTable('sessions')
      .set({ expiresAt: Date.now() + 13 * 24 * 60 * 60 * 1000 })
      .execute();
    const page = await html(await t.request('GET', '/ui/login'));
    const css = /href="(\/ui\/assets\/app\.css\?v=[0-9a-f]{12})"/.exec(page)?.[1] ?? '';
    const res = await t.request('GET', css, { as: admin });
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  test('only the current asset version is cached as immutable', async () => {
    t = await createTestApp();
    for (const path of ['/ui/assets/app.css?v=deadbeef0000', '/ui/assets/app.css', '/ui/assets/app.js?v=0']) {
      const res = await t.request('GET', path);
      expect({ path, cache: res.headers.get('cache-control') }).toEqual({ path, cache: 'no-store' });
    }
  });

  test('oversized form posts are refused before they are parsed', async () => {
    t = await createTestApp();
    const res = await postForm(t, '/ui/login', { email: 'a@example.com', password: 'x'.repeat(2 * 1024 * 1024) });
    expect(res.status).toBe(413);
    expect(await html(res)).toContain('Payload too large');
  });

  test('project tokens do not open the UI', async () => {
    t = await createTestApp();
    await createProject(t.deps, { slug: 'web', name: 'Web' });
    const token = await t.tokenAs('web', ['read', 'write', 'review']);
    expect((await t.request('GET', '/ui', { as: token })).status).toBe(303);
  });
});
