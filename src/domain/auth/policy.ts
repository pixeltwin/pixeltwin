import type { UserRole } from '../../db/schema';
import { AppError } from '../../errors';
import type { TokenScope } from './tokens';

export const PERMISSIONS = ['project.read', 'check.write', 'check.review', 'project.admin', 'user.admin'] as const;
export type Permission = (typeof PERMISSIONS)[number];

/** What a route requires: a permission, any logged-in user (`session`), or nothing (`public`). */
export type RoutePermission = Permission | 'session' | 'public';

/** Spec §7.3: the single source of truth for who may do what. */
export const POLICY: Record<Permission, { roles: UserRole[]; scopes: TokenScope[] }> = {
  'project.read': { roles: ['admin', 'reviewer', 'viewer'], scopes: ['read'] },
  'check.write': { roles: ['admin'], scopes: ['write'] },
  'check.review': { roles: ['admin', 'reviewer'], scopes: ['review'] },
  'project.admin': { roles: ['admin'], scopes: [] },
  'user.admin': { roles: ['admin'], scopes: [] },
};

export type Principal =
  | { kind: 'user'; id: string; email: string; role: UserRole }
  | { kind: 'token'; id: string; projectId: string; name: string; scopes: TokenScope[] };

export function hasPermission(principal: Principal, permission: Permission): boolean {
  const rule = POLICY[permission];
  return principal.kind === 'user'
    ? rule.roles.includes(principal.role)
    : principal.scopes.some((scope) => rule.scopes.includes(scope));
}

/** Users may access every project; a token only its own. */
export function assertProjectAccess(principal: Principal, projectId: string): void {
  if (principal.kind === 'token' && principal.projectId !== projectId) {
    throw new AppError('token_project_mismatch', 403, 'This token belongs to a different project.');
  }
}
