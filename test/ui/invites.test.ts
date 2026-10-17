import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { listInvites } from '../../src/domain/invites';
import { listMembers } from '../../src/domain/members';
import { createProject } from '../../src/domain/projects';
import { createTestApp, PUBLIC_URL, type TestApp } from '../helpers/app';
import { html, location, postForm } from '../helpers/ui';

type Who = { cookie: string; id: string };
const NEW_PASSWORD = 'a brand new password';

const linkIn = (page: string, kind: 'invite' | 'reset') =>
  new RegExp(`<code id="new-link-value">${PUBLIC_URL}(/ui/${kind}/[A-Za-z0-9_-]+)</code>`).exec(page)?.[1] ?? '';

describe('UI invites', () => {
  let t: TestApp;
  let admin: Who;
  let webId: string;

  beforeEach(async () => {
    t = await createTestApp();
    webId = (await createProject(t.deps, { slug: 'web', name: 'Web shop' })).id;
    admin = await t.userAs('admin', 'root@example.com');
  });

  afterEach(async () => {
    await t.close();
  });

  test('Invite by email shows the link once; opening it creates the account and lands in the project', async () => {
    const settings = await html(await t.request('GET', '/ui/p/web/settings', { as: admin }));
    expect(settings).toContain('formaction="/ui/p/web/settings/invites"');
    const res = await postForm(t, '/ui/p/web/settings/invites', { email: 'new@example.com', role: 'reviewer' }, admin);
    expect(res.status).toBe(201);
    const page = await html(res);
    expect(page).toContain('Invite for new@example.com');
    expect(page).toContain('Send it to new@example.com yourself.');
    expect(page).toContain('<h3>Pending invites</h3>');
    const path = linkIn(page, 'invite');
    expect(path).not.toBe('');
    // Later visits list the invite, never its link.
    expect(await html(await t.request('GET', '/ui/p/web/settings', { as: admin }))).not.toContain(path);

    // A fresh browser: no cookie.
    const open = await t.request('GET', path);
    expect(open.status).toBe(200);
    expect(open.headers.get('referrer-policy')).toBe('no-referrer');
    expect(open.headers.get('cache-control')).toBe('no-store');
    const body = await html(open);
    expect(body).toContain('You are invited as new@example.com to Web shop.');
    expect(body).toContain('autocomplete="new-password"');
    const short = await postForm(t, path, { password: 'short' });
    expect(short.status).toBe(422);
    const done = await postForm(t, path, { password: NEW_PASSWORD });
    expect(location(done)).toBe('/ui/p/web?done=welcome-invite');
    const cookie = /pt_session=([^;]+)/.exec(done.headers.get('set-cookie') ?? '')?.[1] ?? '';
    expect(await html(await t.request('GET', '/ui/p/web', { as: { cookie } }))).toContain('Web shop');
    expect((await listMembers(t.deps, 'web')).map((m) => [m.email, m.role])).toEqual([['new@example.com', 'reviewer']]);

    const again = await t.request('GET', path);
    expect(again.status).toBe(410);
    expect(await html(again)).toContain('This link was already used');
  });

  test('an expired or revoked link shows a clear page; a cross-site post is refused', async () => {
    const page = await html(await postForm(t, '/ui/p/web/settings/invites', { email: 'a@example.com' }, admin));
    const path = linkIn(page, 'invite');
    expect(
      (
        await t.request('POST', path, {
          body: 'password=x',
          headers: { origin: 'https://evil.example', 'content-type': 'application/x-www-form-urlencoded' },
        })
      ).status,
    ).toBe(403);
    const form = { 'content-type': 'application/x-www-form-urlencoded' };
    // The page sends no Referer, so its own form arrives with Origin: null and Sec-Fetch-Site.
    expect((await t.request('POST', path, { body: 'password=x', headers: { ...form, origin: 'null' } })).status).toBe(
      403,
    );
    const sameSite = { ...form, origin: 'null', 'sec-fetch-site': 'same-origin' };
    expect((await t.request('POST', path, { body: 'password=short', headers: sameSite })).status).toBe(422);
    await t.deps.db
      .updateTable('authLinks')
      .set({ expiresAt: Date.now() - 1 })
      .execute();
    const expired = await t.request('GET', path);
    expect(expired.status).toBe(410);
    expect(await html(expired)).toContain('This link has expired');

    const second = await html(await postForm(t, '/ui/p/web/settings/invites', { email: 'b@example.com' }, admin));
    const [invite] = await listInvites(t.deps, webId);
    const revoked = await postForm(t, `/ui/p/web/settings/invites/${invite?.id}/delete`, {}, admin);
    expect(location(revoked)).toBe('/ui/p/web/settings?done=invite-revoked#members-title');
    const gone = await t.request('GET', linkIn(second, 'invite'));
    expect(gone.status).toBe(404);
    expect(await html(gone)).toContain('This link does not work');
    expect((await t.request('GET', '/ui/invite/not-a-token')).status).toBe(404);
  });

  test('an email with an account is added at once', async () => {
    await t.userAs('viewer', 'has@example.com', { projects: [] });
    const res = await postForm(t, '/ui/p/web/settings/invites', { email: 'has@example.com' }, admin);
    expect(location(res)).toBe('/ui/p/web/settings?done=member-had-account#members-title');
    expect((await listMembers(t.deps, 'web')).map((m) => m.email)).toEqual(['has@example.com']);
  });

  test('admins invite from the users page and give reset links', async () => {
    const users = await html(await t.request('GET', '/ui/admin/users', { as: admin }));
    expect(users).toContain('data-dialog-open="invite-user"');
    const res = await postForm(
      t,
      '/ui/admin/invites',
      { email: 'boss@example.com', role: 'reviewer', project: 'web', projectRole: 'maintainer' },
      admin,
    );
    expect(res.status).toBe(201);
    const page = await html(res);
    expect(page).toContain('boss@example.com');
    expect(page).toContain('server: reviewer');

    const ann = await t.userAs('viewer', 'ann@example.com', { projects: [] });
    const reset = await html(await postForm(t, `/ui/admin/users/${ann.id}/reset-link`, {}, admin));
    const path = linkIn(reset, 'reset');
    expect(reset).toContain('Reset link for ann@example.com');
    const form = await html(await t.request('GET', path));
    expect(form).toContain('Set a new password');
    const done = await postForm(t, path, { password: NEW_PASSWORD });
    expect(location(done)).toBe('/ui?done=password-set');
    expect((await t.request('GET', '/ui', { as: ann })).status).toBe(303);
    // A reset link does not open the invite page, and the other way round.
    expect((await t.request('GET', path.replace('/reset/', '/invite/'))).status).toBe(410);
  });
});
