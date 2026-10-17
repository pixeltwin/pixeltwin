import {
  type ActorKind,
  type CheckResult,
  type CheckReview,
  type InsightDaysTable,
  REJECT_REASONS,
  type RejectReason,
} from '../db/schema';
import { removeBuildsIn } from './builds';
import type { Deps } from './deps';
import { flakySignal, ignoreAreasOf, screenHistories } from './flaky';
import { DAY_MS, dayOf } from './insight-marks';
import { AUTO_APPROVER } from './reviews';

// Daily rollups of a project's visual tests (migration 0017): what the Insights page, its API and
// the weekly digest read, so weeks of history survive retention deleting the builds.
//
// Everything about a build counts on the UTC day it was created, on its branch: its checks, its
// reviews whenever they were made (a Monday build reviewed on Tuesday is Monday's), its run time.
// Only finalized builds count; one still open is in progress or abandoned. A day's `live` part is a
// pure function of the builds that still exist, so recomputing it is idempotent and any replica may
// do it; retention adds a batch's numbers to the `kept` part in the transaction that deletes the
// batch (archiveBuilds). A day reads as live + kept.

type DbDeps = Pick<Deps, 'db'>;

/** Upper bounds of the latency histogram's buckets; the last bucket is everything longer. */
export const LATENCY_BUCKETS_MS = [
  60_000,
  5 * 60_000,
  15 * 60_000,
  30 * 60_000,
  3_600_000,
  2 * 3_600_000,
  4 * 3_600_000,
  8 * 3_600_000,
  DAY_MS,
  2 * DAY_MS,
  4 * DAY_MS,
  7 * DAY_MS,
] as const;
const BUCKETS = LATENCY_BUCKETS_MS.length + 1;

/** A rejection's category, or none given. */
export type RejectionCategory = RejectReason | 'uncategorized';
export const REJECTION_CATEGORIES: readonly RejectionCategory[] = [...REJECT_REASONS, 'uncategorized'];

/** One reviewer's decisions on the day's builds. */
export interface ReviewerTotals {
  kind: Exclude<ActorKind, 'auto'>;
  id: string;
  /** A token's name when it last acted; null for people (their email is looked up when shown). */
  name: string | null;
  decisions: number;
  approved: number;
  rejected: number;
  /** Finalize to each decision (0 when decided before the build was finalized). */
  latencySumMs: number;
  hist: number[];
  /** A token: suggestions it made. */
  suggested: number;
  /** A token: its suggestions people accepted; a person: agent suggestions they accepted. */
  accepted: number;
  /** A token: its suggestions people dismissed or decided otherwise; a person: those they did. */
  dismissed: number;
}

export interface DayTotals {
  builds: number;
  checks: number;
  /** Unchanged and not reviewed, or approved by the auto-approve-new setting: no person or agent was needed. */
  autoPassed: number;
  /** Of autoPassed, the checks that passed within the tolerance: some pixels differ. */
  withinTolerance: number;
  /** Changed or new and not approved automatically, or unchanged and reviewed (within the tolerance). */
  neededReview: number;
  /** Approved by a person or a token, rejected (now), by category. */
  approved: number;
  rejected: number;
  rejectedBy: Record<RejectionCategory, number>;
  outdated: number;
  pending: number;
  errors: number;
  /** Agent suggestions made, accepted (a person decided as suggested), dismissed (or decided otherwise). */
  suggestions: number;
  suggestionsAccepted: number;
  suggestionsDismissed: number;
  /** Builds that needed review and have a decision: finalize to the last decision. */
  decidedBuilds: number;
  latencySumMs: number;
  latencyHist: number[];
  /** What the SDK measured (added up over workers) and the server's compare time. */
  screenshotMs: number;
  uploadMs: number;
  compareMs: number;
  retakes: number;
  timedChecks: number;
  /** Screens that changed that day and were flaky by then (the history up to the day's end). */
  flakyScreens: number;
  reviewers: Record<string, ReviewerTotals>;
}

