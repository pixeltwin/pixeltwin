import type { Context, MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import { assertProjectAccess, hasPermission, type RoutePermission } from '../domain/auth/policy';
import { resolveSession } from '../domain/auth/sessions';
import { resolveProjectToken } from '../domain/auth/tokens';
import { AppError } from '../errors';
import { type AppEnv, SESSION_COOKIE, type Services } from './env';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Resolves the caller: `Authorization: Bearer pt_…` (project token) or the session cookie.
 * A malformed or unknown Bearer token is a 401 even on public routes, so typos surface early.
 * Cookie-authenticated writes must come from PUBLIC_URL's origin (CSRF, spec §7.1).
 */
export function authenticate(services: Services): MiddlewareHandler<AppEnv> {
  const allowedOrigin = new URL(services.config.publicUrl).origin;
  return async (c, next) => {
    c.set('principal', null);
    c.set('authVia', null);
    c.set('sessionToken', null);

    // Only the Bearer scheme is a token attempt. Other schemes (e.g. Basic added by a reverse
    // proxy) are ignored so the session cookie still works behind such a proxy.
    const header = c.req.header('authorization');
    const bearer = header && /^Bearer(\s|$)/i.test(header) ? header : null;
    if (bearer) {
      const raw = /^Bearer\s+(\S+)$/i.exec(bearer)?.[1];
      const token = raw ? await resolveProjectToken(services.deps, raw) : null;
      if (!token) throw new AppError('invalid_token', 401, 'The Bearer token is not a valid project token.');
      c.set('principal', { kind: 'token', ...token });
      c.set('authVia', 'token');
    } else {
      const cookie = getCookie(c, SESSION_COOKIE);
      const user = cookie ? await resolveSession(services.deps, cookie) : null;
      if (cookie && user) {
        c.set('principal', { kind: 'user', id: user.id, email: user.email, role: user.role });
        c.set('authVia', 'cookie');
        c.set('sessionToken', cookie);
        if (!SAFE_METHODS.has(c.req.method) && c.req.header('origin') !== allowedOrigin) {
          throw new AppError(
            'csrf_origin_mismatch',
            403,
            `Requests authenticated by cookie must come from ${allowedOrigin}.`,
          );
        }
      }
    }
    await next();
  };
}

/** Enforces a route's declared permission (spec §7.3). */
export function requirePermission(permission: RoutePermission): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (permission !== 'public') {
      const principal = c.get('principal');
      if (!principal) throw new AppError('unauthenticated', 401, 'Log in or send a project token.');
      if (permission === 'session') {
        if (principal.kind !== 'user') throw new AppError('forbidden', 403, 'This endpoint needs a logged-in user.');
      } else if (!hasPermission(principal, permission)) {
        throw new AppError('forbidden', 403, `This endpoint requires the ${permission} permission.`);
      }
    }
    await next();
  };
}

/** The authenticated caller; only valid on routes whose permission is not `public`. */
export function principalOf(c: Context<AppEnv>) {
  const principal = c.get('principal');
  if (!principal) throw new AppError('unauthenticated', 401, 'Log in or send a project token.');
  return principal;
}

/** Throws 403 `token_project_mismatch` when a token reaches into another project. */
export function allowProject(c: Context<AppEnv>, projectId: string): void {
  assertProjectAccess(principalOf(c), projectId);
}
