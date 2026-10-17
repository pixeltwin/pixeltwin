import type { MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import { userPrincipal } from '../domain/auth/policy';
import { resolveSession } from '../domain/auth/sessions';
import { listAccessRequests } from '../domain/signup';
import { AppError } from '../errors';
import { setSessionCookie } from '../http/cookies';
import { type AppEnv, SESSION_COOKIE, type Services } from '../http/env';
import { waitingPage } from './pages/waiting';

/** Spec §7.4: UI responses. Styles and scripts come only from /ui/assets; images from this origin. */
export const UI_CSP =
  "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'";

const PUBLIC_PAGES = /^\/ui\/(login|setup|signup|assets\/)/;
/** One-time links: public, never with a session (a link opened in a logged-in browser stays about its own email). */
const LINK_PAGES = /^\/ui\/(invite|reset|verify)\//;
/** What a pending (or rejected) user may still do: log out, switch the theme. */
const PENDING_PAGES = /^\/ui\/(logout|theme|login)$/;
/** Pages of one project, build or check: each must check the user's access to its project. */
const PROJECT_PAGES = /^\/ui\/(p|builds|checks)\//;

/**
 * Resolves the session cookie (the UI never accepts project tokens), refuses cross-site form
 * posts, sends logged-out visitors to the login page and adds security headers. Fails closed: a
 * project page that answers without checking the user's access to its project is a 500.
 */
export function uiSession(s: Services): MiddlewareHandler<AppEnv> {
  const allowedOrigin = new URL(s.config.publicUrl).origin;
  const base = new URL(s.config.publicUrl).pathname.replace(/\/+$/, '');
  return async (c, next) => {
    // Assets are public and cacheable: never resolve a session (or refresh its cookie) for them.
    if (c.req.path.startsWith('/ui/assets/')) return next();
    c.set('principal', null);
    c.set('authVia', null);
    c.set('sessionToken', null);
    c.set('permission', null);
    c.set('projectChecked', false);
    c.set('deps', s.deps);
    if (LINK_PAGES.test(c.req.path)) {
      // With `Referrer-Policy: no-referrer` browsers send `Origin: null` on the page's own form;
      // Sec-Fetch-Site (which no page can set) then says whether it came from this site.
      const origin = c.req.header('origin');
      const sameSite =
        origin === allowedOrigin || (origin === 'null' && c.req.header('sec-fetch-site') === 'same-origin');
      if (c.req.method === 'POST' && !sameSite) {
        throw new AppError('csrf_origin_mismatch', 403, `Forms must be submitted from ${allowedOrigin}.`);
      }
      await next();
      c.res.headers.set('content-security-policy', UI_CSP);
      // The token is in the URL: no other site may see it in a Referer, no cache may keep the page.
      c.res.headers.set('referrer-policy', 'no-referrer');
      c.res.headers.set('cache-control', 'no-store');
      c.res.headers.set('x-frame-options', 'DENY');
      return;
    }
    const cookie = getCookie(c, SESSION_COOKIE);
    const session = cookie ? await resolveSession(s.deps, cookie) : null;
    const user = session?.user ?? null;
    if (cookie && session && user) {
      if (session.refreshed) setSessionCookie(c, s.config.publicUrl, { token: cookie, expiresAt: session.expiresAt });
      c.set('principal', userPrincipal(user));
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
    c.set('accessRequests', 0);
    if (user?.role === 'admin' && user.status === 'active' && c.req.method === 'GET') {
      c.set('accessRequests', (await listAccessRequests(s.deps, { verifiedOnly: !!s.mailer })).length);
    }
    // A sign-up waiting for an admin (or turned down) sees that, whatever page it asks for.
    if (user && user.status !== 'active' && !PENDING_PAGES.test(c.req.path)) {
      const res = await waitingPage(c, s, user.status === 'rejected');
      res.headers.set('content-security-policy', UI_CSP);
      res.headers.set('referrer-policy', 'same-origin');
      res.headers.set('x-frame-options', 'DENY');
      return res;
    }

    await next();
    if (PROJECT_PAGES.test(c.req.path) && !c.get('projectChecked') && c.res.status < 400) {
      throw new Error(`${c.req.method} ${c.req.path} answered without checking project access`);
    }
    c.res.headers.set('content-security-policy', UI_CSP);
    c.res.headers.set('referrer-policy', 'same-origin');
    c.res.headers.set('x-frame-options', 'DENY');
  };
}