export function emptyTotals(): DayTotals {
  return {
    builds: 0,
    checks: 0,
    autoPassed: 0,
    withinTolerance: 0,
    neededReview: 0,
    approved: 0,
    rejected: 0,
    rejectedBy: Object.fromEntries(REJECTION_CATEGORIES.map((c) => [c, 0])) as Record<RejectionCategory, number>,
    outdated: 0,
    pending: 0,
    errors: 0,
    suggestions: 0,
    suggestionsAccepted: 0,
    suggestionsDismissed: 0,
    decidedBuilds: 0,
    latencySumMs: 0,
    latencyHist: new Array(BUCKETS).fill(0),
    screenshotMs: 0,
    uploadMs: 0,
    compareMs: 0,
    retakes: 0,
    timedChecks: 0,
    flakyScreens: 0,
    reviewers: {},
  };
}

export function bucketOf(ms: number): number {
  const i = LATENCY_BUCKETS_MS.findIndex((bound) => ms < bound);
  return i === -1 ? LATENCY_BUCKETS_MS.length : i;
}

const addHist = (a: number[], b: number[]) => Array.from({ length: BUCKETS }, (_, i) => (a[i] ?? 0) + (b[i] ?? 0));

/**
 * The q-quantile (0.5 median, 0.9 p90) of a latency histogram, interpolated within its bucket;
 * the open last bucket answers its lower bound. Null for an empty histogram.
 */
export function quantileMs(hist: number[], q: number): number | null {
  const total = hist.reduce((a, b) => a + b, 0);
  if (total === 0) return null;
  const rank = q * total;
  let seen = 0;
  for (let i = 0; i < BUCKETS; i++) {
    const n = hist[i] ?? 0;
    if (n > 0 && seen + n >= rank) {
      const low = i === 0 ? 0 : (LATENCY_BUCKETS_MS[i - 1] as number);
      const high = LATENCY_BUCKETS_MS[i];
      if (high === undefined) return low;
      return Math.round(low + ((high - low) * Math.max(0, rank - seen)) / n);
    }
    seen += n;
  }
  return LATENCY_BUCKETS_MS.at(-1) as number;
}

function mergeReviewer(a: ReviewerTotals | undefined, b: ReviewerTotals): ReviewerTotals {
  if (!a) return { ...b, hist: [...b.hist] };
  return {
    kind: b.kind,
    id: b.id,
    name: b.name ?? a.name,
    decisions: a.decisions + b.decisions,
    approved: a.approved + b.approved,
    rejected: a.rejected + b.rejected,
    latencySumMs: a.latencySumMs + b.latencySumMs,
    hist: addHist(a.hist, b.hist),
    suggested: a.suggested + b.suggested,
    accepted: a.accepted + b.accepted,
    dismissed: a.dismissed + b.dismissed,
  };
}

/** a + b, as a new value. */
export function mergeTotals(a: DayTotals, b: DayTotals): DayTotals {
  const out = emptyTotals();
  for (const key of Object.keys(out) as Array<keyof DayTotals>) {
    const x = a[key];
    const y = b[key];
    if (typeof x === 'number' && typeof y === 'number') (out[key] as number) = x + y;
  }
  for (const c of REJECTION_CATEGORIES) out.rejectedBy[c] = a.rejectedBy[c] + b.rejectedBy[c];
  out.latencyHist = addHist(a.latencyHist, b.latencyHist);
  for (const r of [...Object.values(a.reviewers), ...Object.values(b.reviewers)]) {
    const key = `${r.kind}:${r.id}`;
    out.reviewers[key] = mergeReviewer(out.reviewers[key], r);
  }
  return out;
}

// ---- Rows ----

type Row = Omit<InsightDaysTable, 'projectId' | 'branch' | 'day' | 'part' | 'computedAt'>;
type Stored = { [K in keyof Row]: unknown };

const CATEGORY_COLUMNS: Record<RejectionCategory, keyof Row> = {
  not_loaded: 'rejectedNotLoaded',
  late_asset: 'rejectedLateAsset',
  animation: 'rejectedAnimation',
  dynamic_data: 'rejectedDynamicData',
  environment: 'rejectedEnvironment',
  real_bug: 'rejectedRealBug',
  other: 'rejectedOther',
  uncategorized: 'rejectedUncategorized',
};

