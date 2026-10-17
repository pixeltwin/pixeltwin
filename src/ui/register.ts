import type { OpenAPIHono } from '@hono/zod-openapi';
import type { Context } from 'hono';
import type { AppEnv, Services } from '../http/env';
import { APP_CSS, ASSET_PATHS, ASSET_VERSIONS, FAVICON_SVG } from './assets';
import { CLIENT_MODULES, CLIENT_VERSION } from './client-assets';
import { registerAuthPages } from './pages/auth';
import { registerBuildPages } from './pages/build';
import { registerCheckPages } from './pages/check';
import { registerNoisyPages } from './pages/noisy';
import { registerProjectPages } from './pages/projects';
import { registerSettingsPages } from './pages/settings';
import { registerUserPages } from './pages/users';
import { uiSession } from './session';
import { registerThemeRoute } from './theme';

/** Spec §8: the server-rendered UI under /ui. Errors on these paths render HTML (see app.ts). */
export function registerUi(app: OpenAPIHono<AppEnv>, s: Services): void {
  const base = new URL(s.config.publicUrl).pathname.replace(/\/+$/, '');
  app.get('/', (c) => c.redirect(`${base}/ui`, 302));
  app.get('/favicon.ico', (c) => c.redirect(`${base}${ASSET_PATHS.favicon}`, 301));

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
  app.get('/ui/assets/favicon.svg', asset(FAVICON_SVG, 'image/svg+xml', ASSET_VERSIONS.favicon));
  app.get('/ui/assets/:file{[a-z0-9-]+\\.js}', (c) => {
    const code = CLIENT_MODULES[c.req.param('file').slice(0, -'.js'.length)];
    if (code === undefined) return c.notFound();
    return asset(code, 'text/javascript; charset=utf-8', CLIENT_VERSION)(c);
  });

  registerAuthPages(app, s);
  registerThemeRoute(app, s);
  registerProjectPages(app, s);
  registerBuildPages(app, s);
  registerCheckPages(app, s);
  registerNoisyPages(app, s);
  registerSettingsPages(app, s);
  registerUserPages(app, s);
}
