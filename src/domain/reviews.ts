import type { Db } from '../db/database';
import type { CheckReview } from '../db/schema';
import { AppError } from '../errors';
import { appendBaseline } from './baselines';
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

/**
 * Marks the check approved and appends its image as the new baseline on the build's branch.
 * The conditional update makes concurrent approvals of one check produce one baseline.
 */
async function approveInTransaction(tx: Db, checkId: string, actor: string, comment: string | null): Promise<void> {
  const allowed: CheckReview[] = ['pending', 'rejected'];
  const now = Date.now();
  const updated = await tx
    .updateTable('checks')
    .set({ review: 'approved', reviewedBy: actor, reviewedAt: now, reviewComment: comment, updatedAt: now })
    .where('id', '=', checkId)
    .where('review', 'in', allowed)
    .executeTakeFirst();
  if (Number(updated.numUpdatedRows) === 0) throw await notReviewable(tx, checkId, allowed);

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
}

export async function approveCheck(
  deps: DbDeps,
  checkId: string,
  actor: string,
  input: unknown = {},
): Promise<CheckView> {
  const { comment } = parseInput(reviewInputSchema, input);
  await deps.db.transaction().execute((tx) => approveInTransaction(tx, checkId, actor, comment ?? null));
  return getCheck(deps, checkId);
}

export async function rejectCheck(
  deps: DbDeps,
  checkId: string,
  actor: string,
  input: unknown = {},
): Promise<CheckView> {
  const { comment } = parseInput(reviewInputSchema, input);
  const now = Date.now();
  const updated = await deps.db
    .updateTable('checks')
    .set({ review: 'rejected', reviewedBy: actor, reviewedAt: now, reviewComment: comment ?? null, updatedAt: now })
    .where('id', '=', checkId)
    .where('review', '=', 'pending')
    .executeTakeFirst();
  if (Number(updated.numUpdatedRows) === 0) throw await notReviewable(deps.db, checkId, ['pending']);
  return getCheck(deps, checkId);
}

/** Approves every pending check in the build in one transaction. */
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
    for (const { id } of pending) await approveInTransaction(tx, id, actor, null);
    return { approved: pending.length };
  });
}