const NUMBER_FIELDS = [
  'builds',
  'checks',
  'autoPassed',
  'withinTolerance',
  'neededReview',
  'approved',
  'rejected',
  'outdated',
  'pending',
  'errors',
  'suggestions',
  'suggestionsAccepted',
  'suggestionsDismissed',
  'decidedBuilds',
  'latencySumMs',
  'screenshotMs',
  'uploadMs',
  'compareMs',
  'retakes',
  'timedChecks',
  'flakyScreens',
] as const;

export function toRow(t: DayTotals): Record<string, number | string> {
  const row: Record<string, number | string> = {};
  for (const f of NUMBER_FIELDS) row[f] = t[f];
  for (const c of REJECTION_CATEGORIES) row[CATEGORY_COLUMNS[c]] = t.rejectedBy[c];
  row.latencyHist = JSON.stringify(t.latencyHist);
  row.reviewers = JSON.stringify(t.reviewers);
  return row;
}

export function fromRow(row: Stored): DayTotals {
  const t = emptyTotals();
  for (const f of NUMBER_FIELDS) t[f] = Number(row[f] ?? 0);
  for (const c of REJECTION_CATEGORIES) t.rejectedBy[c] = Number(row[CATEGORY_COLUMNS[c]] ?? 0);
  const hist = JSON.parse(String(row.latencyHist ?? '[]')) as number[];
  t.latencyHist = addHist(t.latencyHist, hist);
  t.reviewers = JSON.parse(String(row.reviewers ?? '{}')) as Record<string, ReviewerTotals>;
  return t;
}

// ---- Computing ----

/** Keys per query, well below the parameter limits of SQLite and Postgres. */
const KEYS_PER_QUERY = 400;

interface BuildRow {
  id: string;
  branch: string;
  createdAt: number;
  finalizedAt: number | null;
  timingChecks: number;
  timingScreenshotMs: number;
  timingUploadMs: number;
  timingRetakes: number;
}

export const dayKey = (branch: string, day: number) => `${day}\0${branch}`;

function chunks<T>(items: T[]): T[][] {
  const out: T[][] = [];
  for (let at = 0; at < items.length; at += KEYS_PER_QUERY) out.push(items.slice(at, at + KEYS_PER_QUERY));
  return out;
}

type Suggested = { action: 'approve' | 'reject'; by: string };

/**
 * The numbers of these finalized builds, per (branch, day). Reads their checks and review history,
 * so it must run before they are deleted.
 */
