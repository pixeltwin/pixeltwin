import { openDatabase } from '../db/database';
import { SetupState } from '../domain/auth/setup';
import { silentLogger } from '../log';
import { Notifier } from '../notify/notifier';
import { MemoryStorage } from '../storage/memory';
import { createApp } from './app';
import { openApiDocument } from './docs';
import { LoginLimiter } from './rate-limit';

/**
 * The OpenAPI document of a throwaway app (in-memory database, never queried). Used by the
 * contract test and `bun run openapi`, so both see exactly what the server serves.
 */
export function buildOpenApiDocument() {
  const handle = openDatabase('sqlite::memory:');
  const deps = {
    db: handle.db,
    storage: new MemoryStorage(),
    runDiff: async () => ({ kind: 'error' as const, code: 'diff_failed' as const, message: 'unused' }),
    limits: { maxImageBytes: 10 * 1024 * 1024, maxImagePixels: 40_000_000 },
  };
  const publicUrl = 'http://localhost:8080';
  const app = createApp({
    deps,
    notifier: new Notifier({ deps, publicUrl, logger: silentLogger, blockPrivate: false, autoDeliver: false }),
    config: { publicUrl: 'http://localhost:8080', maxImageBytes: 10 * 1024 * 1024, diffQueueMax: 0, diffWorkers: 1 },
    logger: silentLogger,
    setup: new SetupState(null),
    loginLimiter: new LoginLimiter(),
  });
  const document = openApiDocument(app);
  void handle.close();
  return document;
}
