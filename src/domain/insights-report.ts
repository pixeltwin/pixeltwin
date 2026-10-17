import type { Project, RejectReason } from '../db/schema';
import { AppError } from '../errors';
import type { Deps } from './deps';
import { screenHistories } from './flaky';
import { DAY_MS, dayOf } from './insight-marks';
import {
  type DayTotals,
  emptyTotals,
  mergeTotals,
  quantileMs,
  type RejectionCategory,
  type ReviewerTotals,
  readDays,
  refreshInsights,
} from './insights';
import { NOISE } from './reject-reasons';
import { noiseRejections } from './rejections';

// What the Insights page, its API, the MCP tool and the weekly digest show: the rollups of a range
// of days on one branch (they outlive retention), and three tables read from the builds still kept
// (top noisy screens, slowest screens: their links lead to checks, which must exist) plus the
// reviewers from the rollups.

type DbDeps = Pick<Deps, 'db'>;

/** The longest range one call reads. */
export const MAX_RANGE_DAYS = 366;
/** Rows of the noisy and slow screen tables. */
export const TABLE_ROWS = 10;

/** What to do in the test code about a screen's noise, by its main reason. */
export const NOISE_ACTIONS: Record<NoiseReason, string> = {
  not_loaded: 'Wait for the page to finish loading (network idle, or the element) before the screenshot',
  late_asset: 'Wait for images, fonts and banners before the screenshot, or ignore their area',
  animation: 'Disable animations and transitions for the screenshot',
  dynamic_data: 'Ignore the area with the changing data, or fix the data in the test',
  flaky: 'Ignore the area that keeps changing',
};

/** A noise rejection's category, or `flaky`: the screen flips with no rejection saying why. */
export type NoiseReason = 'not_loaded' | 'late_asset' | 'animation' | 'dynamic_data' | 'flaky';

export interface InsightsRange {
  branch: string;
  /** UTC days since the epoch, inclusive. */
  fromDay: number;
  toDay: number;
}

export interface Rejections {
  total: number;
  byReason: Record<RejectionCategory, number>;
  /** not_loaded + late_asset + animation + dynamic_data: the test, not the app. */
  noise: number;
  realBug: number;
  /** environment, other and rejections without a category. */
  other: number;
}

export interface TimeToDecision {
  /** Builds that needed review and got a decision. */
  decidedBuilds: number;
  medianMs: number | null;
  p90Ms: number | null;
  meanMs: number | null;
}

export interface Totals {
  builds: number;
  checks: number;
  autoPassed: number;
  /** autoPassed / checks; null without checks. */
  autoPassRate: number | null;
  neededReview: number;
  approved: number;
  rejected: number;
  outdated: number;
  pending: number;
  errors: number;
  rejections: Rejections;
  suggestions: { made: number; accepted: number; dismissed: number; acceptRate: number | null };
  timeToDecision: TimeToDecision;
  runTime: {
    screenshotMs: number;
    uploadMs: number;
    compareMs: number;
    retakes: number;
    timedChecks: number;
    /** (screenshot + upload + compare) per build; null without builds. */
    perBuildMs: number | null;
  };
}

export interface DailyPoint {
  /** YYYY-MM-DD, UTC. */
  date: string;
  builds: number;
  checks: number;
  autoPassed: number;
  autoPassRate: number | null;
  approved: number;
  rejected: number;
  rejectedBy: Record<RejectionCategory, number>;
  outdated: number;
  pending: number;
  decidedBuilds: number;
  medianMs: number | null;
  p90Ms: number | null;
  screenshotMs: number;
  uploadMs: number;
  compareMs: number;
  flakyScreens: number;
}

export interface NoisyScreen {
  snapshotKey: string;
  name: string;
  variant: Record<string, string>;
  /** The screen's latest check on the branch: open it to ignore the noisy area. */
  checkId: string;
  /** Flips per run in its last 20 runs; null when it is not flaky. */
  flakyScore: number | null;
  flips: number;
  /** Rejections in the range that called its change noise. */
  noiseRejections: number;
  byReason: Partial<Record<RejectReason, number>>;
  mainReason: NoiseReason;
  action: string;
  lastSeen: number;
}

