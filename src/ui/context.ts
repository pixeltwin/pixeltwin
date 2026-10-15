import type { Context } from 'hono';
import type { Principal } from '../domain/auth/policy';
import { AppError } from '../errors';
import type { AppEnv, Services } from '../http/env';
import { type Theme, themeOf } from './theme';

export type UiUser = Extract<Principal, { kind: 'user' }>;

/** Per-request view of what pages need: the logged-in user and URL building under PUBLIC_URL's path. */
export interface Ui {
  user: UiUser | null;
  /** `/ui/p/web` → `/vrt/ui/p/web` when PUBLIC_URL is `https://host/vrt`. */
  url(path: string): string;
  /** The theme from the `pt_theme` cookie, rendered as `<html data-theme>`. */
  theme: Theme;
  /** This page's path and query without the PUBLIC_URL prefix: the `next` of forms that come back here. */
  here: string;
}

export function uiOf(c: Context<AppEnv>, s: Services): Ui {
  const base = new URL(s.config.publicUrl).pathname.replace(/\/+$/, '');
  const principal = c.get('principal');
  const url = new URL(c.req.url);
  return {
    user: principal?.kind === 'user' ? principal : null,
    url: (path) => `${base}${path}`,
    theme: themeOf(c),
    here: url.pathname + url.search,
  };
}

/** The logged-in user; the UI's auth middleware guarantees one on protected pages. */
export function userOf(c: Context<AppEnv>): UiUser {
  const principal = c.get('principal');
  if (principal?.kind !== 'user') throw new AppError('unauthenticated', 401, 'Log in first.');
  return principal;
}

function hasControlOrBackslash(value: string): boolean {
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    if (code < 0x20 || code === 0x7f || ch === '\\') return true;
  }
  return false;
}

/**
 * Where to go after logging in. Only paths inside the UI are accepted, so `next` cannot send
 * the user to another site (`//evil.example`, `https://…`) or to the API.
 */
export function safeNext(next: string | undefined): string {
  // Control characters, backslashes and encoded dots or slashes are never legitimate here.
  if (!next || hasControlOrBackslash(next) || /%2e|%2f|%5c/i.test(next)) return '/ui';
  let url: URL;
  try {
    url = new URL(next, 'http://ui.invalid');
  } catch {
    return '/ui';
  }
  // Resolve dot segments first, then check where the path really points.
  if (url.origin !== 'http://ui.invalid') return '/ui';
  if (url.pathname !== '/ui' && !url.pathname.startsWith('/ui/')) return '/ui';
  return url.pathname + url.search;
}

/** Fixed notices shown after a redirect (`?done=approved`); never reflects request text. */
export const NOTICES: Record<string, string> = {
  welcome: 'Welcome! Your admin account is ready. Create a project to start.',
  approved: 'Approved.',
  rejected: 'Rejected.',
  'approved-all': 'All pending checks approved.',
  'project-created': 'Project created.',
  'project-saved': 'Settings saved.',
  'token-revoked': 'Token revoked.',
  'user-created': 'User created.',
  'user-saved': 'User updated.',
  'user-deleted': 'User deleted.',
  'project-deleted': 'Project deleted.',
};

export function noticeOf(c: Context<AppEnv>): string | undefined {
  const done = c.req.query('done');
  return done ? NOTICES[done] : undefined;
}

/** Reads a form field as a trimmed string; absent → undefined. */
export function field(form: Record<string, unknown>, name: string): string | undefined {
  const value = form[name];
  return typeof value === 'string' ? value.trim() : undefined;
}
