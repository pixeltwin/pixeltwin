import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { addMember, listMembers } from '../../src/domain/members';
import { createProject, getProjectBySlug } from '../../src/domain/projects';
import { createTestApp, type TestApp } from '../helpers/app';
import { html, location, postForm } from '../helpers/ui';

type Who = { cookie: string; id: string };

describe('UI project members', () => {
  let t: TestApp;
  let admin: Who;
  let alice: Who;

  beforeEach(async () => {
    t = await createTestApp();
    await createProject(t.deps, { slug: 'web', name: 'Web shop' });
    await createProject(t.deps, { slug: 'docs', name: 'Docs site' });
    admin = await t.userAs('admin', 'root@example.com');
    alice = await t.userAs('reviewer', 'alice@example.com', { projects: [] });
    await t.userAs('viewer', 'bob@example.com', { projects: [] });
  });

  afterEach(async () => {
    await t.close();
  });

  const get = async (path: string, as = admin) => html(await t.request('GET', path, { as }));
  const roles = async () => (await listMembers(t.deps, 'web')).map((m) => [m.email, m.role]);

  test('admins add a user by email with a role, change it and remove them, without JavaScript', async () => {
    const page = await get('/ui/p/web/settings');
    expect(page).toContain('<h2 id="members-title">Members</h2>');
    expect(page).toContain('No members yet. Only admins can open this project.');
    expect(page).toContain('action="/ui/p/web/settings/members"');
    expect(page).toContain('<option value="" selected="">their default role</option>');

    const added = await postForm(t, '/ui/p/web/settings/members', { email: 'Alice@Example.com', role: '' }, admin);
    expect(location(added)).toBe('/ui/p/web/settings?done=member-added#members-title');
    expect(await roles()).toEqual([['alice@example.com', 'reviewer']]);
    await postForm(t, '/ui/p/web/settings/members', { email: 'bob@example.com', role: 'maintainer' }, admin);
    expect(await roles()).toEqual([
      ['alice@example.com', 'reviewer'],
      ['bob@example.com', 'maintainer'],
    ]);

    const listed = await get('/ui/p/web/settings?done=member-added');
    expect(listed).toContain('Member added.');
    expect(listed).toContain(`action="/ui/p/web/settings/members/${alice.id}" data-autosubmit`);
    expect(listed).toContain('aria-label="Role of alice@example.com"');
    expect(listed).toContain('data-confirm="Remove alice@example.com from Web shop?"');

    const saved = await postForm(t, `/ui/p/web/settings/members/${alice.id}`, { role: 'viewer' }, admin);
    expect(location(saved)).toBe('/ui/p/web/settings?done=member-saved#members-title');
    const removed = await postForm(t, `/ui/p/web/settings/members/${alice.id}/delete`, {}, admin);
    expect(location(removed)).toBe('/ui/p/web/settings?done=member-removed#members-title');
    expect(await roles()).toEqual([['bob@example.com', 'maintainer']]);
  });

  test('a mistake keeps the form and says what is wrong', async () => {
    const res = await postForm(t, '/ui/p/web/settings/members', { email: 'nobody@example.com', role: 'viewer' }, admin);
    expect(res.status).toBe(404);
    const page = await html(res);
    expect(page).toContain('No user has the email nobody@example.com');
    expect(page).toContain('value="nobody@example.com"');
    expect(page).toContain('<option value="viewer" selected="">viewer</option>');
    const admins = await postForm(t, '/ui/p/web/settings/members', { email: 'root@example.com' }, admin);
    expect(admins.status).toBe(409);
    expect(await html(admins)).toContain('already has access to every project');
  });

  test('maintainers manage their project but not their own membership, and cannot delete it', async () => {
    await addMember(t.deps, 'web', { email: 'alice@example.com', role: 'maintainer' });
    await addMember(t.deps, 'web', { email: 'bob@example.com' });
    const page = await get('/ui/p/web/settings', alice);
    expect(page).toContain('<h2 id="tokens-title">Tokens</h2>');
    expect(page).toContain('<h2 id="members-title">Members</h2>');
    expect(page).not.toContain('Danger zone');
    expect(page).toContain('data-can-manage=""');
    // Their own row: the role as text, no form, no Remove.
    expect(page).not.toContain(`action="/ui/p/web/settings/members/${alice.id}"`);
    expect(page).toContain('<span class="you">you</span>');
    expect((await postForm(t, `/ui/p/web/settings/members/${alice.id}`, { role: 'viewer' }, alice)).status).toBe(409);
    expect((await postForm(t, '/ui/p/web/settings/delete', {}, alice)).status).toBe(403);
    expect(await getProjectBySlug(t.deps, 'web')).toBeTruthy();

    const branches = await get('/ui/p/web', alice);
    expect(branches).toContain('href="/ui/p/web/settings"');
    // Another project stays hidden.
    expect((await t.request('GET', '/ui/p/docs/settings', { as: alice })).status).toBe(404);
    expect((await t.request('GET', '/ui/p/docs', { as: alice })).status).toBe(404);
  });

  test('reviewers and viewers of a project do not get its settings', async () => {
    await addMember(t.deps, 'web', { email: 'alice@example.com' });
    expect((await t.request('GET', '/ui/p/web/settings', { as: alice })).status).toBe(403);
    expect(await get('/ui/p/web', alice)).not.toContain('href="/ui/p/web/settings"');
  });

  test('visible to everyone is a setting; on, every user sees the project', async () => {
    const page = await get('/ui/p/web/settings');
    expect(page).toContain('<strong>Visible to everyone on this server</strong>');
    expect(await get('/ui', alice)).not.toContain('/ui/p/web');
    await postForm(
      t,
      '/ui/p/web/settings',
      {
        name: 'Web shop',
        mainBranch: 'main',
        colorThreshold: '0.1',
        tolerancePercent: '0',
        retentionDays: '5',
        visibleToAll: 'on',
      },
      admin,
    );
    expect((await getProjectBySlug(t.deps, 'web')).visibleToAll).toBe(true);
    expect(await get('/ui', alice)).toContain('/ui/p/web');
    expect(await get('/ui', alice)).not.toContain('/ui/p/docs');
  });

  test('the users page shows what each user can open', async () => {
    await addMember(t.deps, 'web', { email: 'alice@example.com', role: 'maintainer' });
    const page = await get('/ui/admin/users');
    expect(page).toContain('<th>Projects</th>');
    expect(page).toContain('<a href="/ui/p/web/settings#members-title">Web shop</a>');
    expect(page).toContain('maintainer</span>');
    expect(page).toContain('Every project');
    expect(page).toContain('Only projects visible to everyone');
  });
});