export interface SlowScreen {
  snapshotKey: string;
  name: string;
  variant: Record<string, string>;
  checkId: string;
  checks: number;
  compareMsAvg: number;
  compareMsMax: number;
}

export interface Reviewer {
  kind: 'user' | 'token';
  id: string;
  /** A person's email, a token's name. */
  name: string;
  decisions: number;
  approved: number;
  rejected: number;
  /** Finalize to the decision, from the histogram. */
  medianMs: number | null;
  /** A token: its suggestions people accepted / dismissed; a person: agent suggestions they accepted / dismissed. */
  suggestionsAccepted: number;
  suggestionsDismissed: number;
  /** accepted / (accepted + dismissed); null when none was decided. */
  acceptRate: number | null;
  /** A token: suggestions it made. */
  suggestionsMade: number;
}

export interface InsightsReport {
  branch: string;
  from: string;
  to: string;
  days: number;
  /** Days are UTC days; a build counts on the day it was created, its reviews with it. */
  timeZone: 'UTC';
  totals: Totals;
  /** The same numbers for the as long range just before. */
  previous: {
    from: string;
    to: string;
    builds: number;
    autoPassRate: number | null;
    medianTimeToDecisionMs: number | null;
  };
  daily: DailyPoint[];
  /** Screens flaky on the branch now (from its last 20 runs). */
  flakyScreensNow: number;
  noisyScreens: NoisyScreen[];
  slowScreens: SlowScreen[];
  reviewers: Reviewer[];
  /** The project's retention: the screen tables read builds of the last `retentionDays` days only. */
  retentionDays: number;
}

export const dateOf = (day: number) => new Date(day * DAY_MS).toISOString().slice(0, 10);

/** `2026-10-17` → its UTC day; null when not a date. */
export function dayFromDate(text: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const at = Date.parse(`${text}T00:00:00Z`);
  return Number.isNaN(at) || dateOf(dayOf(at)) !== text ? null : dayOf(at);
}

function invalid(path: string, message: string): AppError {
  return new AppError('validation_failed', 422, 'The request is invalid.', [{ path, message }]);
}

/** The range of a request: `from` and `to` as YYYY-MM-DD (UTC, inclusive), default the last 30 days. */
export function rangeOf(
  project: Pick<Project, 'mainBranch'>,
  query: { from?: string | undefined; to?: string | undefined; branch?: string | undefined; days?: number | undefined },
  now = Date.now(),
): InsightsRange {
  const toDay = query.to ? dayFromDate(query.to) : dayOf(now);
  if (toDay === null) throw invalid('to', 'A date as YYYY-MM-DD');
  const fromDay = query.from ? dayFromDate(query.from) : toDay - (query.days ?? 30) + 1;
  if (fromDay === null) throw invalid('from', 'A date as YYYY-MM-DD');
  if (fromDay > toDay) throw invalid('from', 'Not after `to`');
  if (toDay - fromDay + 1 > MAX_RANGE_DAYS) throw invalid('from', `At most ${MAX_RANGE_DAYS} days`);
  const branch = query.branch?.trim() || project.mainBranch;
  return { branch, fromDay, toDay };
}

const rate = (part: number, whole: number) => (whole > 0 ? part / whole : null);

function rejectionsOf(t: DayTotals): Rejections {
  const noise = NOISE.reduce((sum, code) => sum + t.rejectedBy[code], 0);
  const realBug = t.rejectedBy.real_bug;
  return { total: t.rejected, byReason: { ...t.rejectedBy }, noise, realBug, other: t.rejected - noise - realBug };
}

