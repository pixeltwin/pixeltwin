import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { UserRole } from '../../src/db/schema';
import { projectRoleFor, visibleProjects } from '../../src/domain/auth/access';
import { createUser, deleteUser, type UserView, updateUser } from '../../src/domain/auth/users';
import { addMember, listMembers, membershipsOf, removeMember, updateMember } from '../../src/domain/members';
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

  const principal = (u: UserView) => ({ kind: 'user' as const, id: u.id, email: u.email, role: u.role });
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
});
