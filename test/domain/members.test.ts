import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { UserRole } from '../../src/db/schema';
import { projectRoleFor, visibleProjects } from '../../src/domain/auth/access';
import { createUser, deleteUser, type UserView, updateUser } from '../../src/domain/auth/users';
import {
  addMember,
  listMembers,
  memberCandidates,
  membershipsOf,
  removeMember,
  updateMember,
} from '../../src/domain/members';
import { createProject, updateProject } from '../../src/domain/projects';
import { createTestDeps, type TestDeps } from '../helpers/deps';
import { appError } from '../helpers/errors';

const PASSWORD = 'correct horse battery';

describe('project members', () => {
  let deps: TestDeps;
  let admin: UserView;
  let alice: UserView;
  let bob: UserView;
  let webId: string;

  const principal = (u: UserView) => ({
    kind: 'user' as const,
    id: u.id,
    email: u.email,
    role: u.role,
    status: 'active' as const,
  });
  const make = (email: string, role: UserRole) => createUser(deps, { email, password: PASSWORD, role });

  beforeEach(async () => {
    deps = await createTestDeps();
    admin = await make('admin@example.com', 'admin');
    alice = await make('alice@example.com', 'reviewer');
    bob = await make('bob@example.com', 'viewer');
    webId = (await createProject(deps, { slug: 'web', name: 'Web' })).id;
    await createProject(deps, { slug: 'app', name: 'App' });
  });

  afterEach(async () => {
    await deps.handle.close();
  });

  test('adds a user by email with a role, or their global role by default', async () => {
    const member = await addMember(deps, 'web', { email: ' Alice@Example.com ', role: 'maintainer' });
    expect(member).toMatchObject({ userId: alice.id, email: 'alice@example.com', role: 'maintainer' });
    expect((await addMember(deps, 'web', { email: 'bob@example.com' })).role).toBe('viewer');
    expect((await listMembers(deps, 'web')).map((m) => [m.email, m.role])).toEqual([
      ['alice@example.com', 'maintainer'],
      ['bob@example.com', 'viewer'],
    ]);
    expect(await listMembers(deps, 'app')).toEqual([]);
  });

  test('refuses unknown users, admins, duplicates and bad roles', async () => {
    expect((await appError(addMember(deps, 'web', { email: 'nobody@example.com' }))).code).toBe('user_not_found');
    expect((await appError(addMember(deps, 'web', { email: 'admin@example.com' }))).code).toBe('user_is_admin');
    await addMember(deps, 'web', { email: 'alice@example.com' });
    expect((await appError(addMember(deps, 'web', { email: 'alice@example.com' }))).code).toBe('already_member');
    expect((await appError(addMember(deps, 'web', { email: 'bob@example.com', role: 'admin' }))).code).toBe(
      'validation_failed',
    );
    expect((await appError(addMember(deps, 'nope', { email: 'bob@example.com' }))).code).toBe('project_not_found');
  });

  test('changes and removes a membership, but never your own', async () => {
    await addMember(deps, 'web', { email: 'alice@example.com', role: 'maintainer' });
    await addMember(deps, 'web', { email: 'bob@example.com' });
    expect((await updateMember(deps, 'web', bob.id, { role: 'reviewer' }, alice.id)).role).toBe('reviewer');
    expect((await appError(updateMember(deps, 'web', alice.id, { role: 'viewer' }, alice.id))).code).toBe(
      'own_membership',
    );
    expect((await appError(removeMember(deps, 'web', alice.id, alice.id))).code).toBe('own_membership');
    await removeMember(deps, 'web', bob.id, alice.id);
    expect((await appError(removeMember(deps, 'web', bob.id, alice.id))).code).toBe('member_not_found');
    expect((await appError(updateMember(deps, 'app', alice.id, { role: 'viewer' }, admin.id))).code).toBe(
      'member_not_found',
    );
  });

  test('lists what each user is a member of', async () => {
    await addMember(deps, 'web', { email: 'alice@example.com' });
    await addMember(deps, 'app', { email: 'alice@example.com', role: 'viewer' });
    const all = await membershipsOf(deps);
    expect(all.get(alice.id)).toEqual([
      { slug: 'app', name: 'App', role: 'viewer' },
      { slug: 'web', name: 'Web', role: 'reviewer' },
    ]);
    expect(all.get(bob.id)).toBeUndefined();
    expect(await membershipsOf(deps, bob.id)).toEqual(new Map());
  });

  test('a user sees the projects they are a member of, and those visible to everyone', async () => {
    const slugs = async (u: UserView) => (await visibleProjects(deps, principal(u))).map((x) => x.project.slug);
    expect(await slugs(admin)).toEqual(['app', 'web']);
    expect(await slugs(alice)).toEqual([]);
    await addMember(deps, 'web', { email: 'alice@example.com', role: 'viewer' });
    expect(await slugs(alice)).toEqual(['web']);
    expect(await projectRoleFor(deps, principal(alice), webId)).toBe('viewer');
    await updateProject(deps, 'app', { visibleToAll: true });
    expect(await slugs(bob)).toEqual(['app']);
    expect((await visibleProjects(deps, principal(alice))).map((x) => [x.project.slug, x.role])).toEqual([
      ['app', 'reviewer'],
      ['web', 'viewer'],
    ]);
    expect(await projectRoleFor(deps, principal(admin), webId)).toBeNull();
    expect(await projectRoleFor(deps, principal(bob), webId)).toBeNull();
  });

  test('memberships go with a deleted user; promoting to admin ends them', async () => {
    await addMember(deps, 'web', { email: 'alice@example.com' });
    await addMember(deps, 'web', { email: 'bob@example.com' });
    await deleteUser(deps, bob.id);
    expect((await listMembers(deps, 'web')).map((m) => m.email)).toEqual(['alice@example.com']);
    await updateUser(deps, alice.id, { role: 'admin' });
    expect(await listMembers(deps, 'web')).toEqual([]);
  });

  describe('candidates to add', () => {
    const emails = async (q: unknown, slug = 'web') => (await memberCandidates(deps, slug, q)).map((c) => c.email);

    test('match the email anywhere, ignoring case, and leave out members and admins', async () => {
      expect(await memberCandidates(deps, 'web', 'ALI')).toEqual([
        { id: alice.id, email: 'alice@example.com', role: 'reviewer' },
      ]);
      expect(await emails('example')).toEqual(['alice@example.com', 'bob@example.com']);
      await addMember(deps, 'web', { email: 'alice@example.com' });
      expect(await emails('example')).toEqual(['bob@example.com']);
      expect(await emails('example', 'app')).toEqual(['alice@example.com', 'bob@example.com']);
      expect(await emails('admin')).toEqual([]);
    });

    test('an email stored with capitals still matches (case-insensitive on SQLite and Postgres)', async () => {
      await deps.db
        .insertInto('users')
        .values({ id: 'usr_caps', email: 'Carol@Example.COM', passwordHash: 'x', role: 'viewer', createdAt: 1 })
        .execute();
      expect(await emails('carol@exa')).toEqual(['Carol@Example.COM']);
      expect(await emails('CAROL')).toEqual(['Carol@Example.COM']);
    });

    test('% and _ are plain characters, not wildcards', async () => {
      await make('a_b@example.com', 'viewer');
      await make('a%c@example.com', 'viewer');
      expect(await emails('a_b')).toEqual(['a_b@example.com']);
      expect(await emails('a%')).toEqual(['a%c@example.com']);
      expect(await emails('%%')).toEqual([]);
      expect(await emails('__')).toEqual([]);
      expect(await emails('a\\')).toEqual([]);
    });

    test('need 2 characters and give at most 10, by email', async () => {
      expect((await appError(memberCandidates(deps, 'web', 'a'))).code).toBe('validation_failed');
      expect((await appError(memberCandidates(deps, 'web', '  b  '))).code).toBe('validation_failed');
      for (let i = 0; i < 12; i++) await make(`user${String(i).padStart(2, '0')}@team.test`, 'viewer');
      const found = await emails('@team');
      expect(found).toHaveLength(10);
      expect(found[0]).toBe('user00@team.test');
      expect((await appError(memberCandidates(deps, 'nope', 'ab'))).code).toBe('project_not_found');
    });
  });
});
