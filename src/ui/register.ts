import type { OpenAPIHono } from '@hono/zod-openapi';
import type { AppEnv, Services } from '../http/env';
import { APP_CSS, APP_JS } from './assets';
import { registerAuthPages } from './pages/auth';
import { registerProjectPages } from './pages/projects';
import { uiSession } from './session';

/** Spec §8: the server-rendered UI under /ui. Errors on these paths render HTML (see app.ts). */
export function registerUi(app: OpenAPIHono<AppEnv>, s: Services): void {
  const base = new URL(s.config.publicUrl).pathname.replace(/\/+$/, '');
  app.get('/', (c) => c.redirect(`${base}/ui`, 302));

  app.use('/ui', uiSession(s));
  app.use('/ui/*', uiSession(s));

  const asset = (body: string, type: string) => ({
    body,
    headers: { 'content-type': type, 'cache-control': 'public, max-age=31536000, immutable' },
  });
  const css = asset(APP_CSS, 'text/css; charset=utf-8');
  const js = asset(APP_JS, 'text/javascript; charset=utf-8');
  app.get('/ui/assets/app.css', (c) => c.body(css.body, 200, css.headers));
  app.get('/ui/assets/app.js', (c) => c.body(js.body, 200, js.headers));

  registerAuthPages(app, s);
  registerProjectPages(app, s);
}
