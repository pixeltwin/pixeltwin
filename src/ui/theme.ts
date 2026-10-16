import type { OpenAPIHono } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { AppError } from '../errors';
import type { AppEnv, Services } from '../http/env';
import { field, safeNext, uiOf } from './context';

export const THEMES = ['light', 'dark', 'system'] as const;
export type Theme = (typeof THEMES)[number];
export const THEME_COOKIE = 'pt_theme';

function asTheme(value: string | undefined): Theme | undefined {
  return THEMES.find((t) => t === value);
}

/** The theme the page renders with (UI spec §3.4): the cookie's value, light by default. */
export function themeOf(c: Context<AppEnv>): Theme {
  return asTheme(getCookie(c, THEME_COOKIE)) ?? 'light';
}

/**
 * `POST /ui/theme` stores the choice for a year. Not HttpOnly: the theme island sets the same
 * cookie without a page load. Works without JavaScript through the user menu's form.
 */
export function registerThemeRoute(app: OpenAPIHono<AppEnv>, s: Services): void {
  app.post('/ui/theme', async (c) => {
    const form = await c.req.parseBody();
    const theme = asTheme(field(form, 'theme'));
    if (!theme) throw new AppError('invalid_theme', 422, 'The theme must be light, dark or system.');
    setCookie(c, THEME_COOKIE, theme, {
      path: '/',
      sameSite: 'Lax',
      maxAge: 365 * 24 * 60 * 60,
      secure: s.config.publicUrl.startsWith('https:'),
    });
    return c.redirect(uiOf(c, s).url(safeNext(field(form, 'next'))), 303);
  });
}
