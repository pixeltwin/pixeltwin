import type { Db } from '../db/database';
import type {
  ActorKind,
  CheckReview,
  Project,
  RejectReason,
  ReviewAction,
  ReviewEvent,
  Suggestion,
} from '../db/schema';
import { AppError } from '../errors';
import { newId } from '../ids';
import type { Principal } from './auth/policy';
import { appendBaseline, findCurrentBaseline } from './baselines';
import { getBuildRow } from './builds';
import { type CheckView, getCheck } from './checks';
import type { Deps } from './deps';
import { markChecks } from './insight-marks';
import { checkOutdated, outdateOlder, restoreOutdated, supersedingCheck } from './outdated';
import { getProjectById } from './projects';
import { parseInput, reviewInputSchema } from './schemas';

/** The actor of an approval made by the project's auto-approve-new setting (no user or token). */
export const AUTO_APPROVER = 'auto';
export const AUTO_APPROVE_COMMENT = 'New screenshot approved automatically (project setting).';

type DbDeps = Pick<Deps, 'db' | 'events'>;

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

/** Why a review was made: the comment, and a rejection's category. */
export interface ReviewReason {
  /** `reason`, or `comment` as older clients call it; empty is none. */
  reason: string | null;
  reasonCode: RejectReason | null;
}

/** The reason of a review; a category only goes with a rejection (422 otherwise). */
export function reasonOf(input: unknown, action: 'approve' | 'reject' | 'dismiss'): ReviewReason {
  const { comment, reason, reasonCode } = parseInput(reviewInputSchema, input);
  if (reasonCode && action !== 'reject') {
    throw new AppError('validation_failed', 422, 'The request is invalid.', [
      { path: 'reasonCode', message: 'A reason code goes with a rejection only' },
    ]);
  }
  return { reason: reason || comment || null, reasonCode: reasonCode ?? null };
}

const NO_SUGGESTION = {
  suggestion: null,
  suggestedBy: null,
  suggestedByName: null,
  suggestionReason: null,
  suggestionReasonCode: null,
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
  await markChecks(tx, [checkId]);
  return checkOutdated(checkId, screen.buildNumber, newer);
}

/** Appends to the check's review history, inside the transaction that made the change. */
async function recordReview(
  tx: Db,
  event: {
    checkId: string;
    projectId: string;
    action: ReviewAction;
    actor: ReviewActor;
    comment: string | null;
    reasonCode?: RejectReason | null;
  },
): Promise<void> {
  const { actor, reasonCode, ...rest } = event;
  await tx
    .insertInto('reviewEvents')
    .values({
      id: newId('rev'),
      ...rest,
      actor: actor.id,
      actorKind: actor.kind,
      actorName: actor.name,
      reasonCode: reasonCode ?? null,
      createdAt: Date.now(),
    })
    .execute();
  // The build's day of insights is out of date (reviews count where their build was made).
  await markChecks(tx, [event.checkId]);
}

/** Who approved, rejected, undid or suggested a review of the check, newest first. */
export async function listReviews(deps: DbDeps, checkId: string): Promise<ReviewEvent[]> {
  const check = await deps.db.selectFrom('checks').select('id').where('id', '=', checkId).executeTakeFirst();
  if (!check) throw new AppError('check_not_found', 404, `Check ${checkId} not found.`);
  return deps.db.selectFrom('reviewEvents').selectAll().where('checkId', '=', checkId).orderBy('id', 'desc').execute();
}

type ApproveOutcome = { approved: true; builds: string[] } | { approved: false; error: AppError | null };

/**
 * Marks the check approved and appends its image as the new baseline on the build's branch,
 * inside the caller's transaction (announcing is the caller's, after commit). Returns false,
 * changing nothing, when the check is not approvable (missing, or already approved by a
 * concurrent request). The conditional update makes concurrent approvals of one check produce
 * one baseline. `builds` are the builds whose verdict may have changed.
 */
export async function tryApprove(
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
      reviewReasonCode: null,
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
      'checks.buildId',
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
  const older = await outdateOlder(
    tx,
    { projectId: check.projectId, snapshotKey: check.snapshotKey, branch: check.branch, buildNumber: check.number },
    checkId,
  );
  return { approved: true, builds: [check.buildId, ...older] };
}

