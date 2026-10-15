import type { OpenAPIHono } from '@hono/zod-openapi';
import type { Context } from 'hono';
import type { AppEnv, Services } from '../http/env';
import { APP_CSS, APP_JS, ASSET_VERSIONS } from './assets';
import { registerAdminPages } from './pages/admin';
import { registerAuthPages } from './pages/auth';
import { registerBuildPages } from './pages/build';
import { registerCheckPages } from './pages/check';
import { registerProjectPages } from './pages/projects';
import { uiSession } from './session';

/** Spec §8: the server-rendered UI under /ui. Errors on these paths render HTML (see app.ts). */
export function registerUi(app: OpenAPIHono<AppEnv>, s: Services): void {
  const base = new URL(s.config.publicUrl).pathname.replace(/\/+$/, '');
  app.get('/', (c) => c.redirect(`${base}/ui`, 302));

  app.use('/ui', uiSession(s));
  app.use('/ui/*', uiSession(s));

  // Only the current content hash may be cached forever. Another `v` (an older or newer replica
  // during a rolling upgrade) gets the current file uncached, so no cache keeps a mismatch.
  const asset = (body: string, type: string, version: string) => (c: Context) =>
    c.body(body, 200, {
      'content-type': type,
      'cache-control': c.req.query('v') === version ? 'public, max-age=31536000, immutable' : 'no-store',
    });
  app.get('/ui/assets/app.css', asset(APP_CSS, 'text/css; charset=utf-8', ASSET_VERSIONS.css));
  app.get('/ui/assets/app.js', asset(APP_JS, 'text/javascript; charset=utf-8', ASSET_VERSIONS.js));

  registerAuthPages(app, s);
  registerProjectPages(app, s);
  registerBuildPages(app, s);
  registerCheckPages(app, s);
  registerAdminPages(app, s);
}