function totalsOf(t: DayTotals): Totals {
  const work = t.screenshotMs + t.uploadMs + t.compareMs;
  return {
    builds: t.builds,
    checks: t.checks,
    autoPassed: t.autoPassed,
    autoPassRate: rate(t.autoPassed, t.checks),
    neededReview: t.neededReview,
    approved: t.approved,
    rejected: t.rejected,
    outdated: t.outdated,
    pending: t.pending,
    errors: t.errors,
    rejections: rejectionsOf(t),
    suggestions: {
      made: t.suggestions,
      accepted: t.suggestionsAccepted,
      dismissed: t.suggestionsDismissed,
      acceptRate: rate(t.suggestionsAccepted, t.suggestionsAccepted + t.suggestionsDismissed),
    },
    timeToDecision: {
      decidedBuilds: t.decidedBuilds,
      medianMs: quantileMs(t.latencyHist, 0.5),
      p90Ms: quantileMs(t.latencyHist, 0.9),
      meanMs: t.decidedBuilds > 0 ? Math.round(t.latencySumMs / t.decidedBuilds) : null,
    },
    runTime: {
      screenshotMs: t.screenshotMs,
      uploadMs: t.uploadMs,
      compareMs: t.compareMs,
      retakes: t.retakes,
      timedChecks: t.timedChecks,
      perBuildMs: t.builds > 0 ? Math.round(work / t.builds) : null,
    },
  };
}

function dailyOf(day: number, t: DayTotals): DailyPoint {
  return {
    date: dateOf(day),
    builds: t.builds,
    checks: t.checks,
    autoPassed: t.autoPassed,
    autoPassRate: rate(t.autoPassed, t.checks),
    approved: t.approved,
    rejected: t.rejected,
    rejectedBy: { ...t.rejectedBy },
    outdated: t.outdated,
    pending: t.pending,
    decidedBuilds: t.decidedBuilds,
    medianMs: quantileMs(t.latencyHist, 0.5),
    p90Ms: quantileMs(t.latencyHist, 0.9),
    screenshotMs: t.screenshotMs,
    uploadMs: t.uploadMs,
    compareMs: t.compareMs,
    flakyScreens: t.flakyScreens,
  };
}

async function sumOf(deps: DbDeps, projectId: string, range: InsightsRange) {
  const days = await readDays(deps, projectId, range.branch, range.fromDay, range.toDay);
  return { days, sum: days.reduce((acc, d) => mergeTotals(acc, d.totals), emptyTotals()) };
}

const variantOf = (text: string) => JSON.parse(text) as Record<string, string>;

/** Each screen's latest check on the branch, with its name and variant. */
async function latestChecks(deps: DbDeps, projectId: string, branch: string, keys: string[]) {
  const out = new Map<string, { id: string; name: string; variant: Record<string, string> }>();
  for (let at = 0; at < keys.length; at += 400) {
    const latest = deps.db
      .selectFrom('checks')
      .innerJoin('builds', 'builds.id', 'checks.buildId')
      .select(['checks.snapshotKey', (eb) => eb.fn.max('checks.id').as('id')])
      .where('checks.projectId', '=', projectId)
      .where('builds.branch', '=', branch)
      .where('checks.snapshotKey', 'in', keys.slice(at, at + 400))
      .groupBy('checks.snapshotKey');
    const rows = await deps.db
      .selectFrom('checks')
      .innerJoin(latest.as('latest'), 'latest.id', 'checks.id')
      .select(['checks.id', 'checks.snapshotKey', 'checks.name', 'checks.variant'])
      .execute();
    for (const r of rows) out.set(r.snapshotKey, { id: r.id, name: r.name, variant: variantOf(r.variant) });
  }
  return out;
}

