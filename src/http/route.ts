import { createRoute, type RouteConfig } from '@hono/zod-openapi';
import type { RoutePermission } from '../domain/auth/policy';
import { requirePermission } from './auth';

/** Any of the two schemes registered in app.ts satisfies a protected route. */
const PROTECTED: Array<Record<string, string[]>> = [{ projectToken: [] }, { session: [] }];

/**
 * `createRoute` plus the route's permission: enforced by middleware and published in
 * openapi.json as `x-permission`, so agents can see what each call needs.
 */
export function defineRoute<const R extends Omit<RouteConfig, 'middleware'>>(permission: RoutePermission, config: R) {
  return createRoute({
    ...config,
    'x-permission': permission,
    ...(permission === 'public' ? {} : { security: PROTECTED }),
    middleware: [requirePermission(permission)] as const,
  });
}
