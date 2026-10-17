import { createRoute, type RouteConfig } from '@hono/zod-openapi';
import type { MiddlewareHandler } from 'hono';
import { isProjectPermission, type RoutePermission } from '../domain/auth/policy';
import { projectRefOf, requireProject } from './access';
import { requirePermission } from './auth';
import type { AppEnv } from './env';

/** Any of the two schemes registered in app.ts satisfies a protected route. */
const PROTECTED: Array<Record<string, string[]>> = [{ projectToken: [] }, { session: [] }];

/**
 * `createRoute` plus the route's permission: enforced by middleware and published in
 * openapi.json as `x-permission`, so agents can see what each call needs. A route whose path
 * names a project (`{slug}`, `/builds/{id}`, `/checks/{id}`) also checks the caller's access to it.
 */
export function defineRoute<const R extends Omit<RouteConfig, 'middleware'>>(permission: RoutePermission, config: R) {
  return createRoute({
    ...config,
    'x-permission': permission,
    ...(permission === 'public' ? {} : { security: PROTECTED }),
    middleware: guard(permission, config.path),
  });
}

/** The middleware that enforces `permission` on `path`; also for routes served by plain handlers. */
export function guard(permission: RoutePermission, path: string): MiddlewareHandler<AppEnv>[] {
  const ref = permission === 'public' || permission === 'session' ? null : projectRefOf(path);
  const scoped = ref !== null && permission !== 'public' && permission !== 'session' && isProjectPermission(permission);
  return scoped ? [requirePermission(permission), requireProject(ref)] : [requirePermission(permission)];
}