/** Flaky screens on the branch now, and the noise rejections of checks in the range. */
async function noisyScreensOf(deps: DbDeps, projectId: string, range: InsightsRange) {
  const changed = await deps.db
    .selectFrom('checks')
    .innerJoin('builds', 'builds.id', 'checks.buildId')
    .select('checks.snapshotKey')
    .distinct()
    .where('checks.projectId', '=', projectId)
    .where('builds.branch', '=', range.branch)
    .where('checks.result', '=', 'changed')
    .execute();
  const screens = await screenHistories(
    deps,
    projectId,
    changed.map((r) => r.snapshotKey),
    range.branch,
  );
  const flaky = new Map(screens.filter((s) => s.flaky).map((s) => [s.snapshotKey, s]));

  const rejected = await deps.db
    .selectFrom('reviewEvents')
    .innerJoin('checks', 'checks.id', 'reviewEvents.checkId')
    .innerJoin('builds', 'builds.id', 'checks.buildId')
    .select(['reviewEvents.checkId', 'checks.snapshotKey', 'reviewEvents.createdAt'])
    .where('reviewEvents.projectId', '=', projectId)
    .where('reviewEvents.action', '=', 'rejected')
    .where('reviewEvents.reasonCode', 'in', [...NOISE])
    .where('builds.branch', '=', range.branch)
    .where('builds.createdAt', '>=', range.fromDay * DAY_MS)
    .where('builds.createdAt', '<', (range.toDay + 1) * DAY_MS)
    .execute();
  // Undone rejections (a reset came next) are left out.
  const counts = await noiseRejections(
    deps,
    rejected.map((r) => r.checkId),
  );
  const noise = new Map<string, { count: number; byReason: Partial<Record<RejectReason, number>>; lastAt: number }>();
  const seen = new Set<string>();
  for (const r of rejected) {
    const n = noise.get(r.snapshotKey) ?? { count: 0, byReason: {}, lastAt: 0 };
    n.lastAt = Math.max(n.lastAt, Number(r.createdAt));
    if (!seen.has(r.checkId)) {
      seen.add(r.checkId);
      for (const [code, k] of Object.entries(counts.get(r.checkId) ?? {}) as Array<[RejectReason, number]>) {
        n.byReason[code] = (n.byReason[code] ?? 0) + k;
        n.count += k;
      }
    }
    if (n.count > 0) noise.set(r.snapshotKey, n);
  }

  const keys = [...new Set([...flaky.keys(), ...noise.keys()])];
  const latest = await latestChecks(deps, projectId, range.branch, keys);
  const out: NoisyScreen[] = [];
  for (const key of keys) {
    const check = latest.get(key);
    if (!check) continue;
    const f = flaky.get(key)?.flaky ?? null;
    const n = noise.get(key);
    const top = n
      ? (Object.entries(n.byReason) as Array<[RejectReason, number]>).sort((a, b) => b[1] - a[1])[0]?.[0]
      : undefined;
    const mainReason: NoiseReason = (top as NoiseReason | undefined) ?? 'flaky';
    out.push({
      snapshotKey: key,
      name: check.name,
      variant: check.variant,
      checkId: check.id,
      flakyScore: f ? f.score : null,
      flips: f ? f.flips : 0,
      noiseRejections: n?.count ?? 0,
      byReason: n?.byReason ?? {},
      mainReason,
      action: NOISE_ACTIONS[mainReason],
      lastSeen: Math.max(f?.lastSeen ?? 0, n?.lastAt ?? 0),
    });
  }
  out.sort(
    (a, b) =>
      b.noiseRejections - a.noiseRejections ||
      (b.flakyScore ?? 0) - (a.flakyScore ?? 0) ||
      b.lastSeen - a.lastSeen ||
      a.name.localeCompare(b.name),
  );
  return { flakyNow: flaky.size, noisy: out };
}

