import { imageKey } from '../storage/storage';
import type { Deps } from './deps';
import { listProjects } from './projects';

export const DAY_MS = 24 * 60 * 60 * 1000;
/** Images younger than this are never collected: an upload may still be about to reference them. */
export const IMAGE_GRACE_MS = 60 * 60 * 1000;
const BATCH = 500;

export interface RetentionResult {
  buildsDeleted: number;
  imagesDeleted: number;
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
      await deps.db.transaction().execute(async (tx) => {
        await tx
          .updateTable('baselines')
          .set({ sourceCheckId: null })
          .where('sourceCheckId', 'in', tx.selectFrom('checks').select('id').where('buildId', 'in', ids))
          .execute();
        await tx.deleteFrom('builds').where('id', 'in', ids).execute();
      });
      deleted += ids.length;
    }
  }
  return deleted;
}

/**
 * Deletes images that no check (screenshot or diff) or baseline references and that have not
 * been stored or re-used for IMAGE_GRACE_MS: first the row (conditionally, so a concurrent
 * re-use wins), then the stored object.
 */
export async function deleteUnusedImages(deps: Pick<Deps, 'db' | 'storage'>, now: number): Promise<number> {
  const cutoff = now - IMAGE_GRACE_MS;
  const unused = deps.db
    .selectFrom('images')
    .where('images.createdAt', '<', cutoff)
    .where((eb) =>
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
      ]),
    );

  let deleted = 0;
  for (;;) {
    const candidates = await unused.select('images.sha').limit(BATCH).execute();
    let removedThisBatch = 0;
    for (const { sha } of candidates) {
      const removed = await deps.db
        .deleteFrom('images')
        .where('sha', 'in', unused.select('images.sha').where('images.sha', '=', sha))
        .executeTakeFirst();
      if (Number(removed.numDeletedRows) === 0) continue;
      await deps.storage.delete(imageKey(sha));
      removedThisBatch += 1;
    }
    deleted += removedThisBatch;
    if (candidates.length < BATCH || removedThisBatch === 0) break;
  }
  return deleted;
}

/** Spec §9: one retention pass. Safe to run concurrently with uploads and reviews. */
export async function runRetention(deps: Pick<Deps, 'db' | 'storage'>, now = Date.now()): Promise<RetentionResult> {
  const buildsDeleted = await deleteExpiredBuilds(deps, now);
  const imagesDeleted = await deleteUnusedImages(deps, now);
  return { buildsDeleted, imagesDeleted };
}
