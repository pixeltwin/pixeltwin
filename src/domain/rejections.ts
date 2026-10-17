import type { ActorKind, RejectReason } from '../db/schema';
import { getBuildRow } from './builds';
import type { Deps } from './deps';
import { NOISE, REJECT_REASON_INFO, TOO_EARLY } from './reject-reasons';

// Rejection patterns: why the screens of a project were rejected, so an agent (or the SDK at the
// end of a run) learns that "home" keeps being captured before it finished loading and fixes the
// test instead of approving or rejecting the same artefact again. Read from the review history:
// nothing is stored that retention or an undo could leave stale. A rejection that was undone (the
// next event of its check is a reset) is left out: it was a slip, not a judgement.

type DbDeps = Pick<Deps, 'db'>;

/** Rejections looked at per call, newest first. */
export const MAX_REJECTIONS = 500;
/** Rejections listed per screen. */
export const RECENT_PER_SCREEN = 5;
/** Keys per query, well below the parameter limits of SQLite and Postgres. */
const KEYS_PER_QUERY = 400;

/** `uncategorized`: rejections made without a category (Shift+R, older clients). */
export type RejectionCategory = RejectReason | 'uncategorized';

export interface Rejection {
  checkId: string;
  buildId: string;
  buildNumber: number;
  branch: string;
  reasonCode: RejectReason | null;
  /** The comment. */
  reason: string | null;
  /** Who rejected: a person (id), a token (its name then) or auto. */
  by: { kind: ActorKind; id: string; name: string | null };
  at: number;
}

export interface ScreenRejections {
  snapshotKey: string;
  /** Of its newest rejected check. */
  name: string;
  variant: Record<string, string>;
  /** In a build's patterns: this screen's check in that build. */
  checkId?: string;
  count: number;
  byCategory: Partial<Record<RejectionCategory, number>>;
  /** The category given most often (the newest on a tie); null when none was given. */
  top: RejectReason | null;
  /** Rejections that say it was captured too early (not_loaded, late_asset). */
  tooEarly: number;
  /** One sentence on what the rejections say and what to do. */
  hint: string;
  /** Newest first, at most RECENT_PER_SCREEN. */
  recent: Rejection[];
  lastAt: number;
}

export interface CategoryCount {
  code: RejectionCategory;
  count: number;
  /** Screens rejected with it. */
  screens: number;
  lastAt: number;
}

export interface RejectionPatterns {
  /** Rejections looked at (at most MAX_REJECTIONS, newest first). */
  total: number;
  /** Most given first (the newest on a tie). */
  categories: CategoryCount[];
  /** The screens, the most recently rejected first. */
  screens: ScreenRejections[];
}

export interface RejectionFilter {
  /** Only rejections made on builds of this branch. */
  branch?: string | undefined;
  /** Only these screens. */
  snapshotKeys?: string[] | undefined;
  /** Rejections to look at; default and most MAX_REJECTIONS. */
  limit?: number | undefined;
}

const times = (n: number) => `${n}×`;

/** "rejected 3× as not_loaded: likely captured before … (also 1× animation)." */
export function hintOf(byCategory: Partial<Record<RejectionCategory, number>>, top: RejectReason | null): string {
  const total = Object.values(byCategory).reduce((a, b) => a + (b ?? 0), 0);
  if (!top) return `Rejected ${times(total)} without a category; read the comments.`;
  const others = Object.entries(byCategory)
    .filter(([code]) => code !== top && code !== 'uncategorized')
    .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
    .map(([code, n]) => `${times(n ?? 0)} ${code}`);
  const also = others.length ? ` (also ${others.join(', ')})` : '';
  return `Rejected ${times(byCategory[top] ?? 0)} as ${top}${also}: ${REJECT_REASON_INFO[top].advice}.`;
}

type Row = {
  id: string;
  checkId: string;
  reasonCode: RejectReason | null;
  comment: string | null;
  actor: string;
  actorKind: ActorKind;
  actorName: string | null;
  createdAt: number;
  snapshotKey: string;
  name: string;
  variant: string;
  buildId: string;
  branch: string;
  number: number;
};

