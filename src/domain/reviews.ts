import type { Db } from '../db/database';
import type { CheckReview, ReviewAction, ReviewEvent } from '../db/schema';
import { AppError } from '../errors';
import { newId } from '../ids';
import { appendBaseline, findCurrentBaseline } from './baselines';
import { getBuildRow } from './builds';
import { type CheckView, getCheck } from './checks';
import type { Deps } from './deps';
import { parseInput, reviewInputSchema } from './schemas';

type DbDeps = Pick<Deps, 'db'>;

async function notReviewable(db: Db, checkId: string, allowed: CheckReview[]): Promise<AppError> {
  const check = await db.selectFrom('checks').select('review').where('id', '=', checkId).executeTakeFirst();
  if (!check) return new AppError('check_not_found', 404, `Check ${checkId} not found.`);
  return new AppError(
    'check_not_reviewable',
    409,
    `Check ${checkId} has review state "${check.review}"; expected ${allowed.map((s) => `"${s}"`).join(' or ')}.`,
  );
}

const APPROVABLE: CheckReview[] = ['pending', 'rejected'];

/** Appends to the check's review history, inside the transaction that made the change. */
async function recordReview(
  tx: Db,
  event: { checkId: string; projectId: string; action: ReviewAction; actor: string; comment: string | null },
): Promise<void> {
  await tx
    .insertInto('reviewEvents')
    .values({ id: newId('rev'), ...event, createdAt: Date.now() })
    .execute();
}

/** Who approved, rejected or undid a review of the check, newest first. */
export async function listReviews(deps: DbDeps, checkId: string): Promise<ReviewEvent[]> {
  const check = await deps.db.selectFrom('checks').select('id').where('id', '=', checkId).executeTakeFirst();
  if (!check) throw new AppError('check_not_found', 404, `Check ${checkId} not found.`);
  return deps.db.selectFrom('reviewEvents').selectAll().where('checkId', '=', checkId).orderBy('id', 'desc').execute();
}

/**
 * Marks the check approved and appends its image as the new baseline on the build's branch.
 * Returns false, changing nothing, when the check is not approvable (missing, or already
 * approved by a concurrent request). The conditional update makes concurrent approvals of
 * one check produce one baseline.
 */
async function tryApprove(tx: Db, checkId: string, actor: string, comment: string | null): Promise<boolean> {
  const now = Date.now();
  const updated = await tx
    .updateTable('checks')
    .set({ review: 'approved', reviewedBy: actor, reviewedAt: now, reviewComment: comment, updatedAt: now })
    .where('id', '=', checkId)
    .where('review', 'in', APPROVABLE)
    .executeTakeFirst();
  if (Number(updated.numUpdatedRows) === 0) return false;

  const check = await tx
    .selectFrom('checks')
    .innerJoin('builds', 'builds.id', 'checks.buildId')
    .select([
      'checks.projectId',
      'checks.snapshotKey',
      'checks.name',
      'checks.variant',
      'checks.imageSha',
      'builds.branch',
    ])
    .where('checks.id', '=', checkId)
    .executeTakeFirstOrThrow();
  await appendBaseline(tx, {
    projectId: check.projectId,
    snapshotKey: check.snapshotKey,
    name: check.name,
    variant: check.variant,
    branch: check.branch,
    imageSha: check.imageSha,
    sourceCheckId: checkId,
    approvedBy: actor,
  });
  await recordReview(tx, { checkId, projectId: check.projectId, action: 'approved', actor, comment });
  return true;
}

export async function approveCheck(
  deps: DbDeps,
  checkId: string,
  actor: string,
  input: unknown = {},
): Promise<CheckView> {
  const { comment } = parseInput(reviewInputSchema, input);
  await deps.db.transaction().execute(async (tx) => {
    if (!(await tryApprove(tx, checkId, actor, comment ?? null))) throw await notReviewable(tx, checkId, APPROVABLE);
  });
  return getCheck(deps, checkId);
}

export async function rejectCheck(
  deps: DbDeps,
  checkId: string,
  actor: string,
  input: unknown = {},
): Promise<CheckView> {
  const { comment } = parseInput(reviewInputSchema, input);
  await deps.db.transaction().execute(async (tx) => {
    const now = Date.now();
    const updated = await tx
      .updateTable('checks')
      .set({ review: 'rejected', reviewedBy: actor, reviewedAt: now, reviewComment: comment ?? null, updatedAt: now })
      .where('id', '=', checkId)
      .where('review', '=', 'pending')
      .executeTakeFirst();
    if (Number(updated.numUpdatedRows) === 0) throw await notReviewable(tx, checkId, ['pending']);
    const { projectId } = await tx
      .selectFrom('checks')
      .select('projectId')
      .where('id', '=', checkId)
      .executeTakeFirstOrThrow();
    await recordReview(tx, { checkId, projectId, action: 'rejected', actor, comment: comment ?? null });
  });
  return getCheck(deps, checkId);
}

const RESETTABLE: CheckReview[] = ['approved', 'rejected'];

/**
 * UI spec §3.5, undo: returns an approved or rejected check to pending. Undoing an approval also
 * deletes the baseline it appended, but only while that baseline is still the current one for
 * its snapshot and branch; otherwise a later approval or a promotion builds on it, and the call
 * fails with 409 review_not_resettable. Allowed on finalized builds, like approve.
 */
export async function resetReview(deps: DbDeps, checkId: string, actor: string): Promise<CheckView> {
  await deps.db.transaction().execute(async (tx) => {
    const check = await tx
      .selectFrom('checks')
      .innerJoin('builds', 'builds.id', 'checks.buildId')
      .select(['checks.review', 'checks.projectId', 'checks.snapshotKey', 'builds.branch'])
      .where('checks.id', '=', checkId)
      .executeTakeFirst();
    if (!check || !RESETTABLE.includes(check.review)) throw await notReviewable(tx, checkId, RESETTABLE);

    if (check.review === 'approved') {
      const current = await findCurrentBaseline(tx, check.projectId, check.snapshotKey, check.branch);
      if (current?.sourceCheckId !== checkId) {
        throw new AppError(
          'review_not_resettable',
          409,
          `A newer baseline replaced the one check ${checkId} approved, so the approval cannot be undone.`,
        );
      }
      await tx.deleteFrom('baselines').where('id', '=', current.id).execute();
    }
    const updated = await tx
      .updateTable('checks')
      .set({ review: 'pending', reviewedBy: null, reviewedAt: null, reviewComment: null, updatedAt: Date.now() })
      .where('id', '=', checkId)
      .where('review', '=', check.review)
      .executeTakeFirst();
    // A concurrent reset or review changed the state since the read above; the transaction rolls back.
    if (Number(updated.numUpdatedRows) === 0) throw await notReviewable(tx, checkId, RESETTABLE);
    await recordReview(tx, { checkId, projectId: check.projectId, action: 'reset', actor, comment: null });
  });
  return getCheck(deps, checkId);
}

/**
 * Approves every pending check in the build in one transaction. Checks approved meanwhile by a
 * concurrent request are skipped; `approved` counts only the checks this call approved.
 */
export async function approveBuild(deps: DbDeps, buildId: string, actor: string): Promise<{ approved: number }> {
  await getBuildRow(deps, buildId);
  return deps.db.transaction().execute(async (tx) => {
    const pending = await tx
      .selectFrom('checks')
      .select('id')
      .where('buildId', '=', buildId)
      .where('review', '=', 'pending')
      .orderBy('id')
      .execute();
    let approved = 0;
    for (const { id } of pending) if (await tryApprove(tx, id, actor, null)) approved += 1;
    return { approved };
  });
}
