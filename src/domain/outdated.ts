import type { Db } from '../db/database';
import { AppError } from '../errors';

// A check is `outdated` when a newer build of its branch approved the same screen (or a newer
// branch build was promoted onto it): approving the older screenshot would replace the newer
// baseline. Outdated checks need no review and cannot be approved or rejected.

interface Screen {
  projectId: string;
  snapshotKey: string;
  branch: string;
  /** The build number of the check in question. */
  buildNumber: number;
}

/** The approved check of a newer build whose baseline for this screen and branch still exists. */
export async function supersedingCheck(db: Db, screen: Screen): Promise<{ id: string; buildNumber: number } | null> {
  const row = await db
    .selectFrom('baselines')
    .innerJoin('checks as source', 'source.id', 'baselines.sourceCheckId')
    .innerJoin('builds as sourceBuild', 'sourceBuild.id', 'source.buildId')
    .select(['source.id as id', 'sourceBuild.number as buildNumber'])
    .where('baselines.projectId', '=', screen.projectId)
    .where('baselines.snapshotKey', '=', screen.snapshotKey)
    .where('baselines.branch', '=', screen.branch)
    .where('sourceBuild.number', '>', screen.buildNumber)
    .orderBy('sourceBuild.number', 'desc')
    .limit(1)
    .executeTakeFirst();
  return row ? { id: row.id, buildNumber: Number(row.buildNumber) } : null;
}

/**
 * After `by` (in build `buildNumber`) became the baseline: the screen's pending checks in older
 * builds are outdated; with `buildNumber: null`, in every build of the branch (a promotion).
 */
export async function outdateOlder(
  db: Db,
  screen: Omit<Screen, 'buildNumber'> & { buildNumber: number | null },
  by: string,
): Promise<void> {
  await db
    .updateTable('checks')
    .set({ review: 'outdated', supersededBy: by, updatedAt: Date.now() })
    .where('projectId', '=', screen.projectId)
    .where('snapshotKey', '=', screen.snapshotKey)
    .where('review', '=', 'pending')
    .where('buildId', 'in', (eb) => {
      const builds = eb
        .selectFrom('builds')
        .select('id')
        .where('projectId', '=', screen.projectId)
        .where('branch', '=', screen.branch);
      return screen.buildNumber === null ? builds : builds.where('number', '<', screen.buildNumber);
    })
    .execute();
}

/**
 * After the approval of `checkId` was undone (its baseline is gone): the checks it outdated wait
 * for review again, unless another newer approval still stands for them.
 */
export async function restoreOutdated(db: Db, checkId: string): Promise<void> {
  const rows = await db
    .selectFrom('checks')
    .innerJoin('builds', 'builds.id', 'checks.buildId')
    .select(['checks.id', 'checks.projectId', 'checks.snapshotKey', 'builds.branch', 'builds.number'])
    .where('checks.supersededBy', '=', checkId)
    .execute();
  for (const row of rows) {
    const still = await supersedingCheck(db, { ...row, buildNumber: row.number });
    await db
      .updateTable('checks')
      .set(
        still
          ? { supersededBy: still.id, updatedAt: Date.now() }
          : { review: 'pending', supersededBy: null, updatedAt: Date.now() },
      )
      .where('id', '=', row.id)
      .execute();
  }
}

/** 409 for a review of an outdated check, naming both builds. */
export function checkOutdated(checkId: string, buildNumber: number, newer: { buildNumber: number }): AppError {
  return new AppError(
    'check_outdated',
    409,
    `Check ${checkId} in build #${buildNumber} is outdated: build #${newer.buildNumber} already approved this screen, and an older screenshot must not replace it.`,
  );
}