async function computeTotals(deps: DbDeps, projectId: string, builds: BuildRow[]): Promise<Map<string, DayTotals>> {
  const out = new Map<string, DayTotals>();
  const keyOf = new Map<string, string>();
  const byId = new Map(builds.map((b) => [b.id, b]));
  for (const b of builds) {
    const key = dayKey(b.branch, dayOf(Number(b.createdAt)));
    keyOf.set(b.id, key);
    const t = out.get(key) ?? emptyTotals();
    t.builds += 1;
    t.screenshotMs += Number(b.timingScreenshotMs);
    t.uploadMs += Number(b.timingUploadMs);
    t.retakes += Number(b.timingRetakes);
    t.timedChecks += Number(b.timingChecks);
    out.set(key, t);
  }
  const needed = new Set<string>();
  const changedKeys = new Map<string, Set<string>>();
  for (const ids of chunks(builds.map((b) => b.id))) {
    const rows = await deps.db
      .selectFrom('checks')
      .select((eb) => [
        'buildId',
        'result',
        'review',
        'reviewReasonCode',
        'withinTolerance',
        eb.case().when('reviewedBy', '=', AUTO_APPROVER).then(1).else(0).end().as('auto'),
        eb.fn.countAll<number>().as('n'),
        eb.fn.sum<number>('compareMs').as('ms'),
      ])
      .where('buildId', 'in', ids)
      .groupBy(['buildId', 'result', 'review', 'reviewReasonCode', 'withinTolerance', 'auto'])
      .execute();
    for (const row of rows) {
      const t = out.get(keyOf.get(row.buildId) as string) as DayTotals;
      const n = Number(row.n);
      const result = row.result as CheckResult;
      const review = row.review as CheckReview;
      const auto = Number(row.auto) === 1 && review === 'approved';
      t.checks += n;
      t.compareMs += Number(row.ms ?? 0);
      if (result === 'error') t.errors += n;
      // An unchanged check a person reviewed or has to (within the tolerance) needed review too.
      if ((result === 'unchanged' && review === 'none') || auto) {
        t.autoPassed += n;
        if (Number(row.withinTolerance) === 1) t.withinTolerance += n;
      } else if (result !== 'error') {
        t.neededReview += n;
        needed.add(row.buildId);
      }
      if (review === 'approved' && !auto) t.approved += n;
      if (review === 'rejected') {
        t.rejected += n;
        t.rejectedBy[(row.reviewReasonCode as RejectReason | null) ?? 'uncategorized'] += n;
      }
      if (review === 'outdated') t.outdated += n;
      if (review === 'pending') t.pending += n;
    }
    const changed = await deps.db
      .selectFrom('checks')
      .select(['buildId', 'snapshotKey'])
      .where('buildId', 'in', ids)
      .where('result', '=', 'changed')
      .execute();
    for (const c of changed) {
      const key = keyOf.get(c.buildId) as string;
      changedKeys.set(key, (changedKeys.get(key) ?? new Set()).add(c.snapshotKey));
    }
  }

  // Reviews: decisions and their latency, and what became of agents' suggestions.
  const lastDecision = new Map<string, number>();
  const reviewer = (t: DayTotals, kind: 'user' | 'token', id: string, name: string | null) => {
    const key = `${kind}:${id}`;
    t.reviewers[key] ??= {
      kind,
      id,
      name: null,
      decisions: 0,
      approved: 0,
      rejected: 0,
      latencySumMs: 0,
      hist: new Array(BUCKETS).fill(0),
      suggested: 0,
      accepted: 0,
      dismissed: 0,
    };
    const r = t.reviewers[key];
    if (name) r.name = name;
    return r;
  };
  for (const ids of chunks(builds.map((b) => b.id))) {
    const events = await deps.db
      .selectFrom('reviewEvents')
      .innerJoin('checks', 'checks.id', 'reviewEvents.checkId')
      .select([
        'reviewEvents.checkId',
        'reviewEvents.action',
        'reviewEvents.actor',
        'reviewEvents.actorKind',
        'reviewEvents.actorName',
        'reviewEvents.createdAt',
        'checks.buildId',
      ])
      .where('checks.buildId', 'in', ids)
      .orderBy('reviewEvents.checkId')
      .orderBy('reviewEvents.id')
      .execute();
    let open: Suggested | null = null;
    let check = '';
    for (const e of events) {
      if (e.checkId !== check) {
        check = e.checkId;
        open = null;
      }
      const build = byId.get(e.buildId) as BuildRow;
      const t = out.get(keyOf.get(e.buildId) as string) as DayTotals;
      const at = Number(e.createdAt);
      const kind = e.actorKind;
      if (kind === 'auto' || e.actor === AUTO_APPROVER) continue;
      const settle = (accepted: boolean, by: string | null) => {
        if (!open) return;
        const agent = reviewer(t, 'token', open.by, null);
        if (accepted) {
          t.suggestionsAccepted += 1;
          agent.accepted += 1;
        } else {
          t.suggestionsDismissed += 1;
          agent.dismissed += 1;
        }
        if (by) {
          const person = reviewer(t, 'user', by, null);
          if (accepted) person.accepted += 1;
          else person.dismissed += 1;
        }
        open = null;
      };
      switch (e.action) {
        case 'suggested_approval':
        case 'suggested_rejection':
          t.suggestions += 1;
          reviewer(t, 'token', e.actor, e.actorName).suggested += 1;
          open = { action: e.action === 'suggested_approval' ? 'approve' : 'reject', by: e.actor };
          break;
        case 'suggestion_dismissed':
          settle(false, kind === 'user' ? e.actor : null);
          break;
        case 'approved':
        case 'rejected': {
          const latency = Math.max(0, at - Number(build.finalizedAt ?? at));
          const r = reviewer(t, kind, e.actor, e.actorName);
          r.decisions += 1;
          if (e.action === 'approved') r.approved += 1;
          else r.rejected += 1;
          r.latencySumMs += latency;
          r.hist[bucketOf(latency)] = (r.hist[bucketOf(latency)] ?? 0) + 1;
          lastDecision.set(e.buildId, Math.max(lastDecision.get(e.buildId) ?? 0, at));
          if (open && kind === 'user')
            settle(open.action === (e.action === 'approved' ? 'approve' : 'reject'), e.actor);
          else open = null;
          break;
        }
        default:
          break;
      }
    }
  }
  for (const [buildId, at] of lastDecision) {
    if (!needed.has(buildId)) continue;
    const build = byId.get(buildId) as BuildRow;
    const t = out.get(keyOf.get(buildId) as string) as DayTotals;
    const latency = Math.max(0, at - Number(build.finalizedAt ?? at));
    t.decidedBuilds += 1;
    t.latencySumMs += latency;
    const bucket = bucketOf(latency);
    t.latencyHist[bucket] = (t.latencyHist[bucket] ?? 0) + 1;
  }

  // Flaky screens: of the screens that changed that day, those whose history up to the day's end flips.
  for (const [key, keys] of changedKeys) {
    const [dayText, branch] = key.split('\0') as [string, string];
    const end = (Number(dayText) + 1) * DAY_MS;
    const screens = await screenHistories(deps, projectId, [...keys], branch);
    const areas = await ignoreAreasOf(deps, projectId, [...keys]);
    let flaky = 0;
    for (const screen of screens) {
      const history = screen.history.filter((h) => h.createdAt < end);
      if (flakySignal(history, areas.get(screen.snapshotKey))) flaky += 1;
    }
    (out.get(key) as DayTotals).flakyScreens = flaky;
  }
  return out;
}

