import type { Context, MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import { hasPermission, isProjectPermission, type RoutePermission, userPrincipal } from '../domain/auth/policy';
import { resolveSession, USER_TOKEN_PREFIX } from '../domain/auth/sessions';
import { resolveProjectToken } from '../domain/auth/tokens';
import { AppError } from '../errors';
import { setSessionCookie } from './cookies';
import { API, type AppEnv, SESSION_COOKIE, type Services } from './env';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
/** All a sign-up waiting for approval may call: who am I, and log out. */
const PENDING_ALLOWED = new Set([`GET ${API}/me`, `POST ${API}/auth/logout`]);

/**
 * Resolves the caller: `Authorization: Bearer pt_…` (project token), `Bearer pu_…` (a user's
 * personal token, from POST /auth/token) or the session cookie.
 * A malformed or unknown Bearer token is a 401 even on public routes, so typos surface early.
 * Cookie-authenticated writes must come from PUBLIC_URL's origin (CSRF, spec §7.1).
 */
export function authenticate(services: Services): MiddlewareHandler<AppEnv> {
  const allowedOrigin = new URL(services.config.publicUrl).origin;
  return async (c, next) => {
    c.set('principal', null);
    c.set('authVia', null);
    c.set('sessionToken', null);
    c.set('permission', null);
    c.set('projectChecked', false);
    c.set('deps', services.deps);

    // Only the Bearer scheme is a token attempt. Other schemes (e.g. Basic added by a reverse
    // proxy) are ignored so the session cookie still works behind such a proxy.
    const header = c.req.header('authorization');
    const bearer = header && /^Bearer(\s|$)/i.test(header) ? header : null;
    if (bearer) {
      const raw = /^Bearer\s+(\S+)$/i.exec(bearer)?.[1];
      if (raw?.startsWith(USER_TOKEN_PREFIX)) {
        // A header is never sent by a cross-site form, so no Origin check (unlike the cookie).
        const session = await resolveSession(services.deps, raw);
        if (!session) throw new AppError('invalid_token', 401, 'The personal token is unknown or has expired.');
        const { user } = session;
        c.set('principal', userPrincipal(user));
      } else {
        const token = raw ? await resolveProjectToken(services.deps, raw) : null;
        if (!token) throw new AppError('invalid_token', 401, 'The Bearer token is not a valid project token.');
        c.set('principal', { kind: 'token', ...token });
      }
      c.set('authVia', 'token');
    } else {
      const cookie = getCookie(c, SESSION_COOKIE);
      const session = cookie ? await resolveSession(services.deps, cookie) : null;
      if (cookie && session) {
        const { user } = session;
        if (session.refreshed)
          setSessionCookie(c, services.config.publicUrl, { token: cookie, expiresAt: session.expiresAt });
        c.set('principal', userPrincipal(user));
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

/**
 * Enforces a route's declared permission (spec §7.3). A project role may hold a project permission,
 * so a user without it server-wide is let through to the handler, which checks the project
 * (`allowProject`). Fails closed: such a route that answers without that check is a 500.
 */
export function requirePermission(permission: RoutePermission): MiddlewareHandler<AppEnv> {
  const scoped = permission !== 'public' && permission !== 'session' && isProjectPermission(permission);
  return async (c, next) => {
    c.set('permission', permission);
    if (permission !== 'public') {
      const principal = c.get('principal');
      if (!principal) throw new AppError('unauthenticated', 401, 'Log in or send a project token.');
      if (
        principal.kind === 'user' &&
        principal.status !== 'active' &&
        !PENDING_ALLOWED.has(`${c.req.method} ${c.req.path}`)
      ) {
        throw principal.status === 'rejected'
          ? new AppError('account_rejected', 403, 'An admin turned down the access request of this account.')
          : new AppError('account_pending', 403, 'This account waits for an admin to approve its access.');
      }
      if (permission === 'session') {
        if (principal.kind !== 'user') throw new AppError('forbidden', 403, 'This endpoint needs a logged-in user.');
      } else if (!hasPermission(principal, permission) && !(scoped && principal.kind === 'user')) {
        throw new AppError('forbidden', 403, `This endpoint requires the ${permission} permission.`);
      }
    }
    await next();
    if (scoped && !c.get('projectChecked') && c.res.status < 400) {
      throw new Error(`${c.req.method} ${c.req.path} answered without checking project access`);
    }
  };
}

/** The authenticated caller; only valid on routes whose permission is not `public`. */
export function principalOf(c: Context<AppEnv>) {
  const principal = c.get('principal');
  if (!principal) throw new AppError('unauthenticated', 401, 'Log in or send a project token.');
  return principal;
}
