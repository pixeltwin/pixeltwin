import type { CheckReview, Suggestion } from '../db/schema';
import type { DiffData, Region } from '../diff/types';
import { AppError } from '../errors';
import { getBuild, getBuildRow } from './builds';
import type { Deps } from './deps';
import {
  actorOf,
  announce,
  type ReviewActor,
  type Reviewed,
  reasonOf,
  resetIn,
  splitByPolicy,
  tryApprove,
  tryReject,
  trySuggest,
} from './reviews';
import { groupResetSchema, groupReviewSchema, parseInput } from './schemas';
import type { Verdict } from './verdict';

// Change groups: checks of one build with exactly the same changes (the same change key, see
// diff/fingerprint.ts), so a header changed on 40 screens is reviewed once. A check with the
// header change and one more change of its own is not in the header's group: groups are exact,
// so approving a group never approves a change nobody looked at. A group holds its checks
// whatever their review state, so it does not fall apart as its checks are reviewed one by one.

type DbDeps = Pick<Deps, 'db' | 'events'>;

export interface GroupMember {
  id: string;
  name: string;
  variant: Record<string, string>;
  review: CheckReview;
  reviewedBy: string | null;
  /** An agent's open suggestion for the check (agent review policy `suggest` or `auto-below`). */
  suggestion: Suggestion | null;
  imageSha: string;
  diffImageSha: string | null;
  baselineImageSha: string | null;
}

export interface ChangeGroup {
  /** The members' change key. */
  id: string;
  buildId: string;
  size: number;
  /** Members per review state. */
  counts: Record<Exclude<CheckReview, 'none'>, number>;
  /** The changes, as found on the first member (other members may show them elsewhere). */
  regions: Region[];
  /** Newest first, as the build page shows them. */
  checks: GroupMember[];
}

export interface GroupReviewResult {
  /** The checks this call reviewed (or undid). */
  changed: string[];
  /**
   * The checks a token's review left as suggestions for a person, under the project's agent
   * review policy (`suggest`: all; `auto-below`: approvals of diffs above the limit). Always
   * empty for a person's review and for a reset.
   */
  suggested: string[];
  /** The group's other checks, which it left as they were (already reviewed, outdated). */
  skipped: Array<{ checkId: string; review: CheckReview }>;
  group: ChangeGroup;
  /** The build's verdict after the call. */
  verdict: Verdict;
}

function groupNotFound(buildId: string, groupId: string): AppError {
  return new AppError('group_not_found', 404, `Build ${buildId} has no change group ${groupId}.`);
}

function membersQuery(deps: DbDeps, buildId: string) {
  return deps.db
    .selectFrom('checks')
    .leftJoin('baselines', 'baselines.id', 'checks.baselineId')
    .select([
      'checks.id',
      'checks.name',
      'checks.variant',
      'checks.review',
      'checks.reviewedBy',
      'checks.suggestion',
      'checks.imageSha',
      'checks.diffImageSha',
      'checks.diff',
      'checks.changeKey',
      'baselines.imageSha as baselineImageSha',
    ])
    .where('checks.buildId', '=', buildId)
    .orderBy('checks.id', 'desc');
}

type MemberRow = Awaited<ReturnType<ReturnType<typeof membersQuery>['execute']>>[number];

function toGroups(buildId: string, rows: MemberRow[]): ChangeGroup[] {
  const byKey = new Map<string, MemberRow[]>();
  for (const row of rows) {
    if (!row.changeKey) continue;
    byKey.set(row.changeKey, [...(byKey.get(row.changeKey) ?? []), row]);
  }
  const groups: ChangeGroup[] = [];
  for (const [id, members] of byKey) {
    if (members.length < 2) continue;
    const counts = { pending: 0, approved: 0, rejected: 0, outdated: 0 };
    for (const m of members) if (m.review !== 'none') counts[m.review] += 1;
    const first = members[0] as MemberRow;
    const diff = first.diff ? (JSON.parse(first.diff) as DiffData) : null;
    groups.push({
      id,
      buildId,
      size: members.length,
      counts,
      regions: diff && 'regions' in diff ? diff.regions : [],
      checks: members.map((m) => ({
        id: m.id,
        name: m.name,
        variant: JSON.parse(m.variant) as Record<string, string>,
        review: m.review,
        reviewedBy: m.reviewedBy,
        suggestion: m.suggestion,
        imageSha: m.imageSha,
        diffImageSha: m.diffImageSha,
        baselineImageSha: m.baselineImageSha,
      })),
    });
  }
  // Biggest first; of equal size, the one with the newest check.
  return groups.sort((a, b) => b.size - a.size || ((b.checks[0]?.id ?? '') > (a.checks[0]?.id ?? '') ? 1 : -1));
}

/** The build's change groups (two or more checks with the same changes), biggest first. */
export async function listGroups(deps: DbDeps, buildId: string): Promise<ChangeGroup[]> {
  await getBuildRow(deps, buildId);
  const rows = await membersQuery(deps, buildId)
    .where('checks.changeKey', 'in', (eb) =>
      eb
        .selectFrom('checks')
        .select('changeKey')
        .where('buildId', '=', buildId)
        .where('changeKey', 'is not', null)
        .groupBy('changeKey')
        .having((h) => h.fn.countAll(), '>=', 2),
    )
    .execute();
  return toGroups(buildId, rows);
}