/** A review the events sink hears about: who did it, as what, and why. */
export interface Reviewed {
  checkId: string;
  action: 'approved' | 'rejected' | 'reset';
  actor: ReviewActor;
  reason: string | null;
  /** A rejection's category. */
  reasonCode?: RejectReason | null;
}

/**
 * Tells the events sink (GitHub, webhooks) about reviews once their transaction committed: each
 * review, then the builds once (one code host sync and at most one verdict change per build,
 * however many checks the call reviewed). Suggestions are never announced: they change neither
 * the check nor the build's verdict.
 */
export async function announce(deps: DbDeps, reviewed: Reviewed[], builds: string[]): Promise<void> {
  if (!deps.events) return;
  for (const { actor, reasonCode, ...event } of reviewed) {
    await deps.events.checkReviewed({
      ...event,
      reasonCode: reasonCode ?? null,
      actor: actor.id,
      actorKind: actor.kind,
      actorName: actor.name,
    });
  }
  if (builds.length > 0) await deps.events.buildsChanged(builds);
}

export async function approveCheck(
  deps: DbDeps,
  checkId: string,
  actor: string | ReviewActor,
  input: unknown = {},
): Promise<CheckView> {
  await applyApproval(deps, checkId, actorOf(actor), reasonOf(input, 'approve').reason);
  return getCheck(deps, checkId);
}

/** Approves the check (409/404 when it cannot be) and announces the review. */
async function applyApproval(deps: DbDeps, checkId: string, actor: ReviewActor, reason: string | null) {
  const builds = await deps.db.transaction().execute(async (tx) => {
    const outcome = await tryApprove(tx, checkId, actor, reason);
    if (!outcome.approved) throw outcome.error ?? (await notReviewable(tx, checkId, APPROVABLE));
    return outcome.builds;
  });
  await announce(deps, [{ checkId, action: 'approved', actor, reason }], builds);
}

type RejectOutcome = { rejected: true; builds: string[] } | { rejected: false; error: AppError | null };

/** Marks a pending check rejected inside the caller's transaction, like tryApprove. */
export async function tryReject(
  tx: Db,
  checkId: string,
  actor: ReviewActor,
  why: ReviewReason,
): Promise<RejectOutcome> {
  const outdated = await outdatedGuard(tx, checkId);
  if (outdated) return { rejected: false, error: outdated };
  const now = Date.now();
  const updated = await tx
    .updateTable('checks')
    .set({
      review: 'rejected',
      reviewedBy: actor.id,
      reviewedAt: now,
      reviewComment: why.reason,
      reviewReasonCode: why.reasonCode,
      ...NO_SUGGESTION,
      updatedAt: now,
    })
    .where('id', '=', checkId)
    .where('review', '=', 'pending')
    .executeTakeFirst();
  if (Number(updated.numUpdatedRows) === 0) return { rejected: false, error: null };
  const { projectId, buildId } = await tx
    .selectFrom('checks')
    .select(['projectId', 'buildId'])
    .where('id', '=', checkId)
    .executeTakeFirstOrThrow();
  await recordReview(tx, {
    checkId,
    projectId,
    action: 'rejected',
    actor,
    comment: why.reason,
    reasonCode: why.reasonCode,
  });
  return { rejected: true, builds: [buildId] };
}

/** Rejects the pending check (409/404 when it cannot be) and announces the review. */
async function applyRejection(deps: DbDeps, checkId: string, actor: ReviewActor, why: ReviewReason) {
  const builds = await deps.db.transaction().execute(async (tx) => {
    const outcome = await tryReject(tx, checkId, actor, why);
    if (!outcome.rejected) throw outcome.error ?? (await notReviewable(tx, checkId, ['pending']));
    return outcome.builds;
  });
  await announce(deps, [{ checkId, action: 'rejected', actor, ...why }], builds);
}

