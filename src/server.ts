import type { Config } from './config';
import { migrateToLatest, openDatabase } from './db/database';
import { DiffPool } from './diff/pool';
import { SetupState } from './domain/auth/setup';
import type { Deps } from './domain/deps';
import { startDigestJob } from './domain/insights-digest';
import { startRetentionJob } from './domain/retention-job';
import { SecretBox } from './domain/secrets';
import { createApp } from './http/app';
import { Metrics, metricsHandler } from './http/metrics';
import { LoginLimiter } from './http/rate-limit';
import type { Logger } from './log';
import { MailOutbox } from './mail/outbox';
import { smtpMailer } from './mail/smtp';
import { Notifier } from './notify/notifier';
import { DatabaseStorage } from './storage/database';
import { LocalStorage } from './storage/local';

export interface RunningServer {
  /** Where the server listens, e.g. `http://localhost:8080`. */
  url: string;
  /** Where Prometheus metrics are served (METRICS=1), e.g. `http://localhost:9464/metrics`; else null. */
  metricsUrl: string | null;
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
    runThumb: pool.thumb,
    diffBacklog: () => pool.backlog,
    limits: { maxImageBytes: config.maxImageBytes, maxImagePixels: config.maxImagePixels },
    secrets: new SecretBox(config.secretKey),
  };
  const notifier = new Notifier({
    deps,
    publicUrl: config.publicUrl,
    logger,
    blockPrivate: config.outboundBlockPrivate,
  });
  deps.events = notifier;
  const { state, token } = await SetupState.init(deps, config.setupToken);
  // Invites, reset links and sign-up mail wait in the database and are sent in the background.
  const mailer =
    config.smtpUrl && config.smtpFrom
      ? new MailOutbox({ deps, smtp: smtpMailer({ url: config.smtpUrl, from: config.smtpFrom }), logger })
      : null;
  const metrics = config.metricsPort === null ? null : new Metrics();
  const app = createApp({
    deps,
    config,
    logger,
    setup: state,
    loginLimiter: new LoginLimiter(),
    notifier,
    mailer,
    metrics,
  });

  const server = Bun.serve({
    port: config.port,
    fetch: app.fetch,
    // Upper bound before the app's own per-route limits apply.
    maxRequestBodySize: Math.ceil(config.maxImageBytes / 3) * 4 + 1024 * 1024,
  });
  // A port of its own: the Service's http port (and so the Ingress) never routes to it.
  const metricsServer = metrics
    ? Bun.serve({
        port: config.metricsPort as number,
        fetch: metricsHandler(metrics, {
          db: handle.db,
          diffBacklog: () => pool.backlog,
          diffWorkers: config.diffWorkers,
        }),
      })
    : null;
  const retention = startRetentionJob({ deps, handle, logger });
  // The weekly Insights digest, on the server's time zone; once per slot across replicas.
  const digests = startDigestJob({ deps, publicUrl: config.publicUrl, mailer, logger });
  notifier.start();
  mailer?.start();
  const url = server.url.href.replace(/\/$/, '');
  logger.info('listening', {
    url,
    publicUrl: config.publicUrl,
    database: handle.kind,
    ...(handle.kind === 'postgres' ? { databasePoolMax: config.databasePoolMax } : {}),
    storage: config.storage,
    dataDir: config.dataDir,
    secretsEncrypted: config.secretKey !== null,
    diffWorkers: config.diffWorkers,
    ...(metricsServer ? { metricsPort: metricsServer.port } : {}),
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
    metricsUrl: metricsServer ? `${metricsServer.url.href.replace(/\/$/, '')}/metrics` : null,
    setupToken: token,
    async stop() {
      // Stop accepting connections and let requests in flight (an upload mid-deploy) finish, up to
      // the grace period; then cut off whatever is left.
      await Promise.race([server.stop(false), Bun.sleep(config.shutdownGraceMs)]);
      await server.stop(true);
      await metricsServer?.stop(true);
      await retention.stop();
      await digests.stop();
      await notifier.stop();
      await mailer?.stop();
      await pool.close();
      await handle.close();
    },
  };
}