export async function getGroup(deps: DbDeps, buildId: string, groupId: string): Promise<ChangeGroup> {
  await getBuildRow(deps, buildId);
  const rows = await membersQuery(deps, buildId).where('checks.changeKey', '=', groupId).execute();
  const [group] = toGroups(buildId, rows);
  if (!group) throw groupNotFound(buildId, groupId);
  return group;
}

async function resultOf(
  deps: DbDeps,
  buildId: string,
  groupId: string,
  changed: string[],
  suggested: string[] = [],
): Promise<GroupReviewResult> {
  const group = await getGroup(deps, buildId, groupId);
  const done = new Set([...changed, ...suggested]);
  return {
    changed,
    suggested,
    skipped: group.checks.filter((c) => !done.has(c.id)).map((c) => ({ checkId: c.id, review: c.review })),
    group,
    verdict: (await getBuild(deps, buildId)).verdict,
  };
}

/** The group's checks named in `checkIds` (all when absent); 422 for one that is not in it. */
function pick(group: ChangeGroup, checkIds: string[] | undefined): Set<string> {
  const members = new Set(group.checks.map((c) => c.id));
  const stranger = checkIds?.find((id) => !members.has(id));
  if (stranger) {
    throw new AppError('check_not_in_group', 422, `Check ${stranger} is not in change group ${group.id}.`);
  }
  return checkIds ? new Set(checkIds) : members;
}

/**
 * Approves or rejects every check of the group that waits for review (of those in `checkIds`,
 * when given), in one transaction, each through the same core as a single review: its own review
 * event with the actor kind, token name, reason and (rejecting) the reason's category. Checks
 * already reviewed are left as they are, and so are outdated ones (a newer build of the branch
 * approved their screen): `skipped`.
 *
 * A token goes through the project's agent review policy as a single review does: it must give a
 * reason, and what it may not decide itself becomes a suggestion (`suggested`). After commit the
 * applied reviews are announced: `check.reviewed` for each, the build's sync and verdict once.
 */
export async function reviewGroup(
  deps: DbDeps,
  buildId: string,
  groupId: string,
  action: 'approve' | 'reject',
  actor: string | ReviewActor,
  input: unknown = {},
): Promise<GroupReviewResult> {
  const who = actorOf(actor);
  const { checkIds, ...given } = parseInput(groupReviewSchema, input);
  const why = reasonOf(given, action);
  const group = await getGroup(deps, buildId, groupId);
  const wanted = pick(group, checkIds);
  const build = await getBuildRow(deps, buildId);
  const waiting = group.checks.filter((c) => wanted.has(c.id) && c.review === 'pending').map((c) => c.id);
  // Under a policy a token decides only the checks judged here; one that joined meanwhile waits.
  const split = await splitByPolicy(deps, build.projectId, who, why, action, waiting);
  const { applied, suggested, builds } = await deps.db.transaction().execute(async (tx) => {
    const pending = await tx
      .selectFrom('checks')
      .select('id')
      .where('buildId', '=', buildId)
      .where('changeKey', '=', groupId)
      .where('review', '=', 'pending')
      .orderBy('id', 'desc')
      .execute();
    const applied: string[] = [];
    const suggested: string[] = [];
    const builds: string[] = [];
    for (const { id } of pending) {
      if (!wanted.has(id)) continue;
      if (split?.suggest.has(id)) {
        if ((await trySuggest(tx, id, action, who, why)).suggested) suggested.push(id);
        continue;
      }
      if (split && !split.apply.has(id)) continue;
      const outcome =
        action === 'approve' ? await tryApprove(tx, id, who, why.reason) : await tryReject(tx, id, who, why);
      if ('builds' in outcome) {
        applied.push(id);
        builds.push(...outcome.builds);
      }
    }
    return { applied, suggested, builds };
  });
  const verb = action === 'approve' ? 'approved' : 'rejected';
  await announce(
    deps,
    applied.map((checkId): Reviewed => ({ checkId, action: verb, actor: who, ...why })),
    builds,
  );
  return resultOf(deps, buildId, groupId, applied, suggested);
}

/**
 * Undoes the reviews of the group's checks: those named in `checkIds` (what a group review
 * changed, for its Undo), else every approved or rejected one. All or nothing: when one cannot be
 * undone (409 review_not_resettable), none is. Each undo is announced, the builds once.
 */
export async function resetGroup(
  deps: DbDeps,
  buildId: string,
  groupId: string,
  actor: string | ReviewActor,
  input: unknown = {},
): Promise<GroupReviewResult> {
  const who = actorOf(actor);
  const { checkIds } = parseInput(groupResetSchema, input);
  const group = await getGroup(deps, buildId, groupId);
  const wanted = pick(group, checkIds);
  const targets = group.checks
    .filter((c) => wanted.has(c.id) && (c.review === 'approved' || c.review === 'rejected'))
    .map((c) => c.id);
  const builds = await deps.db.transaction().execute(async (tx) => {
    const builds: string[] = [];
    for (const id of targets) builds.push(...(await resetIn(tx, id, who)));
    return builds;
  });
  await announce(
    deps,
    targets.map((checkId): Reviewed => ({ checkId, action: 'reset', actor: who, reason: null })),
    builds,
  );
  return resultOf(deps, buildId, groupId, targets);
}
