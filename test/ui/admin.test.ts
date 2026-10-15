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

  test('admins manage users; the last admin is protected', async () => {
    const created = await postForm(
      t,
      '/ui/admin/users',
      { email: 'ada@example.com', password: PASSWORD, role: 'reviewer' },
      admin,
    );
    expect(location(created)).toBe('/ui/admin/users?done=user-created');
    const ada = (await listUsers(t.deps)).find((u) => u.email === 'ada@example.com');
    expect(ada?.role).toBe('reviewer');

    expect(location(await postForm(t, `/ui/admin/users/${ada?.id}`, { role: 'viewer' }, admin))).toBe(
      '/ui/admin/users?done=user-saved',
    );
    const last = await postForm(t, `/ui/admin/users/${admin.id}/delete`, {}, admin);
    expect(last.status).toBe(409);
    expect(await html(last)).toContain('last admin');

    const short = await postForm(
      t,
      '/ui/admin/users',
      { email: 'bob@example.com', password: 'short', role: 'viewer' },
      admin,
    );
    expect(short.status).toBe(422);
    expect(await html(short)).toContain('password: Use at least 10 characters');
  });

  test('non-admins cannot open admin pages', async () => {
    const reviewer = await t.userAs('reviewer');
    expect((await t.request('GET', '/ui/admin/users', { as: reviewer })).status).toBe(403);
    await postForm(t, '/ui/projects', { name: 'Web', slug: 'web' }, admin);
    expect((await t.request('GET', '/ui/p/web/settings', { as: reviewer })).status).toBe(403);
    expect((await postForm(t, '/ui/p/web/settings/delete', {}, reviewer)).status).toBe(403);
  });

  test('project settings, a token shown once, and revocation', async () => {
    await postForm(t, '/ui/projects', { name: 'Web', slug: 'web' }, admin);
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

    const created = await postForm(
      t,
      '/ui/p/web/settings/tokens',
      { name: 'GitHub', scopes: ['read', 'write'] },
      admin,
    );
    expect(created.status).toBe(201);
    const page = await html(created);
    const token = /pt_[0-9A-Za-z]{8}_[0-9A-Za-z]{32}/.exec(page)?.[0] ?? '';
    expect(await resolveProjectToken(t.deps, token)).toMatchObject({ scopes: ['read', 'write'] });

    const later = await html(await t.request('GET', '/ui/p/web/settings', { as: admin }));
    expect(later).not.toContain(token);
    expect(later).toContain(`${token.slice(0, 12)}…`);

    const id = /\/ui\/p\/web\/settings\/tokens\/(tok_[0-9A-Z]+)\/delete/.exec(later)?.[1];
    expect(location(await postForm(t, `/ui/p/web/settings/tokens/${id}/delete`, {}, admin))).toBe(
      '/ui/p/web/settings?done=token-revoked',
    );
    expect(await resolveProjectToken(t.deps, token)).toBeNull();
  });

  test('deleting a project from settings', async () => {
    await postForm(t, '/ui/projects', { name: 'Web', slug: 'web' }, admin);
    expect(location(await postForm(t, '/ui/p/web/settings/delete', {}, admin))).toBe('/ui?done=project-deleted');
    expect(await listProjects(t.deps)).toEqual([]);
  });
});
