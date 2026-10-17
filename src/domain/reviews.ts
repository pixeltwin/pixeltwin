import type { Db } from '../db/database';
import type { ActorKind, CheckReview, Project, ReviewAction, ReviewEvent, Suggestion } from '../db/schema';
import { AppError } from '../errors';
import { newId } from '../ids';
import type { Principal } from './auth/policy';
import { appendBaseline, findCurrentBaseline } from './baselines';
import { getBuildRow } from './builds';
import { type CheckView, getCheck } from './checks';
import type { Deps } from './deps';
import { checkOutdated, outdateOlder, restoreOutdated, supersedingCheck } from './outdated';
import { getProjectById } from './projects';
import { parseInput, reviewInputSchema } from './schemas';

/** The actor of an approval made by the project's auto-approve-new setting (no user or token). */
export const AUTO_APPROVER = 'auto';
export const AUTO_APPROVE_COMMENT = 'New screenshot approved automatically (project setting).';

type DbDeps = Pick<Deps, 'db'>;

/** Who reviews: a person, a project token (an agent or CI, with its name) or auto-approve. */
export interface ReviewActor {
  kind: ActorKind;
  id: string;
  /** A token's name; null for people (their email is looked up when shown). */
  name: string | null;
}

/** A bare id is a person, or auto-approve for AUTO_APPROVER. */
export function actorOf(actor: string | ReviewActor): ReviewActor {
  if (typeof actor !== 'string') return actor;
  return { kind: actor === AUTO_APPROVER ? 'auto' : 'user', id: actor, name: null };
}

export function actorFromPrincipal(principal: Principal): ReviewActor {
  return principal.kind === 'token'
    ? { kind: 'token', id: principal.id, name: principal.name }
    : { kind: 'user', id: principal.id, name: null };
}

/** What a review did: applied, or recorded as a suggestion for a person (agent review policy). */
export type ReviewOutcome = 'applied' | 'suggested';

/** A review event as the API shows it: who acted (kind and token name) and the reason. */
export type ReviewEventView = ReviewEvent;

/** The reason of a review: `reason`, or `comment` as older clients call it; empty is none. */
function reasonOf(input: unknown): string | null {
  const { comment, reason } = parseInput(reviewInputSchema, input);
  return reason || comment || null;
}

const NO_SUGGESTION = {
  suggestion: null,
  suggestedBy: null,
  suggestedByName: null,
  suggestionReason: null,
  suggestedAt: null,
} as const;

async function notReviewable(db: Db, checkId: string, allowed: CheckReview[]): Promise<AppError> {
  const check = await db.selectFrom('checks').select('review').where('id', '=', checkId).executeTakeFirst();
  if (!check) return new AppError('check_not_found', 404, `Check ${checkId} not found.`);
  if (check.review === 'outdated') {
    const screen = await screenOf(db, checkId);
    const newer = screen && (await supersedingCheck(db, screen));
    if (screen && newer) return checkOutdated(checkId, screen.buildNumber, newer);
  }
  return new AppError(
    'check_not_reviewable',
    409,
    `Check ${checkId} has review state "${check.review}"; expected ${allowed.map((s) => `"${s}"`).join(' or ')}.`,
  );
}

const APPROVABLE: CheckReview[] = ['pending', 'rejected'];

/** The check's screen (project, snapshot, branch) and build number; undefined when it does not exist. */
async function screenOf(db: Db, checkId: string) {
  const row = await db
    .selectFrom('checks')
    .innerJoin('builds', 'builds.id', 'checks.buildId')
    .select(['checks.projectId', 'checks.snapshotKey', 'builds.branch', 'builds.number'])
    .where('checks.id', '=', checkId)
    .executeTakeFirst();
  return row && { projectId: row.projectId, snapshotKey: row.snapshotKey, branch: row.branch, buildNumber: row.number };
}

/**
 * A newer build of the check's branch already approved its screen: marks the check outdated (if
 * it was waiting) and returns the 409 to report, or null when the check may be reviewed.
 */
async function outdatedGuard(tx: Db, checkId: string): Promise<AppError | null> {
  const screen = await screenOf(tx, checkId);
  if (!screen) return null;
  const newer = await supersedingCheck(tx, screen);
  if (!newer) return null;
  await tx
    .updateTable('checks')
    .set({ review: 'outdated', supersededBy: newer.id, updatedAt: Date.now() })
    .where('id', '=', checkId)
    .where('review', '=', 'pending')
    .execute();
  return checkOutdated(checkId, screen.buildNumber, newer);
}

