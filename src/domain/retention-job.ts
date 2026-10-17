import { sql } from 'kysely';
import type { DatabaseHandle } from '../db/database';
import type { Logger } from '../log';
import type { Deps } from './deps';
import { type RetentionResult, runRetention } from './retention';

/** Arbitrary but fixed: every pixeltwin replica uses the same advisory lock id. */
export const RETENTION_LOCK_KEY = 74_202_115;
export const RETENTION_INTERVAL_MS = 60 * 60 * 1000;

export interface RetentionJob {
  /** Runs one pass now. Null when another replica holds the lock or the pass failed (it is logged). */
  runNow(): Promise<RetentionResult | null>;
  /** Cancels the schedule and waits for a pass that is already running. */
  stop(): Promise<void>;
}

/**
 * Spec §9: retention runs hourly in-process. On Postgres a session advisory lock, held on one
 * pooled connection for the whole pass, makes sure only one replica runs it at a time.
 */
export function startRetentionJob(options: {
  deps: Pick<Deps, 'db' | 'storage'>;
  handle: Pick<DatabaseHandle, 'kind'>;
  logger: Logger;
  intervalMs?: number;
  firstRunDelayMs?: number;
}): RetentionJob {
  const { deps, handle, logger } = options;
  let running: Promise<RetentionResult | null> | null = null;

  const pass = async (): Promise<RetentionResult | null> => {
    if (handle.kind !== 'postgres') return runRetention(deps);
    return deps.db.connection().execute(async (conn) => {
      const locked = await sql<{ ok: boolean }>`select pg_try_advisory_lock(${RETENTION_LOCK_KEY}) as ok`.execute(conn);
      if (!locked.rows[0]?.ok) return null;
      try {
        return await runRetention({ ...deps, db: conn });
      } finally {
        await sql`select pg_advisory_unlock(${RETENTION_LOCK_KEY})`.execute(conn);
      }
    });
  };

  const runNow = (): Promise<RetentionResult | null> => {
    // Never overlap with ourselves, e.g. a slow pass and the next tick.
    running ??= pass()
      .then((result) => {
        if (result && (result.buildsDeleted > 0 || result.imagesDeleted > 0 || result.signupsDeleted > 0))
          logger.info('retention', { ...result });
        return result;
      })
      .catch((err: unknown) => {
        logger.error('retention failed', { error: err instanceof Error ? err.message : String(err) });
        return null;
      })
      .finally(() => {
        running = null;
      });
    return running;
  };

  const first = setTimeout(() => void runNow(), options.firstRunDelayMs ?? 60_000);
  const interval = setInterval(() => void runNow(), options.intervalMs ?? RETENTION_INTERVAL_MS);
  first.unref();
  interval.unref();

  return {
    runNow,
    async stop() {
      clearTimeout(first);
      clearInterval(interval);
      await running;
    },
  };
}
