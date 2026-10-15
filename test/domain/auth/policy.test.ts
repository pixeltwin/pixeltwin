import { describe, expect, test } from 'bun:test';
import { assertProjectAccess, hasPermission, PERMISSIONS, type Principal } from '../../../src/domain/auth/policy';
import type { AppError } from '../../../src/errors';

const user = (role: 'admin' | 'reviewer' | 'viewer'): Principal => ({
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

describe('policy', () => {
  test('roles match spec §7.3', () => {
    const allowed = (p: Principal) => PERMISSIONS.filter((permission) => hasPermission(p, permission));
    expect(allowed(user('admin'))).toEqual([...PERMISSIONS]);
    expect(allowed(user('reviewer'))).toEqual(['project.read', 'check.review']);
    expect(allowed(user('viewer'))).toEqual(['project.read']);
  });

  test('scopes match spec §7.3 and never grant admin permissions', () => {
    const allowed = (p: Principal) => PERMISSIONS.filter((permission) => hasPermission(p, permission));
    expect(allowed(token('read'))).toEqual(['project.read']);
    expect(allowed(token('write'))).toEqual(['check.write']);
    expect(allowed(token('review'))).toEqual(['check.review']);
    expect(allowed(token('read', 'write', 'review'))).toEqual(['project.read', 'check.write', 'check.review']);
  });

  test('tokens are bound to their project; users are not', () => {
    expect(() => assertProjectAccess(user('viewer'), 'prj_2')).not.toThrow();
    expect(() => assertProjectAccess(token('read'), 'prj_1')).not.toThrow();
    try {
      assertProjectAccess(token('read'), 'prj_2');
      throw new Error('expected AppError');
    } catch (err) {
      expect((err as AppError).code).toBe('token_project_mismatch');
      expect((err as AppError).status).toBe(403);
    }
  });
});
