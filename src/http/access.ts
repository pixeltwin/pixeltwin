import type { Context, MiddlewareHandler } from 'hono';
import type { Build, Project, ProjectRole } from '../db/schema';
import { projectRoleFor } from '../domain/auth/access';
import { assertProjectAccess, hasPermission, type Permission } from '../domain/auth/policy';
import { buildNotFound, getBuildRow } from '../domain/builds';
import { type CheckView, checkNotFound, getCheck } from '../domain/checks';
import type { Deps } from '../domain/deps';
import { getProjectBySlug, projectNotFound } from '../domain/projects';
import type { AppError } from '../errors';
import { principalOf } from './auth';
import { API, type AppEnv } from './env';

type DbDeps = Pick<Deps, 'db'>;

/** What the caller may do in one project, once `allowProject` let them in. */
export interface ProjectAccess {
  /** The user's role there; null for admins and tokens. */
  role: ProjectRole | null;
  can(permission: Permission): boolean;
}

function declaredPermission(c: Context<AppEnv>): Permission {
  const permission = c.get('permission');
  if (!permission || permission === 'public' || permission === 'session') {
    throw new Error(`${c.req.method} ${c.req.path} checks a project without a project permission`);
  }
  return permission;
}

/**
 * The project check of every project-scoped route, API and UI (spec §7.3). `permission` defaults to
 * the one the API route declared. A user who may not see the project gets `hidden`, the not-found
 * error of what they asked for, so slugs and ids do not leak; a token of another project 403.
 */
export async function allowProject(
  c: Context<AppEnv>,
  deps: DbDeps,
  projectId: string,
  hidden: AppError,
  permission: Permission = declaredPermission(c),
): Promise<ProjectAccess> {
  const principal = principalOf(c);
  const role = principal.kind === 'user' ? await projectRoleFor(deps, principal, projectId) : null;
  assertProjectAccess(principal, projectId, permission, role, hidden);
  c.set('projectChecked', true);
  return { role, can: (p) => hasPermission(principal, p, role) };
}

/** For routes that answer only with what the caller may see (lists, images): no single project to check. */
export function accessFiltered(c: Context<AppEnv>): void {
  c.set('projectChecked', true);
}

export async function visibleProject(
  c: Context<AppEnv>,
  deps: DbDeps,
  slug: string,
  permission?: Permission,
): Promise<{ project: Project; access: ProjectAccess }> {
  const project = await getProjectBySlug(deps, slug);
  return { project, access: await allowProject(c, deps, project.id, projectNotFound(slug), permission) };
}

export async function visibleBuild(
  c: Context<AppEnv>,
  deps: DbDeps,
  id: string,
  permission?: Permission,
): Promise<{ build: Build; access: ProjectAccess }> {
  const build = await getBuildRow(deps, id);
  return { build, access: await allowProject(c, deps, build.projectId, buildNotFound(id), permission) };
}

export async function visibleCheck(
  c: Context<AppEnv>,
  deps: DbDeps,
  id: string,
  permission?: Permission,
): Promise<{ check: CheckView; access: ProjectAccess }> {
  const check = await getCheck(deps, id);
  return { check, access: await allowProject(c, deps, check.projectId, checkNotFound(id), permission) };
}

/** How an API route names its project: by slug, or by the id of a build or a check in it. */
export type ProjectRef = 'slug' | 'build' | 'check';

/** The project reference in a route path (`{slug}` or `:slug` style), if any. */
export function projectRefOf(path: string): ProjectRef | null {
  if (/[{:]slug\b/.test(path)) return 'slug';
  if (path.startsWith(`${API}/builds/{id}`) || path.startsWith(`${API}/builds/:id`)) return 'build';
  if (path.startsWith(`${API}/checks/{id}`) || path.startsWith(`${API}/checks/:id`)) return 'check';
  return null;
}

/**
 * Route middleware: checks the caller's access to the project the path names, before the body is
 * read or validated, so a user outside the project always gets the same 404.
 */
export function requireProject(ref: ProjectRef): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const deps = c.get('deps');
    if (ref === 'slug') await visibleProject(c, deps, c.req.param('slug') ?? '');
    else if (ref === 'build') await visibleBuild(c, deps, c.req.param('id') ?? '');
    else await visibleCheck(c, deps, c.req.param('id') ?? '');
    await next();
  };
}