async function rejectedRows(deps: DbDeps, projectId: string, filter: RejectionFilter, limit: number): Promise<Row[]> {
  const query = (keys: string[] | undefined) => {
    let q = deps.db
      .selectFrom('reviewEvents')
      .innerJoin('checks', 'checks.id', 'reviewEvents.checkId')
      .innerJoin('builds', 'builds.id', 'checks.buildId')
      .select([
        'reviewEvents.id',
        'reviewEvents.checkId',
        'reviewEvents.reasonCode',
        'reviewEvents.comment',
        'reviewEvents.actor',
        'reviewEvents.actorKind',
        'reviewEvents.actorName',
        'reviewEvents.createdAt',
        'checks.snapshotKey',
        'checks.name',
        'checks.variant',
        'checks.buildId',
        'builds.branch',
        'builds.number',
      ])
      .where('reviewEvents.projectId', '=', projectId)
      .where('reviewEvents.action', '=', 'rejected');
    if (filter.branch !== undefined) q = q.where('builds.branch', '=', filter.branch);
    if (keys) q = q.where('checks.snapshotKey', 'in', keys);
    return q.orderBy('reviewEvents.id', 'desc').limit(limit).execute();
  };
  if (!filter.snapshotKeys) return (await query(undefined)) as Row[];
  const keys = [...new Set(filter.snapshotKeys)];
  const rows: Row[] = [];
  for (let at = 0; at < keys.length; at += KEYS_PER_QUERY) {
    rows.push(...((await query(keys.slice(at, at + KEYS_PER_QUERY))) as Row[]));
  }
  return rows.sort((a, b) => (a.id < b.id ? 1 : -1)).slice(0, limit);
}

/** The rejections among `rows` that were undone: the next event of their check is a reset. */
async function undone(deps: DbDeps, rows: Row[]): Promise<Set<string>> {
  const checkIds = [...new Set(rows.map((r) => r.checkId))];
  const out = new Set<string>();
  for (let at = 0; at < checkIds.length; at += KEYS_PER_QUERY) {
    const events = await deps.db
      .selectFrom('reviewEvents')
      .select(['id', 'checkId', 'action'])
      .where('checkId', 'in', checkIds.slice(at, at + KEYS_PER_QUERY))
      .where('action', 'in', ['approved', 'rejected', 'reset'])
      .orderBy('checkId')
      .orderBy('id')
      .execute();
    for (let i = 0; i < events.length; i++) {
      const event = events[i] as (typeof events)[number];
      const next = events[i + 1];
      if (event.action === 'rejected' && next?.checkId === event.checkId && next.action === 'reset') out.add(event.id);
    }
  }
  return out;
}

function topOf(rejections: Rejection[]): RejectReason | null {
  const counts = new Map<RejectReason, number>();
  for (const r of rejections) if (r.reasonCode) counts.set(r.reasonCode, (counts.get(r.reasonCode) ?? 0) + 1);
  let top: RejectReason | null = null;
  // Newest first: on a tie the category given most recently wins.
  for (const r of rejections) {
    if (!r.reasonCode) continue;
    if (!top || (counts.get(r.reasonCode) ?? 0) > (counts.get(top) ?? 0)) top = r.reasonCode;
  }
  return top;
}