async function slowScreensOf(deps: DbDeps, projectId: string, range: InsightsRange): Promise<SlowScreen[]> {
  const rows = await deps.db
    .selectFrom('checks')
    .innerJoin('builds', 'builds.id', 'checks.buildId')
    .select((eb) => [
      'checks.snapshotKey',
      eb.fn.avg<number>('checks.compareMs').as('avg'),
      eb.fn.max('checks.compareMs').as('max'),
      eb.fn.countAll<number>().as('n'),
    ])
    .where('checks.projectId', '=', projectId)
    .where('builds.branch', '=', range.branch)
    .where('builds.createdAt', '>=', range.fromDay * DAY_MS)
    .where('builds.createdAt', '<', (range.toDay + 1) * DAY_MS)
    .where('checks.compareMs', 'is not', null)
    .groupBy('checks.snapshotKey')
    .orderBy('avg', 'desc')
    .limit(TABLE_ROWS)
    .execute();
  const latest = await latestChecks(
    deps,
    projectId,
    range.branch,
    rows.map((r) => r.snapshotKey),
  );
  return rows.flatMap((r) => {
    const check = latest.get(r.snapshotKey);
    return check
      ? [
          {
            snapshotKey: r.snapshotKey,
            name: check.name,
            variant: check.variant,
            checkId: check.id,
            checks: Number(r.n),
            compareMsAvg: Math.round(Number(r.avg)),
            compareMsMax: Number(r.max ?? 0),
          },
        ]
      : [];
  });
}

async function reviewersOf(deps: DbDeps, reviewers: Record<string, ReviewerTotals>): Promise<Reviewer[]> {
  const list = Object.values(reviewers);
  const userIds = list.filter((r) => r.kind === 'user').map((r) => r.id);
  const users = userIds.length
    ? await deps.db.selectFrom('users').select(['id', 'email']).where('id', 'in', userIds).execute()
    : [];
  const emails = new Map(users.map((u) => [u.id, u.email]));
  return list
    .map((r) => ({
      kind: r.kind,
      id: r.id,
      name: r.kind === 'user' ? (emails.get(r.id) ?? 'a deleted user') : (r.name ?? 'a token'),
      decisions: r.decisions,
      approved: r.approved,
      rejected: r.rejected,
      medianMs: quantileMs(r.hist, 0.5),
      suggestionsAccepted: r.accepted,
      suggestionsDismissed: r.dismissed,
      acceptRate: rate(r.accepted, r.accepted + r.dismissed),
      suggestionsMade: r.suggested,
    }))
    .sort((a, b) => b.decisions - a.decisions || b.suggestionsMade - a.suggestionsMade || a.name.localeCompare(b.name));
}

/** The project's insights on a branch over a range of days (refreshing marked days first). */
export async function getInsights(deps: DbDeps, project: Project, range: InsightsRange): Promise<InsightsReport> {
  await refreshInsights(deps, { projectId: project.id });
  const length = range.toDay - range.fromDay + 1;
  const previousRange = { ...range, fromDay: range.fromDay - length, toDay: range.fromDay - 1 };
  const [{ days, sum }, before, noisy, slow] = await Promise.all([
    sumOf(deps, project.id, range),
    sumOf(deps, project.id, previousRange),
    noisyScreensOf(deps, project.id, range),
    slowScreensOf(deps, project.id, range),
  ]);
  const byDay = new Map(days.map((d) => [d.day, d.totals]));
  const daily: DailyPoint[] = [];
  for (let day = range.fromDay; day <= range.toDay; day++) daily.push(dailyOf(day, byDay.get(day) ?? emptyTotals()));
  return {
    branch: range.branch,
    from: dateOf(range.fromDay),
    to: dateOf(range.toDay),
    days: length,
    timeZone: 'UTC',
    totals: totalsOf(sum),
    previous: {
      from: dateOf(previousRange.fromDay),
      to: dateOf(previousRange.toDay),
      builds: before.sum.builds,
      autoPassRate: rate(before.sum.autoPassed, before.sum.checks),
      medianTimeToDecisionMs: quantileMs(before.sum.latencyHist, 0.5),
    },
    daily,
    flakyScreensNow: noisy.flakyNow,
    noisyScreens: noisy.noisy.slice(0, TABLE_ROWS),
    slowScreens: slow,
    reviewers: await reviewersOf(deps, sum.reviewers),
    retentionDays: project.retentionDays,
  };
}
