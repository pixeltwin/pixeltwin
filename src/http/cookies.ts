import type { Context } from 'hono';
import { deleteCookie, setCookie } from 'hono/cookie';
import { SESSION_COOKIE } from './env';

/** Spec §7.1 cookie attributes, shared by login and by the sliding-expiry refresh. */
export function setSessionCookie(c: Context, publicUrl: string, session: { token: string; expiresAt: number }): void {
  setCookie(c, SESSION_COOKIE, session.token, {
    httpOnly: true,
    sameSite: 'Lax',
    path: '/',
    secure: publicUrl.startsWith('https:'),
    expires: new Date(session.expiresAt),
  });
}

export function clearSessionCookie(c: Context, publicUrl: string): void {
  deleteCookie(c, SESSION_COOKIE, { path: '/', secure: publicUrl.startsWith('https:') });
}