/** Why the project's screens were rejected: by category and by screen, newest first. */
export async function rejectionPatterns(
  deps: DbDeps,
  projectId: string,
  filter: RejectionFilter = {},
): Promise<RejectionPatterns> {
  const limit = Math.min(Math.max(1, filter.limit ?? MAX_REJECTIONS), MAX_REJECTIONS);
  if (filter.snapshotKeys?.length === 0) return { total: 0, categories: [], screens: [] };
  const rows = await rejectedRows(deps, projectId, filter, limit);
  const slips = await undone(deps, rows);
  const screens = new Map<string, { row: Row; rejections: Rejection[] }>();
  const categories = new Map<RejectionCategory, { count: number; screens: Set<string>; lastAt: number }>();
  let total = 0;
  for (const row of rows) {
    if (slips.has(row.id)) continue;
    total += 1;
    const rejection: Rejection = {
      checkId: row.checkId,
      buildId: row.buildId,
      buildNumber: Number(row.number),
      branch: row.branch,
      reasonCode: row.reasonCode,
      reason: row.comment,
      by: { kind: row.actorKind, id: row.actor, name: row.actorName },
      at: Number(row.createdAt),
    };
    const screen = screens.get(row.snapshotKey) ?? { row, rejections: [] };
    screen.rejections.push(rejection);
    screens.set(row.snapshotKey, screen);
    const code: RejectionCategory = row.reasonCode ?? 'uncategorized';
    const category = categories.get(code) ?? { count: 0, screens: new Set(), lastAt: 0 };
    category.count += 1;
    category.screens.add(row.snapshotKey);
    category.lastAt = Math.max(category.lastAt, rejection.at);
    categories.set(code, category);
  }
  return {
    total,
    categories: [...categories]
      .map(([code, c]) => ({ code, count: c.count, screens: c.screens.size, lastAt: c.lastAt }))
      .sort((a, b) => b.count - a.count || b.lastAt - a.lastAt),
    screens: [...screens.values()].map(({ row, rejections }) => {
      const byCategory: Partial<Record<RejectionCategory, number>> = {};
      for (const r of rejections) {
        const code: RejectionCategory = r.reasonCode ?? 'uncategorized';
        byCategory[code] = (byCategory[code] ?? 0) + 1;
      }
      const top = topOf(rejections);
      return {
        snapshotKey: row.snapshotKey,
        name: row.name,
        variant: JSON.parse(row.variant) as Record<string, string>,
        count: rejections.length,
        byCategory,
        top,
        tooEarly: rejections.filter((r) => r.reasonCode && TOO_EARLY.includes(r.reasonCode)).length,
        hint: hintOf(byCategory, top),
        recent: rejections.slice(0, RECENT_PER_SCREEN),
        lastAt: rejections[0]?.at ?? 0,
      };
    }),
  };
}

/**
 * The rejection patterns of the screens in a build, on every branch (a page that loads slowly does
 * so on every branch), each with its check in the build: what an agent reviewing the build or the
 * SDK ending its run needs, in one call.
 */
export async function buildRejectionPatterns(deps: DbDeps, buildId: string): Promise<RejectionPatterns> {
  const build = await getBuildRow(deps, buildId);
  const checks = await deps.db
    .selectFrom('checks')
    .select(['id', 'snapshotKey'])
    .where('buildId', '=', buildId)
    .execute();
  const patterns = await rejectionPatterns(deps, build.projectId, { snapshotKeys: checks.map((c) => c.snapshotKey) });
  const byKey = new Map(checks.map((c) => [c.snapshotKey, c.id]));
  for (const screen of patterns.screens) {
    const checkId = byKey.get(screen.snapshotKey);
    if (checkId) screen.checkId = checkId;
  }
  return patterns;
}

/** Rejections of these checks that call their change noise (flaky screens), per category. */
export async function noiseRejections(
  deps: DbDeps,
  checkIds: string[],
): Promise<Map<string, Partial<Record<RejectReason, number>>>> {
  const out = new Map<string, Partial<Record<RejectReason, number>>>();
  const ids = [...new Set(checkIds)];
  for (let at = 0; at < ids.length; at += KEYS_PER_QUERY) {
    const rows = await deps.db
      .selectFrom('reviewEvents')
      .select(['id', 'checkId', 'action', 'reasonCode'])
      .where('checkId', 'in', ids.slice(at, at + KEYS_PER_QUERY))
      .where('action', 'in', ['approved', 'rejected', 'reset'])
      .orderBy('checkId')
      .orderBy('id')
      .execute();
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i] as (typeof rows)[number];
      const next = rows[i + 1];
      if (row.action !== 'rejected' || !row.reasonCode || !NOISE.includes(row.reasonCode)) continue;
      if (next?.checkId === row.checkId && next.action === 'reset') continue;
      const counts = out.get(row.checkId) ?? {};
      counts[row.reasonCode] = (counts[row.reasonCode] ?? 0) + 1;
      out.set(row.checkId, counts);
    }
  }
  return out;
}
