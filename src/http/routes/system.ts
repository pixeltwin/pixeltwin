import type { OpenAPIHono } from '@hono/zod-openapi';
import { sql } from 'kysely';
import { VERSION } from '../../version';
import type { AppEnv, Services } from '../env';

/** Public, outside /api/v1 and outside openapi.json. */
export function registerSystemRoutes(app: OpenAPIHono<AppEnv>, s: Services): void {
  app.get('/healthz', async (c) => {
    const checks = { database: 'ok', storage: 'ok' };
    try {
      await sql`select 1`.execute(s.deps.db);
    } catch {
      checks.database = 'failing';
    }
    try {
      await s.deps.storage.exists('healthz');
    } catch {
      checks.storage = 'failing';
    }
    const ok = checks.database === 'ok' && checks.storage === 'ok';
    return c.json({ status: ok ? 'ok' : 'failing', version: VERSION, ...checks }, ok ? 200 : 503);
  });
}
