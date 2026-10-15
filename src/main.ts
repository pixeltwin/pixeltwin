import { type Config, ConfigError, loadConfig } from './config';
import { migrateToLatest, openDatabase } from './db/database';
import { randomBase62 } from './domain/auth/random';
import { setPasswordByEmail } from './domain/auth/users';
import { AppError } from './errors';
import { createLogger } from './log';
import { type RunningServer, startServer } from './server';

const USAGE = `Usage: pixeltwin <command>

Commands:
  serve                          Start the server (default)
  migrate                        Apply database migrations and exit
  healthcheck                    Exit 0 when the server on PORT answers /healthz (for Docker)
  admin reset-password <email>   Give a user a new random password and print it

Configuration comes from environment variables; see the README.`;

async function withDatabase<T>(config: Config, run: (db: ReturnType<typeof openDatabase>) => Promise<T>): Promise<T> {
  const handle = openDatabase(config.databaseUrl);
  try {
    return await run(handle);
  } finally {
    await handle.close();
  }
}

/** Runs a command. Returns the exit code, or null when the server keeps running. */
export async function main(
  argv: string[],
  env: Record<string, string | undefined> = process.env,
  out: { log(line: string): void; error(line: string): void } = console,
): Promise<number | null> {
  const [command = 'serve', ...args] = argv;
  if (command === 'help' || command === '--help' || command === '-h') {
    out.log(USAGE);
    return 0;
  }

  let config: Config;
  try {
    config = loadConfig(env);
  } catch (err) {
    if (err instanceof ConfigError) {
      out.error(err.message);
      return 2;
    }
    throw err;
  }

  try {
    switch (command) {
      case 'serve': {
        let server: RunningServer;
        try {
          server = await startServer(config, createLogger(config.logLevel));
        } catch (err) {
          if ((err as { code?: unknown }).code === 'EADDRINUSE') {
            out.error(`Port ${config.port} is already in use. Stop the other process or set PORT.`);
            return 1;
          }
          throw err;
        }
        const shutdown = async () => {
          await server.stop();
          process.exit(0);
        };
        process.once('SIGINT', shutdown);
        process.once('SIGTERM', shutdown);
        return null;
      }
      case 'healthcheck': {
        try {
          const res = await fetch(`http://127.0.0.1:${config.port}/healthz`, { signal: AbortSignal.timeout(3000) });
          out.log(res.ok ? 'ok' : `unhealthy: HTTP ${res.status}`);
          return res.ok ? 0 : 1;
        } catch (err) {
          out.error(`unhealthy: ${err instanceof Error ? err.message : String(err)}`);
          return 1;
        }
      }
      case 'migrate': {
        const applied = await withDatabase(config, (h) => migrateToLatest(h.db));
        out.log(applied.length > 0 ? `Applied: ${applied.join(', ')}` : 'Database is up to date.');
        return 0;
      }
      case 'admin': {
        const [sub, email] = args;
        if (sub !== 'reset-password' || !email) break;
        const password = randomBase62(20);
        await withDatabase(config, (h) => setPasswordByEmail({ db: h.db }, email, password));
        out.log(`New password for ${email.trim().toLowerCase()}: ${password}`);
        return 0;
      }
    }
  } catch (err) {
    if (err instanceof AppError) {
      out.error(err.detail);
      return 1;
    }
    throw err;
  }

  out.error(USAGE);
  return 2;
}

if (import.meta.main) {
  try {
    const code = await main(Bun.argv.slice(2));
    if (code !== null) process.exit(code);
  } catch (err) {
    // A short message, not a stack trace over minified source from the compiled binary.
    console.error(`pixeltwin: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