/** Appends to the check's review history, inside the transaction that made the change. */
async function recordReview(
  tx: Db,
  event: { checkId: string; projectId: string; action: ReviewAction; actor: ReviewActor; comment: string | null },
): Promise<void> {
  const { actor, ...rest } = event;
  await tx
    .insertInto('reviewEvents')
    .values({
      id: newId('rev'),
      ...rest,
      actor: actor.id,
      actorKind: actor.kind,
      actorName: actor.name,
      createdAt: Date.now(),
    })
    .execute();
}

/** Who approved, rejected, undid or suggested a review of the check, newest first. */
export async function listReviews(deps: DbDeps, checkId: string): Promise<ReviewEventView[]> {
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
type ApproveOutcome = { approved: true } | { approved: false; error: AppError | null };

async function tryApprove(
  tx: Db,
  checkId: string,
  actor: ReviewActor,
  comment: string | null,
): Promise<ApproveOutcome> {
  const outdated = await outdatedGuard(tx, checkId);
  if (outdated) return { approved: false, error: outdated };
  const now = Date.now();
  const updated = await tx
    .updateTable('checks')
    .set({
      review: 'approved',
      reviewedBy: actor.id,
      reviewedAt: now,
      reviewComment: comment,
      ...NO_SUGGESTION,
      updatedAt: now,
    })
    .where('id', '=', checkId)
    .where('review', 'in', APPROVABLE)
    .executeTakeFirst();
  if (Number(updated.numUpdatedRows) === 0) return { approved: false, error: null };

  const check = await tx
    .selectFrom('checks')
    .innerJoin('builds', 'builds.id', 'checks.buildId')
    .select([
      'checks.projectId',
      'checks.snapshotKey',
      'checks.name',
      'checks.variant',
      'checks.imageSha',
      'checks.elementsSha',
      'builds.branch',
      'builds.number',
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
    approvedBy: actor.id,
    elementsSha: check.elementsSha,
  });
  await recordReview(tx, { checkId, projectId: check.projectId, action: 'approved', actor, comment });
  // Older builds of this branch must not put their screenshot of this screen back over it.
  await outdateOlder(
    tx,
    { projectId: check.projectId, snapshotKey: check.snapshotKey, branch: check.branch, buildNumber: check.number },
    checkId,
  );
  return { approved: true };
}

export async function approveCheck(
  deps: DbDeps,
  checkId: string,
  actor: string | ReviewActor,
  input: unknown = {},
): Promise<CheckView> {
  const comment = reasonOf(input);
  await applyApproval(deps, checkId, actorOf(actor), comment);
  return getCheck(deps, checkId);
}

async function applyApproval(deps: DbDeps, checkId: string, actor: ReviewActor, comment: string | null) {
  await deps.db.transaction().execute(async (tx) => {
    const outcome = await tryApprove(tx, checkId, actor, comment);
    if (!outcome.approved) throw outcome.error ?? (await notReviewable(tx, checkId, APPROVABLE));
  });
}

async function applyRejection(deps: DbDeps, checkId: string, actor: ReviewActor, comment: string | null) {
  await deps.db.transaction().execute(async (tx) => {
    const outdated = await outdatedGuard(tx, checkId);
    if (outdated) throw outdated;
    const now = Date.now();
    const updated = await tx
      .updateTable('checks')
      .set({
        review: 'rejected',
        reviewedBy: actor.id,
        reviewedAt: now,
        reviewComment: comment,
        ...NO_SUGGESTION,
        updatedAt: now,
      })
      .where('id', '=', checkId)
      .where('review', '=', 'pending')
      .executeTakeFirst();
    if (Number(updated.numUpdatedRows) === 0) throw await notReviewable(tx, checkId, ['pending']);
    const { projectId } = await tx
      .selectFrom('checks')
      .select('projectId')
      .where('id', '=', checkId)
      .executeTakeFirstOrThrow();
    await recordReview(tx, { checkId, projectId, action: 'rejected', actor, comment });
  });
}

export async function rejectCheck(
  deps: DbDeps,
  checkId: string,
  actor: string | ReviewActor,
  input: unknown = {},
): Promise<CheckView> {
  await applyRejection(deps, checkId, actorOf(actor), reasonOf(input));
  return getCheck(deps, checkId);
}

/** The diff percent a token's approval is measured by; null for a new screenshot (nothing to measure). */
function diffPercent(check: CheckView): number | null {
  return check.diff && 'percent' in check.diff && check.result === 'changed' ? check.diff.percent : null;
}

/**
 * Whether the project's agent review policy turns this token's review into a suggestion:
 * always with `suggest`; with `auto-below`, an approval of a diff above the limit (or of a new
 * screenshot, which has no diff to measure). Rejections apply under `auto-below`.
 */
export function suggestsInstead(project: Project, check: CheckView, action: 'approve' | 'reject'): boolean {
  if (project.agentReview === 'suggest') return true;
  if (project.agentReview !== 'auto-below' || action === 'reject') return false;
  const percent = diffPercent(check);
  return percent === null || percent > project.agentMaxDiffPercent;
}

function reasonRequired(project: Project, action: 'approve' | 'reject'): AppError {
  return new AppError(
    'reason_required',
    422,
    `Project "${project.slug}" reviews agents' decisions (agent review policy "${project.agentReview}"): a token must give a reason to ${action}.`,
  );
}

/** Records a token's review as the check's open suggestion; the check stays as it is. */
async function suggest(
  deps: DbDeps,
  checkId: string,
  action: Suggestion,
  actor: ReviewActor,
  reason: string,
): Promise<void> {
  const allowed: CheckReview[] = action === 'approve' ? APPROVABLE : ['pending'];
  await deps.db.transaction().execute(async (tx) => {
    const outdated = await outdatedGuard(tx, checkId);
    if (outdated) throw outdated;
    const now = Date.now();
    const updated = await tx
      .updateTable('checks')
      .set({
        suggestion: action,
        suggestedBy: actor.id,
        suggestedByName: actor.name,
        suggestionReason: reason,
        suggestedAt: now,
        updatedAt: now,
      })
      .where('id', '=', checkId)
      .where('review', 'in', allowed)
      .executeTakeFirst();
    if (Number(updated.numUpdatedRows) === 0) throw await notReviewable(tx, checkId, allowed);
    const { projectId } = await tx
      .selectFrom('checks')
      .select('projectId')
      .where('id', '=', checkId)
      .executeTakeFirstOrThrow();
    const event = action === 'approve' ? 'suggested_approval' : 'suggested_rejection';
    await recordReview(tx, { checkId, projectId, action: event, actor, comment: reason });
  });
}

/**
 * Approves or rejects a check as `actor`, through the project's agent review policy: a person's
 * review always applies; a token's applies with policy `off`, else it may be recorded as a
 * suggestion (the check stays pending) and must give a reason (422 reason_required).
 */
export async function reviewCheck(
  deps: DbDeps,
  checkId: string,
  action: 'approve' | 'reject',
  actor: string | ReviewActor,
  input: unknown = {},
): Promise<{ check: CheckView; outcome: ReviewOutcome }> {
  const who = actorOf(actor);
  const reason = reasonOf(input);
  if (who.kind === 'token') {
    const check = await getCheck(deps, checkId);
    const project = await getProjectById(deps, check.projectId);
    if (project.agentReview !== 'off' && !reason) throw reasonRequired(project, action);
    if (reason && suggestsInstead(project, check, action)) {
      await suggest(deps, checkId, action, who, reason);
      return { check: await getCheck(deps, checkId), outcome: 'suggested' };
    }
  }
  if (action === 'approve') await applyApproval(deps, checkId, who, reason);
  else await applyRejection(deps, checkId, who, reason);
  return { check: await getCheck(deps, checkId), outcome: 'applied' };
}

function noSuggestion(checkId: string): AppError {
  return new AppError('no_suggestion', 409, `Check ${checkId} has no open suggestion.`);
}

/**
 * A person accepts the open suggestion: approves or rejects as suggested, with the agent's
 * reason. Only people accept (a token would be accepting its own suggestion).
 */
export async function acceptSuggestion(deps: DbDeps, checkId: string, actor: string | ReviewActor): Promise<CheckView> {
  const who = actorOf(actor);
  if (who.kind === 'token') {
    throw new AppError('forbidden', 403, "Only a person can accept an agent's suggestion.");
  }
  const check = await getCheck(deps, checkId);
  if (!check.suggestion) throw noSuggestion(checkId);
  const { action, reason } = check.suggestion;
  if (action === 'approve') await applyApproval(deps, checkId, who, reason);
  else await applyRejection(deps, checkId, who, reason);
  return getCheck(deps, checkId);
}

/** Dismisses the open suggestion: the check keeps waiting for a review. */
export async function dismissSuggestion(
  deps: DbDeps,
  checkId: string,
  actor: string | ReviewActor,
  input: unknown = {},
): Promise<CheckView> {
  const who = actorOf(actor);
  const reason = reasonOf(input);
  await deps.db.transaction().execute(async (tx) => {
    const updated = await tx
      .updateTable('checks')
      .set({ ...NO_SUGGESTION, updatedAt: Date.now() })
      .where('id', '=', checkId)
      .where('suggestion', 'is not', null)
      .executeTakeFirst();
    if (Number(updated.numUpdatedRows) === 0) {
      await getCheck({ db: tx }, checkId);
      throw noSuggestion(checkId);
    }
    const { projectId } = await tx
      .selectFrom('checks')
      .select('projectId')
      .where('id', '=', checkId)
      .executeTakeFirstOrThrow();
    await recordReview(tx, { checkId, projectId, action: 'suggestion_dismissed', actor: who, comment: reason });
  });
  return getCheck(deps, checkId);
}

const RESETTABLE: CheckReview[] = ['approved', 'rejected'];

/**
 * UI spec §3.5, undo: returns an approved or rejected check to pending. Undoing an approval also
 * deletes the baseline it appended, but only while that baseline is still the current one for
 * its snapshot and branch and no later check was compared with it; otherwise the call fails with
 * 409 review_not_resettable. Allowed on finalized builds, like approve.
 */
export async function resetReview(deps: DbDeps, checkId: string, actor: string | ReviewActor): Promise<CheckView> {
  const who = actorOf(actor);
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
      // A later check compared with this baseline would be left pointing at nothing.
      const comparedLater = await tx
        .selectFrom('checks')
        .select('id')
        .where('baselineId', '=', current.id)
        .where('id', '!=', checkId)
        .executeTakeFirst();
      if (comparedLater) {
        throw new AppError(
          'review_not_resettable',
          409,
          `Check ${comparedLater.id} was already compared with the baseline check ${checkId} approved, so the approval cannot be undone.`,
        );
      }
      await tx.deleteFrom('baselines').where('id', '=', current.id).execute();
      // The older checks this approval outdated wait for review again.
      await restoreOutdated(tx, checkId);
    }
    const updated = await tx
      .updateTable('checks')
      .set({ review: 'pending', reviewedBy: null, reviewedAt: null, reviewComment: null, updatedAt: Date.now() })
      .where('id', '=', checkId)
      .where('review', '=', check.review)
      .executeTakeFirst();
    // A concurrent reset or review changed the state since the read above; the transaction rolls back.
    if (Number(updated.numUpdatedRows) === 0) throw await notReviewable(tx, checkId, RESETTABLE);
    await recordReview(tx, { checkId, projectId: check.projectId, action: 'reset', actor: who, comment: null });
  });
  return getCheck(deps, checkId);
}

