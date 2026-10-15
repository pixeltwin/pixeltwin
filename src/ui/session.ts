import type { MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import { resolveSession } from '../domain/auth/sessions';
import { AppError } from '../errors';
import { setSessionCookie } from '../http/cookies';
import { type AppEnv, SESSION_COOKIE, type Services } from '../http/env';

/** Spec §7.4: UI responses. Styles and scripts come only from /ui/assets; images from this origin. */
export const UI_CSP =
  "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'";

const PUBLIC_PAGES = /^\/ui\/(login|setup|assets\/)/;

/**
 * Resolves the session cookie (the UI never accepts project tokens), refuses cross-site form
 * posts, sends logged-out visitors to the login page and adds security headers.
 */
export function uiSession(s: Services): MiddlewareHandler<AppEnv> {
  const allowedOrigin = new URL(s.config.publicUrl).origin;
  const base = new URL(s.config.publicUrl).pathname.replace(/\/+$/, '');
  return async (c, next) => {
    c.set('principal', null);
    c.set('authVia', null);
    c.set('sessionToken', null);
    const cookie = getCookie(c, SESSION_COOKIE);
    const session = cookie ? await resolveSession(s.deps, cookie) : null;
    const user = session?.user ?? null;
    if (cookie && session && user) {
      if (session.refreshed) setSessionCookie(c, s.config.publicUrl, { token: cookie, expiresAt: session.expiresAt });
      c.set('principal', { kind: 'user', id: user.id, email: user.email, role: user.role });
      c.set('authVia', 'cookie');
      c.set('sessionToken', cookie);
    }

    if (c.req.method === 'POST' && c.req.header('origin') !== allowedOrigin) {
      throw new AppError('csrf_origin_mismatch', 403, `Forms must be submitted from ${allowedOrigin}.`);
    }
    if (!user && !PUBLIC_PAGES.test(c.req.path)) {
      const here = c.req.path + (new URL(c.req.url).search || '');
      return c.redirect(`${base}/ui/login?next=${encodeURIComponent(here)}`, 303);
    }

    await next();
    c.res.headers.set('content-security-policy', UI_CSP);
    c.res.headers.set('referrer-policy', 'same-origin');
    c.res.headers.set('x-frame-options', 'DENY');
  };
}