export async function rejectCheck(
  deps: DbDeps,
  checkId: string,
  actor: string | ReviewActor,
  input: unknown = {},
): Promise<CheckView> {
  await applyRejection(deps, checkId, actorOf(actor), reasonOf(input, 'reject'));
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

function reasonCodeRequired(project: Project): AppError {
  return new AppError(
    'reason_code_required',
    422,
    `Project "${project.slug}" reviews agents' decisions (agent review policy "${project.agentReview}"): a token must give a reasonCode to reject (not_loaded, late_asset, animation, dynamic_data, environment, real_bug or other).`,
  );
}

/** Under an agent review policy a token gives a reason, and a category to reject. */
function requireReason(project: Project, action: 'approve' | 'reject', why: ReviewReason): void {
  if (!why.reason) throw reasonRequired(project, action);
  if (action === 'reject' && !why.reasonCode) throw reasonCodeRequired(project);
}

function suggestable(action: Suggestion): CheckReview[] {
  return action === 'approve' ? APPROVABLE : ['pending'];
}

/**
 * Records a token's review as the check's open suggestion inside the caller's transaction; the
 * check stays as it is and nothing is announced. Returns the error (outdated) or null when the
 * check could not take the suggestion, true when it did.
 */
export async function trySuggest(
  tx: Db,
  checkId: string,
  action: Suggestion,
  actor: ReviewActor,
  why: ReviewReason,
): Promise<{ suggested: true } | { suggested: false; error: AppError | null }> {
  const outdated = await outdatedGuard(tx, checkId);
  if (outdated) return { suggested: false, error: outdated };
  const now = Date.now();
  const updated = await tx
    .updateTable('checks')
    .set({
      suggestion: action,
      suggestedBy: actor.id,
      suggestedByName: actor.name,
      suggestionReason: why.reason,
      suggestionReasonCode: action === 'reject' ? why.reasonCode : null,
      suggestedAt: now,
      updatedAt: now,
    })
    .where('id', '=', checkId)
    .where('review', 'in', suggestable(action))
    .executeTakeFirst();
  if (Number(updated.numUpdatedRows) === 0) return { suggested: false, error: null };
  const { projectId } = await tx
    .selectFrom('checks')
    .select('projectId')
    .where('id', '=', checkId)
    .executeTakeFirstOrThrow();
  const event = action === 'approve' ? 'suggested_approval' : 'suggested_rejection';
  await recordReview(tx, {
    checkId,
    projectId,
    action: event,
    actor,
    comment: why.reason,
    reasonCode: action === 'reject' ? why.reasonCode : null,
  });
  return { suggested: true };
}

/** Records a token's review as the check's open suggestion (409/404 when it cannot take one). */
async function suggest(
  deps: DbDeps,
  checkId: string,
  action: Suggestion,
  actor: ReviewActor,
  why: ReviewReason,
): Promise<void> {
  await deps.db.transaction().execute(async (tx) => {
    const outcome = await trySuggest(tx, checkId, action, actor, why);
    if (!outcome.suggested) throw outcome.error ?? (await notReviewable(tx, checkId, suggestable(action)));
  });
}

/**
 * Approves or rejects a check as `actor`, through the project's agent review policy: a person's
 * review always applies; a token's applies with policy `off`, else it may be recorded as a
 * suggestion (the check stays pending) and must give a reason (422 reason_required), and a
 * category to reject (422 reason_code_required).
 */
export async function reviewCheck(
  deps: DbDeps,
  checkId: string,
  action: 'approve' | 'reject',
  actor: string | ReviewActor,
  input: unknown = {},
): Promise<{ check: CheckView; outcome: ReviewOutcome }> {
  const who = actorOf(actor);
  const why = reasonOf(input, action);
  if (who.kind === 'token') {
    const check = await getCheck(deps, checkId);
    const project = await getProjectById(deps, check.projectId);
    if (project.agentReview !== 'off') requireReason(project, action, why);
    if (why.reason && suggestsInstead(project, check, action)) {
      await suggest(deps, checkId, action, who, why);
      return { check: await getCheck(deps, checkId), outcome: 'suggested' };
    }
  }
  if (action === 'approve') await applyApproval(deps, checkId, who, why.reason);
  else await applyRejection(deps, checkId, who, why);
  return { check: await getCheck(deps, checkId), outcome: 'applied' };
}

/**
 * How the project's agent review policy splits a token's review of these checks: those it may
 * apply itself and those that become suggestions (`suggestsInstead`). Null when everything
 * applies: a person, auto-approve, or policy `off`. A token must give a reason under a policy
 * (422 reason_required), and a category to reject (422 reason_code_required).
 */
export async function splitByPolicy(
  deps: DbDeps,
  projectId: string,
  who: ReviewActor,
  why: ReviewReason,
  action: 'approve' | 'reject',
  checkIds: string[],
): Promise<{ apply: Set<string>; suggest: Set<string> } | null> {
  if (who.kind !== 'token') return null;
  const project = await getProjectById(deps, projectId);
  if (project.agentReview === 'off') return null;
  requireReason(project, action, why);
  const split = { apply: new Set<string>(), suggest: new Set<string>() };
  for (const id of checkIds) {
    if (suggestsInstead(project, await getCheck(deps, id), action)) split.suggest.add(id);
    else split.apply.add(id);
  }
  return split;
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
  const { action, reason, reasonCode } = check.suggestion;
  if (action === 'approve') await applyApproval(deps, checkId, who, reason);
  else await applyRejection(deps, checkId, who, { reason, reasonCode });
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
  const { reason } = reasonOf(input, 'dismiss');
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
  const builds = await deps.db.transaction().execute((tx) => resetIn(tx, checkId, who));
  await announce(deps, [{ checkId, action: 'reset', actor: who, reason: null }], builds);
  return getCheck(deps, checkId);
}

/**
 * resetReview inside the caller's transaction: throws (and so rolls it back) when it cannot undo.
 * Returns the builds whose verdict may have changed; announcing is the caller's, after commit.
 */
export async function resetIn(tx: Db, checkId: string, who: ReviewActor): Promise<string[]> {
  const check = await tx
    .selectFrom('checks')
    .innerJoin('builds', 'builds.id', 'checks.buildId')
    .select(['checks.review', 'checks.projectId', 'checks.buildId', 'checks.snapshotKey', 'builds.branch'])
    .where('checks.id', '=', checkId)
    .executeTakeFirst();
  if (!check || !RESETTABLE.includes(check.review)) throw await notReviewable(tx, checkId, RESETTABLE);

  const changed = [check.buildId];
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
    changed.push(...(await restoreOutdated(tx, checkId)));
  }
  const updated = await tx
    .updateTable('checks')
    .set({
      review: 'pending',
      reviewedBy: null,
      reviewedAt: null,
      reviewComment: null,
      reviewReasonCode: null,
      updatedAt: Date.now(),
    })
    .where('id', '=', checkId)
    .where('review', '=', check.review)
    .executeTakeFirst();
  // A concurrent reset or review changed the state since the read above; the transaction rolls back.
  if (Number(updated.numUpdatedRows) === 0) throw await notReviewable(tx, checkId, RESETTABLE);
  await recordReview(tx, { checkId, projectId: check.projectId, action: 'reset', actor: who, comment: null });
  return changed;
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
  const why = reasonOf(input, 'approve');
  const { reason } = why;
  const pendingIds = async (db: Db) =>
    (
      await db
        .selectFrom('checks')
        .select('id')
        .where('buildId', '=', buildId)
        .where('review', '=', 'pending')
        .orderBy('id')
        .execute()
    ).map((r) => r.id);
  // Under a policy a token approves only the checks judged here; one posted meanwhile waits.
  const split = await splitByPolicy(deps, build.projectId, who, why, 'approve', await pendingIds(deps.db));
  const allowed = split?.apply ?? null;
  let suggested = 0;
  for (const id of split?.suggest ?? []) {
    try {
      await suggest(deps, id, 'approve', who, why);
      suggested += 1;
    } catch (err) {
      // Reviewed or outdated meanwhile: nothing to suggest any more.
      if (!(err instanceof AppError) || err.status !== 409) throw err;
    }
  }
  // Only suggestions (policy `suggest`, or nothing below the limit): no verdict changed.
  if (allowed && allowed.size === 0) return { approved: 0, suggested };
  const { approved, builds } = await deps.db.transaction().execute(async (tx) => {
    const approved: string[] = [];
    const builds = [buildId];
    // Outdated checks are skipped (and marked so): a newer build already approved their screen.
    for (const id of await pendingIds(tx)) {
      if (allowed && !allowed.has(id)) continue;
      const outcome = await tryApprove(tx, id, who, reason);
      if (!outcome.approved) continue;
      approved.push(id);
      builds.push(...outcome.builds);
    }
    return { approved, builds };
  });
  await announce(
    deps,
    approved.map((checkId) => ({ checkId, action: 'approved' as const, actor: who, reason })),
    builds,
  );
  return { approved: approved.length, suggested };
}
