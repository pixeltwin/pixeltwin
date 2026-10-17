import type { ExpressionBuilder } from 'kysely';
import type { DB } from '../db/schema';
import { imageKey } from '../storage/storage';
import { removeBuilds } from './builds';
import type { Deps } from './deps';
import { listProjects } from './projects';
import { thumbKeys } from './thumbs';

export const DAY_MS = 24 * 60 * 60 * 1000;
/** Images younger than this are never collected: an upload may still be about to reference them. */
export const IMAGE_GRACE_MS = 60 * 60 * 1000;
const BATCH = 500;

export interface RetentionResult {
  buildsDeleted: number;
  imagesDeleted: number;
  elementSetsDeleted: number;
}

/**
 * Deletes builds (with their checks) older than their project's `retentionDays`, whatever their
 * state: a build still open after that long was abandoned. Baselines are kept; their
 * `sourceCheckId` is cleared when it pointed at a deleted check.
 */
export async function deleteExpiredBuilds(deps: Pick<Deps, 'db'>, now: number): Promise<number> {
  let deleted = 0;
  for (const project of await listProjects(deps)) {
    const cutoff = now - project.retentionDays * DAY_MS;
    for (;;) {
      const rows = await deps.db
        .selectFrom('builds')
        .select('id')
        .where('projectId', '=', project.id)
        .where('createdAt', '<', cutoff)
        .limit(BATCH)
        .execute();
      if (rows.length === 0) break;
      const ids = rows.map((r) => r.id);
      await removeBuilds(deps.db, ids);
      deleted += ids.length;
    }
  }
  return deleted;
}

/**
 * Deletes images that no check (screenshot or diff) or baseline references and that have not
 * been stored or re-used for IMAGE_GRACE_MS. Each image goes in its own transaction: the row is
 * deleted with every condition on the row itself, then the stored object, then the commit. A
 * concurrent upload of the same image waits for that commit (row lock on Postgres, the single
 * connection on SQLite), finds the object gone and writes it again; a failed storage delete rolls
 * the row back, so the file is retried on the next pass instead of being orphaned.
 */
export async function deleteUnusedImages(deps: Pick<Deps, 'db' | 'storage'>, now: number): Promise<number> {
  const cutoff = now - IMAGE_GRACE_MS;
  const unreferenced = (eb: ExpressionBuilder<DB, 'images'>) =>
    eb.and([
      eb.not(
        eb.exists(
          eb
            .selectFrom('checks')
            .select('checks.id')
            .where((c) =>
              c.or([
                c('checks.imageSha', '=', c.ref('images.sha')),
                c('checks.diffImageSha', '=', c.ref('images.sha')),
              ]),
            ),
        ),
      ),
      eb.not(
        eb.exists(
          eb.selectFrom('baselines').select('baselines.id').where('baselines.imageSha', '=', eb.ref('images.sha')),
        ),
      ),
    ]);

  let deleted = 0;
  for (;;) {
    const candidates = await deps.db
      .selectFrom('images')
      .select('images.sha')
      .where('images.createdAt', '<', cutoff)
      .where(unreferenced)
      .limit(BATCH)
      .execute();
    let removedThisBatch = 0;
    for (const { sha } of candidates) {
      const removed = await deps.db.transaction().execute(async (tx) => {
        const result = await tx
          .deleteFrom('images')
          .where('images.sha', '=', sha)
          .where('images.createdAt', '<', cutoff)
          .where(unreferenced)
          .executeTakeFirst();
        if (Number(result.numDeletedRows) === 0) return false;
        await deps.storage.delete(imageKey(sha));
        for (const key of thumbKeys(sha)) await deps.storage.delete(key);
        return true;
      });
      if (removed) removedThisBatch += 1;
    }
    deleted += removedThisBatch;
    if (candidates.length < BATCH || removedThisBatch === 0) break;
  }
  return deleted;
}

/**
 * Deletes element sets that no check or baseline points at and that were not stored or re-used
 * for IMAGE_GRACE_MS (a check about to point at one refreshes it first). One statement per batch:
 * every condition is on the row itself, so a set re-used meanwhile is kept.
 */
export async function deleteUnusedElementSets(deps: Pick<Deps, 'db'>, now: number): Promise<number> {
  const cutoff = now - IMAGE_GRACE_MS;
  const unreferenced = (eb: ExpressionBuilder<DB, 'elementSets'>) =>
    eb.and([
      eb.not(
        eb.exists(
          eb.selectFrom('checks').select('checks.id').where('checks.elementsSha', '=', eb.ref('elementSets.sha')),
        ),
      ),
      eb.not(
        eb.exists(
          eb
            .selectFrom('baselines')
            .select('baselines.id')
            .where('baselines.elementsSha', '=', eb.ref('elementSets.sha')),
        ),
      ),
    ]);
  let deleted = 0;
  for (;;) {
    const unused = await deps.db
      .selectFrom('elementSets')
      .select('elementSets.sha')
      .where('elementSets.createdAt', '<', cutoff)
      .where(unreferenced)
      .limit(BATCH)
      .execute();
    if (unused.length === 0) break;
    const result = await deps.db
      .deleteFrom('elementSets')
      .where(
        'elementSets.sha',
        'in',
        unused.map((u) => u.sha),
      )
      .where('elementSets.createdAt', '<', cutoff)
      .where(unreferenced)
      .executeTakeFirst();
    const removed = Number(result.numDeletedRows);
    deleted += removed;
    if (unused.length < BATCH || removed === 0) break;
  }
  return deleted;
}

/** Spec §9: one retention pass. Safe to run concurrently with uploads and reviews. */
export async function runRetention(deps: Pick<Deps, 'db' | 'storage'>, now = Date.now()): Promise<RetentionResult> {
  const buildsDeleted = await deleteExpiredBuilds(deps, now);
  const imagesDeleted = await deleteUnusedImages(deps, now);
  const elementSetsDeleted = await deleteUnusedElementSets(deps, now);
  return { buildsDeleted, imagesDeleted, elementSetsDeleted };
}