const BUILD_COLUMNS = [
  'id',
  'branch',
  'createdAt',
  'finalizedAt',
  'timingChecks',
  'timingScreenshotMs',
  'timingUploadMs',
  'timingRetakes',
] as const;

/** Recomputes the live part of one day from the builds that exist; a newer recompute wins. */
async function recomputeLive(
  deps: DbDeps,
  key: { projectId: string; branch: string; day: number },
  startedAt: number,
): Promise<void> {
  const builds = (await deps.db
    .selectFrom('builds')
    .select(BUILD_COLUMNS)
    .where('projectId', '=', key.projectId)
    .where('branch', '=', key.branch)
    .where('state', '=', 'finalized')
    .where('createdAt', '>=', key.day * DAY_MS)
    .where('createdAt', '<', (key.day + 1) * DAY_MS)
    .execute()) as BuildRow[];
  const where = { projectId: key.projectId, branch: key.branch, day: key.day, part: 'live' as const };
  if (builds.length === 0) {
    await deps.db
      .deleteFrom('insightDays')
      .where('projectId', '=', where.projectId)
      .where('branch', '=', where.branch)
      .where('day', '=', where.day)
      .where('part', '=', 'live')
      .where('computedAt', '<=', startedAt)
      .execute();
    return;
  }
  const totals = (await computeTotals(deps, key.projectId, builds)).get(dayKey(key.branch, key.day)) ?? emptyTotals();
  const row = toRow(totals);
  await deps.db
    .insertInto('insightDays')
    .values({ ...where, ...row, computedAt: startedAt })
    .onConflict((oc) =>
      oc
        .columns(['projectId', 'branch', 'day', 'part'])
        .doUpdateSet({ ...row, computedAt: startedAt })
        // A recompute that started earlier (another replica) never overwrites a newer one.
        .where('insightDays.computedAt', '<=', startedAt),
    )
    .execute();
}

/** Marks read per refresh pass. */
const MARKS_PER_PASS = 500;

/**
 * Recomputes the days marked out of date (one project, or all), and deletes the marks it read: a
 * change made meanwhile leaves a mark of its own, recomputed next time. Safe on several replicas at
 * once. Returns the days recomputed.
 */
export async function refreshInsights(
  deps: DbDeps,
  options: { projectId?: string; now?: number } = {},
): Promise<number> {
  let done = 0;
  for (;;) {
    const startedAt = options.now ?? Date.now();
    let query = deps.db.selectFrom('insightMarks').select(['id', 'projectId', 'branch', 'day']);
    if (options.projectId) query = query.where('projectId', '=', options.projectId);
    const marks = await query.orderBy('id').limit(MARKS_PER_PASS).execute();
    if (marks.length === 0) return done;
    const keys = new Map(marks.map((m) => [`${m.projectId}\0${dayKey(m.branch, Number(m.day))}`, m]));
    for (const m of keys.values()) {
      await recomputeLive(deps, { projectId: m.projectId, branch: m.branch, day: Number(m.day) }, startedAt);
    }
    for (const ids of chunks(marks.map((m) => m.id))) {
      await deps.db.deleteFrom('insightMarks').where('id', 'in', ids).execute();
    }
    done += keys.size;
    if (marks.length < MARKS_PER_PASS) return done;
  }
}

