import { describe, expect, test } from 'bun:test';
import type { ProjectRole, UserRole } from '../../../src/db/schema';
import {
  assertProjectAccess,
  hasPermission,
  isProjectPermission,
  PERMISSIONS,
  type Principal,
  projectRoleOf,
} from '../../../src/domain/auth/policy';
import { AppError } from '../../../src/errors';

const user = (role: UserRole): Extract<Principal, { kind: 'user' }> => ({
  kind: 'user',
  id: 'usr_1',
  email: 'a@b.c',
  role,
});
const token = (...scopes: Array<'read' | 'write' | 'review'>): Principal => ({
  kind: 'token',
  id: 'tok_1',
  projectId: 'prj_1',
  scopes,
});
const hidden = new AppError('project_not_found', 404, 'Project "web" not found.');

function thrown(fn: () => void): AppError | null {
  try {
    fn();
    return null;
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    return err;
  }
}

describe('policy', () => {
  const allowed = (p: Principal, role: ProjectRole | null = null) =>
    PERMISSIONS.filter((permission) => hasPermission(p, permission, role));

  test('admins hold every permission everywhere; other global roles none by themselves', () => {
    expect(allowed(user('admin'))).toEqual([...PERMISSIONS]);
    expect(allowed(user('reviewer'))).toEqual([]);
    expect(allowed(user('viewer'))).toEqual([]);
  });

  test('project roles hold the project permissions of spec §7.3, never server-wide ones', () => {
    expect(allowed(user('viewer'), 'viewer')).toEqual(['project.read']);
    expect(allowed(user('viewer'), 'reviewer')).toEqual(['project.read', 'check.review']);
    expect(allowed(user('viewer'), 'maintainer')).toEqual([
      'project.read',
      'check.write',
      'check.review',
      'project.admin',
    ]);
  });

  test('scopes match spec §7.3 and never grant admin permissions', () => {
    expect(allowed(token('read'))).toEqual(['project.read']);
    expect(allowed(token('write'))).toEqual(['check.write']);
    expect(allowed(token('review'))).toEqual(['check.review']);
    expect(allowed(token('read', 'write', 'review'))).toEqual(['project.read', 'check.write', 'check.review']);
    // A project role never applies to a token.
    expect(allowed(token('read'), 'maintainer')).toEqual(['project.read']);
  });

  test('project permissions are those a project role can hold', () => {
    expect(PERMISSIONS.filter(isProjectPermission)).toEqual([
      'project.read',
      'check.write',
      'check.review',
      'project.admin',
    ]);
  });

  test("a user's role in a project: the membership, raised to the global role when visible to everyone", () => {
    const members = { visibleToAll: false };
    const everyone = { visibleToAll: true };
    expect(projectRoleOf(user('reviewer'), members, null)).toBeNull();
    expect(projectRoleOf(user('reviewer'), members, 'viewer')).toBe('viewer');
    expect(projectRoleOf(user('reviewer'), everyone, null)).toBe('reviewer');
    expect(projectRoleOf(user('reviewer'), everyone, 'viewer')).toBe('reviewer');
    expect(projectRoleOf(user('viewer'), everyone, 'maintainer')).toBe('maintainer');
    expect(projectRoleOf(user('admin'), members, null)).toBeNull();
  });

  test('tokens are bound to their project', () => {
    expect(thrown(() => assertProjectAccess(token('read'), 'prj_1', 'project.read', null, hidden))).toBeNull();
    const err = thrown(() => assertProjectAccess(token('read'), 'prj_2', 'project.read', null, hidden));
    expect([err?.code, err?.status]).toEqual(['token_project_mismatch', 403]);
  });

  test('a user who cannot see the project gets its not-found error; one who can, 403 when the role is short', () => {
    expect(thrown(() => assertProjectAccess(user('admin'), 'prj_2', 'project.admin', null, hidden))).toBeNull();
    expect(thrown(() => assertProjectAccess(user('reviewer'), 'prj_1', 'project.read', null, hidden))).toBe(hidden);
    expect(thrown(() => assertProjectAccess(user('reviewer'), 'prj_1', 'check.review', null, hidden))).toBe(hidden);
    expect(thrown(() => assertProjectAccess(user('viewer'), 'prj_1', 'project.read', 'viewer', hidden))).toBeNull();
    const short = thrown(() => assertProjectAccess(user('viewer'), 'prj_1', 'check.review', 'viewer', hidden));
    expect([short?.code, short?.status]).toEqual(['forbidden', 403]);
  });
});
