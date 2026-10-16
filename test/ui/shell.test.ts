import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createProject } from '../../src/domain/projects';
import { createTestApp, type TestApp } from '../helpers/app';
import { html, location, postForm } from '../helpers/ui';

describe('UI shell and theme', () => {
  let t: TestApp;
  let admin: { cookie: string; id: string };
  let reviewer: { cookie: string; id: string };

  beforeEach(async () => {
    t = await createTestApp();
    await createProject(t.deps, { slug: 'web', name: 'Web shop' });
    admin = await t.userAs('admin', 'boss@example.com');
    reviewer = await t.userAs('reviewer', 'rev@example.com');
  });

  afterEach(async () => {
    await t.close();
  });

  // The request helper would replace a cookie header, so both cookies are set by hand.
  const withTheme = (as: { cookie: string }, theme: string) => ({
    headers: { cookie: `pt_session=${as.cookie}; pt_theme=${encodeURIComponent(theme)}` },
  });

  test('pages render the light theme unless the theme cookie says otherwise', async () => {
    expect(await html(await t.request('GET', '/ui', { as: admin }))).toContain('<html lang="en" data-theme="light">');
    const dark = await html(await t.request('GET', '/ui', withTheme(admin, 'dark')));
    expect(dark).toContain('<html lang="en" data-theme="dark">');
    const system = await html(await t.request('GET', '/ui', withTheme(admin, 'system')));
    expect(system).toContain('<html lang="en" data-theme="system">');
    const junk = await html(await t.request('GET', '/ui', withTheme(admin, '"><script>')));
    expect(junk).toContain('<html lang="en" data-theme="light">');
  });

  test('the theme form stores the choice for a year and returns to the page it came from', async () => {
    const res = await postForm(t, '/ui/theme', { theme: 'dark', next: '/ui/p/web?branch=main' }, admin);
    expect(res.status).toBe(303);
    expect(location(res)).toBe('/ui/p/web?branch=main');
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toContain('pt_theme=dark');
    expect(cookie).toContain('Max-Age=31536000');
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).not.toContain('HttpOnly');
  });

  test('the theme form refuses unknown themes and never redirects off the UI', async () => {
    expect((await postForm(t, '/ui/theme', { theme: 'neon', next: '/ui' }, admin)).status).toBe(422);
    const offsite = await postForm(t, '/ui/theme', { theme: 'light', next: 'https://evil.example/' }, admin);
    expect(location(offsite)).toBe('/ui');
  });

  test('the user menu offers themes, API docs and log out; Users only to admins', async () => {
    const forAdmin = await html(await t.request('GET', '/ui', { as: admin }));
    expect(forAdmin).toContain('boss@example.com');
    expect(forAdmin).toContain('action="/ui/theme"');
    for (const theme of ['light', 'dark', 'system']) expect(forAdmin).toContain(`name="theme" value="${theme}"`);
    expect(forAdmin).toContain('name="theme" value="light" aria-pressed="true"');
    expect(forAdmin).toContain('href="/docs"');
    expect(forAdmin).toContain('href="/ui/admin/users"');
    expect(forAdmin).toContain('action="/ui/logout"');

    const forReviewer = await html(await t.request('GET', '/ui', { as: reviewer }));
    expect(forReviewer).toContain('rev@example.com');
    expect(forReviewer).not.toContain('href="/ui/admin/users"');
  });

  test('every page has a skip link to the main content and the wordmark linking home', async () => {
    const page = await html(await t.request('GET', '/ui', { as: admin }));
    expect(page).toContain('<a class="skip-link" href="#main">Skip to content</a>');
    expect(page).toContain('<main id="main"');
    expect(page).toMatch(/<a class="brand" href="\/ui">[\s\S]*pixeltwin/);
  });

  test('the ⌘K button waits hidden until the palette starts; the body says who is looking', async () => {
    const page = await html(await t.request('GET', '/ui', { as: admin }));
    expect(page).toMatch(/<button[^>]*data-palette-open[^>]*hidden/);
    expect(page).toContain('data-role="admin"');
    expect(await html(await t.request('GET', '/ui/p/web', { as: reviewer }))).toContain('data-project="web"');
  });

  test('the login page has no user menu', async () => {
    const page = await html(await t.request('GET', '/ui/login'));
    expect(page).not.toContain('action="/ui/logout"');
    expect(page).not.toContain('action="/ui/theme"');
  });

  test('the stylesheet defines both themes and follows the system in system mode', async () => {
    const css = await (await t.request('GET', '/ui/assets/app.css')).text();
    expect(css).toContain('[data-theme="dark"]');
    expect(css).toMatch(/@media \(prefers-color-scheme: dark\)\s*\{\s*\[data-theme="system"\]/);
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    expect(css).toContain('.skip-link');
  });
});