/**
 * Retention: deletes these builds of the project after adding their numbers to the kept part of
 * their days, and recomputes what is left of those days, in one transaction. Throws (rolling it
 * back) when another replica deleted some of them meanwhile. Returns how many were deleted.
 */
export async function archiveBuilds(deps: DbDeps, projectId: string, ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  return deps.db.transaction().execute(async (tx) => {
    const builds: BuildRow[] = [];
    for (const part of chunks(ids)) {
      builds.push(
        ...((await tx
          .selectFrom('builds')
          .select(BUILD_COLUMNS)
          .where('projectId', '=', projectId)
          .where('state', '=', 'finalized')
          .where('id', 'in', part)
          .execute()) as BuildRow[]),
      );
    }
    const kept = await computeTotals({ db: tx }, projectId, builds);
    for (const [key, totals] of kept) {
      const [dayText, branch] = key.split('\0') as [string, string];
      const day = Number(dayText);
      const stored = await tx
        .selectFrom('insightDays')
        .selectAll()
        .where('projectId', '=', projectId)
        .where('branch', '=', branch)
        .where('day', '=', day)
        .where('part', '=', 'kept')
        .executeTakeFirst();
      const row = toRow(stored ? mergeTotals(fromRow(stored), totals) : totals);
      await tx
        .insertInto('insightDays')
        .values({ projectId, branch, day, part: 'kept', ...row, computedAt: Date.now() })
        .onConflict((oc) =>
          oc.columns(['projectId', 'branch', 'day', 'part']).doUpdateSet({ ...row, computedAt: Date.now() }),
        )
        .execute();
    }
    const days = new Map(
      (
        await Promise.all(
          chunks(ids).map((part) =>
            tx.selectFrom('builds').select(['branch', 'createdAt']).where('id', 'in', part).execute(),
          ),
        )
      )
        .flat()
        .map((b) => {
          const day = dayOf(Number(b.createdAt));
          return [dayKey(b.branch, day), { projectId, branch: b.branch, day }];
        }),
    );
    const deleted = await removeBuildsIn(tx, ids);
    if (deleted !== ids.length) throw new Error('builds were deleted by someone else meanwhile; retrying later');
    const now = Date.now();
    for (const key of days.values()) await recomputeLive({ db: tx }, key, now);
    return deleted;
  });
}

// ---- Reading ----

export interface DaySeries {
  day: number;
  totals: DayTotals;
}

/** The days of a project's branch in [fromDay, toDay], live + kept, oldest first (days without builds left out). */
export async function readDays(
  deps: DbDeps,
  projectId: string,
  branch: string,
  fromDay: number,
  toDay: number,
): Promise<DaySeries[]> {
  const rows = await deps.db
    .selectFrom('insightDays')
    .selectAll()
    .where('projectId', '=', projectId)
    .where('branch', '=', branch)
    .where('day', '>=', fromDay)
    .where('day', '<=', toDay)
    .orderBy('day')
    .execute();
  const days = new Map<number, DayTotals>();
  for (const row of rows) {
    const day = Number(row.day);
    const t = fromRow(row);
    const before = days.get(day);
    days.set(day, before ? mergeTotals(before, t) : t);
  }
  return [...days].map(([day, totals]) => ({ day, totals }));
}

/** Branches with insights, most builds first. */
export async function insightBranches(deps: DbDeps, projectId: string, limit = 50): Promise<string[]> {
  const rows = await deps.db
    .selectFrom('insightDays')
    .select(['branch', (eb) => eb.fn.sum<number>('builds').as('n')])
    .where('projectId', '=', projectId)
    .groupBy('branch')
    .orderBy('n', 'desc')
    .orderBy('branch')
    .limit(limit)
    .execute();
  return rows.map((r) => r.branch);
}
