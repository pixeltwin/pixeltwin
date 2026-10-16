import type { Config } from './config';
import { migrateToLatest, openDatabase } from './db/database';
import { DiffPool } from './diff/pool';
import { SetupState } from './domain/auth/setup';
import type { Deps } from './domain/deps';
import { startRetentionJob } from './domain/retention-job';
import { createApp } from './http/app';
import { LoginLimiter } from './http/rate-limit';
import type { Logger } from './log';
import { DatabaseStorage } from './storage/database';
import { LocalStorage } from './storage/local';

export interface RunningServer {
  /** Where the server listens, e.g. `http://localhost:8080`. */
  url: string;
  /** Set while no user exists; POST it to /api/v1/setup to create the first admin. */
  setupToken: string | null;
  stop(): Promise<void>;
}

/** Wires config → database → storage → diff pool → HTTP app and starts listening. */
export async function startServer(config: Config, logger: Logger): Promise<RunningServer> {
  const handle = openDatabase(config.databaseUrl, { poolMax: config.databasePoolMax });
  const applied = await migrateToLatest(handle.db);
  if (applied.length > 0) logger.info('migrations applied', { migrations: applied });

  const pool = new DiffPool({ size: config.diffWorkers, timeoutMs: config.diffTimeoutMs });
  const deps: Deps = {
    db: handle.db,
    storage: config.storage === 'postgres' ? new DatabaseStorage(handle.db) : new LocalStorage(config.dataDir),
    runDiff: pool.run,
    diffBacklog: () => pool.backlog,
    limits: { maxImageBytes: config.maxImageBytes, maxImagePixels: config.maxImagePixels },
  };
  const { state, token } = await SetupState.init(deps, config.setupToken);
  const app = createApp({ deps, config, logger, setup: state, loginLimiter: new LoginLimiter() });

  const server = Bun.serve({
    port: config.port,
    fetch: app.fetch,
    // Upper bound before the app's own per-route limits apply.
    maxRequestBodySize: Math.ceil(config.maxImageBytes / 3) * 4 + 1024 * 1024,
  });
  const retention = startRetentionJob({ deps, handle, logger });
  const url = server.url.href.replace(/\/$/, '');
  logger.info('listening', {
    url,
    publicUrl: config.publicUrl,
    database: handle.kind,
    ...(handle.kind === 'postgres' ? { databasePoolMax: config.databasePoolMax } : {}),
    storage: config.storage,
    dataDir: config.dataDir,
    diffWorkers: config.diffWorkers,
  });
  if (token && config.setupToken) {
    // The token came from SETUP_TOKEN (a secret): never copy it into the logs.
    logger.warn('no users yet; create the first admin with the SETUP_TOKEN value', {
      setupUrl: `${config.publicUrl}/ui/setup`,
    });
  } else if (token) {
    logger.warn('no users yet; create the first admin with the setup token', {
      setupToken: token,
      setupUrl: `${config.publicUrl}/ui/setup?token=${token}`,
      example: `curl -X POST ${config.publicUrl}/api/v1/setup -H 'content-type: application/json' -d '{"token":"${token}","email":"you@example.com","password":"at least 10 characters"}'`,
    });
  }

  return {
    url,
    setupToken: token,
    async stop() {
      // Stop accepting connections and let requests in flight (an upload mid-deploy) finish, up to
      // the grace period; then cut off whatever is left.
      await Promise.race([server.stop(false), Bun.sleep(config.shutdownGraceMs)]);
      await server.stop(true);
      await retention.stop();
      await pool.close();
      await handle.close();
    },
  };
}
