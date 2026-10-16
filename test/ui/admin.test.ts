import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { resolveProjectToken } from '../../src/domain/auth/tokens';
import { listUsers } from '../../src/domain/auth/users';
import { getProjectBySlug, listProjects } from '../../src/domain/projects';
import { createTestApp, PASSWORD, type TestApp } from '../helpers/app';
import { html, location, postForm } from '../helpers/ui';

describe('UI administration', () => {
  let t: TestApp;
  let admin: { cookie: string; id: string };

  beforeEach(async () => {
    t = await createTestApp();
    admin = await t.userAs('admin', 'root@example.com');
  });

  afterEach(async () => {
    await t.close();
  });

  const get = async (path: string, as = admin) => html(await t.request('GET', path, { as }));

  describe('users', () => {
    test('admins add users from a dialog that is also a page without JavaScript', async () => {
      const page = await get('/ui/admin/users');
      expect(page).toContain('href="/ui/admin/users/new" data-dialog-open="new-user"');
      expect(page).toMatch(/<dialog id="new-user"[^>]*>[\s\S]*action="\/ui\/admin\/users"/);
      expect(await get('/ui/admin/users/new')).toContain('action="/ui/admin/users"');
      // The hint under Role explains the chosen role; each option carries its own text for the switch.
      const form = await get('/ui/admin/users/new');
      expect(form).toContain('<p class="hint" id="user-role-hint">Sees every project, build and screenshot');
      expect(form).toContain('data-hint-from-option="true"');
      expect(form).toMatch(/<option value="reviewer" data-hint="Approves or rejects changes/);
      expect(form).toMatch(/<option value="admin" data-hint="Manages everything/);

      const created = await postForm(
        t,
        '/ui/admin/users',
        { email: 'ada@example.com', password: PASSWORD, role: 'reviewer' },
        admin,
      );
      expect(location(created)).toBe('/ui/admin/users?done=user-created');
      expect((await listUsers(t.deps)).find((u) => u.email === 'ada@example.com')?.role).toBe('reviewer');
    });

    test('mistakes in a new user are shown next to the field', async () => {
      const short = await postForm(
        t,
        '/ui/admin/users',
        { email: 'bob@example.com', password: 'short', role: 'viewer' },
        admin,
      );
      expect(short.status).toBe(422);
      const page = await html(short);
      expect(page).toContain('Use at least 10 characters');
      expect(page).toMatch(/id="user-password"[^>]*aria-invalid="true"|aria-invalid="true"[^>]*id="user-password"/);
      expect(page).toContain('value="bob@example.com"');
    });

    test('roles save on change with JavaScript, with a Save button without it; you are marked', async () => {
      const ada = await postForm(
        t,
        '/ui/admin/users',
        { email: 'ada@example.com', password: PASSWORD, role: 'viewer' },
        admin,
      );
      expect(ada.status).toBe(303);
      const page = await get('/ui/admin/users');
      expect(page).toContain('data-autosubmit');
      expect(page).toContain('class="no-js"');
      expect(page).toContain('<span class="you">you</span>');
      const id = (await listUsers(t.deps)).find((u) => u.email === 'ada@example.com')?.id;
      expect(location(await postForm(t, `/ui/admin/users/${id}`, { role: 'reviewer' }, admin))).toBe(
        '/ui/admin/users?done=user-saved',
      );
    });

    test('the last admin cannot be deleted', async () => {
      const last = await postForm(t, `/ui/admin/users/${admin.id}/delete`, {}, admin);
      expect(last.status).toBe(409);
      expect(await html(last)).toContain('last admin');
    });

    test('non-admins cannot open admin pages', async () => {
      const reviewer = await t.userAs('reviewer');
      expect((await t.request('GET', '/ui/admin/users', { as: reviewer })).status).toBe(403);
      expect((await t.request('GET', '/ui/admin/users/new', { as: reviewer })).status).toBe(403);
      await postForm(t, '/ui/projects', { name: 'Web', slug: 'web' }, admin);
      expect((await t.request('GET', '/ui/p/web/settings', { as: reviewer })).status).toBe(403);
      expect((await t.request('GET', '/ui/p/web/settings/tokens/new', { as: reviewer })).status).toBe(403);
      expect((await postForm(t, '/ui/p/web/settings/delete', {}, reviewer)).status).toBe(403);
    });
  });

  describe('project settings', () => {
    beforeEach(async () => {
      await postForm(t, '/ui/projects', { name: 'Web', slug: 'web' }, admin);
    });

    test('settings are a tab of the project, with help next to each field', async () => {
      const page = await get('/ui/p/web/settings');
      expect(page).toContain('aria-current="page">Settings</a>');
      expect(page).toContain('Pixels whose colour differs by less than this count as equal');
      expect(page).toContain('data-islands="tokens"');
    });

    test('settings save, and invalid values are shown next to their field', async () => {
      const saved = await postForm(
        t,
        '/ui/p/web/settings',
        { name: 'Web shop', mainBranch: 'trunk', colorThreshold: '0.2', tolerancePercent: '0.5', retentionDays: '30' },
        admin,
      );
      expect(location(saved)).toBe('/ui/p/web/settings?done=project-saved');
      expect(await getProjectBySlug(t.deps, 'web')).toMatchObject({
        name: 'Web shop',
        mainBranch: 'trunk',
        colorThreshold: 0.2,
        tolerancePercent: 0.5,
        retentionDays: 30,
      });

      const bad = await postForm(
        t,
        '/ui/p/web/settings',
        { name: 'Web shop', mainBranch: 'trunk', colorThreshold: '5', tolerancePercent: '0', retentionDays: '30' },
        admin,
      );
      expect(bad.status).toBe(422);
      const page = await html(bad);
      expect(page).toMatch(
        /id="settings-colorThreshold"[^>]*aria-invalid="true"|aria-invalid="true"[^>]*id="settings-colorThreshold"/,
      );
      expect(page).toContain('value="5"');
    });

    test('a new token is shown once with Copy and the line for CI; later only its prefix', async () => {
      const page = await get('/ui/p/web/settings');
      expect(page).toContain('href="/ui/p/web/settings/tokens/new" data-dialog-open="new-token"');
      expect(page).toMatch(/<dialog id="new-token"[^>]*>[\s\S]*data-token-form/);
      expect(await get('/ui/p/web/settings/tokens/new')).toContain('action="/ui/p/web/settings/tokens"');

      const created = await postForm(
        t,
        '/ui/p/web/settings/tokens',
        { name: 'GitHub', scopes: ['read', 'write'] },
        admin,
      );
      expect(created.status).toBe(201);
      const shown = await html(created);
      const token = /pt_[0-9A-Za-z]{8}_[0-9A-Za-z]{32}/.exec(shown)?.[0] ?? '';
      expect(await resolveProjectToken(t.deps, token)).toMatchObject({ scopes: ['read', 'write'] });
      expect(shown).toContain(`<code id="new-token-value">${token}</code>`);
      expect(shown).toContain('data-copy-from="new-token-value"');
      expect(shown).toContain('This is the only time the full token is shown');
      expect(shown).toContain(`export PIXELTWIN_TOKEN=${token}`);

      const later = await get('/ui/p/web/settings');
      expect(later).not.toContain(token);
      expect(later).toContain(`${token.slice(0, 12)}…`);
      const id = /\/ui\/p\/web\/settings\/tokens\/(tok_[0-9A-Z]+)\/delete/.exec(later)?.[1];
      expect(location(await postForm(t, `/ui/p/web/settings/tokens/${id}/delete`, {}, admin))).toBe(
        '/ui/p/web/settings?done=token-revoked',
      );
      expect(await resolveProjectToken(t.deps, token)).toBeNull();
    });

    test('a token without a name or scopes is refused next to the field', async () => {
      const res = await postForm(t, '/ui/p/web/settings/tokens', { name: '' }, admin);
      expect(res.status).toBe(422);
      expect(await html(res)).toContain('class="field-error"');
    });

    test('the onboarding token step opens the same dialog', async () => {
      const page = await get('/ui/p/web');
      expect(page).toContain('href="/ui/p/web/settings/tokens/new" data-dialog-open="new-token"');
      expect(page).toMatch(/<dialog id="new-token"/);
    });

    test('deleting a project from settings', async () => {
      expect(location(await postForm(t, '/ui/p/web/settings/delete', {}, admin))).toBe('/ui?done=project-deleted');
      expect(await listProjects(t.deps)).toEqual([]);
    });
  });
});