/**
 * Approves every pending check in the build in one transaction. Checks approved meanwhile by a
 * concurrent request are skipped; `approved` counts only the checks this call approved. A token
 * goes through the agent review policy: what it may not approve itself becomes a suggestion
 * (`suggested`), and it must give a reason unless the policy is `off`.
 */
export async function approveBuild(
  deps: DbDeps,
  buildId: string,
  actor: string | ReviewActor,
  input: unknown = {},
): Promise<{ approved: number; suggested: number }> {
  const build = await getBuildRow(deps, buildId);
  const who = actorOf(actor);
  const reason = reasonOf(input);
  const toSuggest: string[] = [];
  if (who.kind === 'token') {
    const project = await getProjectById(deps, build.projectId);
    if (project.agentReview !== 'off') {
      if (!reason) throw reasonRequired(project, 'approve');
      const pending = await deps.db
        .selectFrom('checks')
        .select('id')
        .where('buildId', '=', buildId)
        .where('review', '=', 'pending')
        .orderBy('id')
        .execute();
      for (const { id } of pending) {
        if (suggestsInstead(project, await getCheck(deps, id), 'approve')) toSuggest.push(id);
      }
    }
  }
  let suggested = 0;
  for (const id of toSuggest) {
    try {
      await suggest(deps, id, 'approve', who, reason ?? '');
      suggested += 1;
    } catch (err) {
      // Reviewed or outdated meanwhile: nothing to suggest any more.
      if (!(err instanceof AppError) || err.status !== 409) throw err;
    }
  }
  const skip = new Set(toSuggest);
  const approved = await deps.db.transaction().execute(async (tx) => {
    const pending = await tx
      .selectFrom('checks')
      .select('id')
      .where('buildId', '=', buildId)
      .where('review', '=', 'pending')
      .orderBy('id')
      .execute();
    let count = 0;
    // Outdated checks are skipped (and marked so): a newer build already approved their screen.
    for (const { id } of pending) {
      if (skip.has(id)) continue;
      if ((await tryApprove(tx, id, who, reason)).approved) count += 1;
    }
    return count;
  });
  return { approved, suggested };
}
