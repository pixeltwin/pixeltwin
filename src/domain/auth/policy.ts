import { PROJECT_ROLES, type ProjectRole, type UserRole, type UserStatus } from '../../db/schema';
import { AppError } from '../../errors';
import type { TokenScope } from './tokens';

export const PERMISSIONS = [
  'project.read',
  'check.write',
  'check.review',
  'project.admin',
  'server.admin',
  'user.admin',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

/** What a route requires: a permission, any logged-in user (`session`), or nothing (`public`). */
export type RoutePermission = Permission | 'session' | 'public';

/**
 * Spec §7.3: the single source of truth for who may do what. `roles`: global roles that hold the
 * permission in every project. `projectRoles`: membership roles that hold it in their project.
 * `scopes`: project token scopes (a token is bound to its project).
 */
export const POLICY: Record<Permission, { roles: UserRole[]; projectRoles: ProjectRole[]; scopes: TokenScope[] }> = {
  'project.read': { roles: ['admin'], projectRoles: ['viewer', 'reviewer', 'maintainer'], scopes: ['read'] },
  'check.write': { roles: ['admin'], projectRoles: ['maintainer'], scopes: ['write'] },
  'check.review': { roles: ['admin'], projectRoles: ['reviewer', 'maintainer'], scopes: ['review'] },
  'project.admin': { roles: ['admin'], projectRoles: ['maintainer'], scopes: [] },
  /** Creating and deleting projects. */
  'server.admin': { roles: ['admin'], projectRoles: [], scopes: [] },
  'user.admin': { roles: ['admin'], projectRoles: [], scopes: [] },
};

/** The principal of a logged-in user (session cookie or personal token). */
export function userPrincipal(user: { id: string; email: string; role: UserRole; status: UserStatus }): Principal & {
  kind: 'user';
} {
  return { kind: 'user', id: user.id, email: user.email, role: user.role, status: user.status };
}

export type Principal =
  | { kind: 'user'; id: string; email: string; role: UserRole; status: UserStatus }
  | { kind: 'token'; id: string; projectId: string; name: string; scopes: TokenScope[] };

/**
 * Whether the principal holds the permission: server-wide, or in a project when given the user's
 * role there (from `projectRoleOf`). A token's project is checked by `assertProjectAccess`.
 */
export function hasPermission(
  principal: Principal,
  permission: Permission,
  projectRole: ProjectRole | null = null,
): boolean {
  const rule = POLICY[permission];
  if (principal.kind === 'token') return principal.scopes.some((scope) => rule.scopes.includes(scope));
  // A sign-up waiting for an admin (or turned down) may do nothing.
  if (principal.status !== 'active') return false;
  return rule.roles.includes(principal.role) || (projectRole !== null && rule.projectRoles.includes(projectRole));
}

/** A permission a project role can hold: routes that need it check the project in their handler. */
export function isProjectPermission(permission: Permission): boolean {
  return POLICY[permission].projectRoles.length > 0;
}

/**
 * A user's role in a project: their membership, raised to their global role (viewer or reviewer)
 * when the project is visible to everyone. Null: no role there (admins need none).
 */
export function projectRoleOf(
  user: { role: UserRole },
  project: { visibleToAll: boolean },
  membership: ProjectRole | null,
): ProjectRole | null {
  if (user.role === 'admin' || !project.visibleToAll) return membership;
  const everyone: ProjectRole = user.role;
  if (membership === null) return everyone;
  return PROJECT_ROLES.indexOf(membership) >= PROJECT_ROLES.indexOf(everyone) ? membership : everyone;
}

/**
 * Throws unless the principal may use the project with `permission`. A token of another project:
 * 403 `token_project_mismatch`. A user who cannot see the project: `hidden`, the error a missing
 * project (build, check) gives, so ids do not leak. A user who can see it: 403 when the role is short.
 */
export function assertProjectAccess(
  principal: Principal,
  projectId: string,
  permission: Permission,
  projectRole: ProjectRole | null,
  hidden: AppError,
): void {
  if (principal.kind === 'token') {
    if (principal.projectId !== projectId) {
      throw new AppError('token_project_mismatch', 403, 'This token belongs to a different project.');
    }
    if (!hasPermission(principal, permission)) {
      throw new AppError('forbidden', 403, `This endpoint requires the ${permission} permission.`);
    }
    return;
  }
  if (!hasPermission(principal, 'project.read', projectRole)) throw hidden;
  if (!hasPermission(principal, permission, projectRole)) {
    throw new AppError('forbidden', 403, `This needs the ${permission} permission in this project.`);
  }
}
