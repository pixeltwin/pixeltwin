import type { CheckResult, CheckReview } from '../db/schema';
import type { DiffData, Rect, Region } from '../diff/types';
import type { Deps } from './deps';

// Flaky screens: a screen whose screenshot keeps changing back and forth (a clock, an ad, an
// animation caught mid-way) although nobody changed it. Found on read from the screen's last
// checks on one branch, so nothing is stored that retention or a deleted build could leave stale,
// and the same on SQLite and Postgres. Per branch, because a feature branch that changes a screen
// legitimately would look like flipping next to main.

/** How many of a screen's last checks on a branch are looked at. */
export const HISTORY_SIZE = 20;
/** Flips needed to call a screen flaky: one could be a change and its revert. */
export const MIN_FLIPS = 2;

/** One check of a screen's history on a branch. */
export interface HistoryEntry {
  checkId: string;
  buildId: string;
  buildNumber: number;
  imageSha: string;
  result: CheckResult;
  review: CheckReview;
  reviewedBy: string | null;
  /** The changes of a changed check, else empty. */
  regions: Region[];
  createdAt: number;
}

export interface FlakySignal {
  /** Flips per run in the history (0 to 1): how often the screen flipped. */
  score: number;
  /** Runs in which the screen flipped. */
  flips: number;
  /** Checks looked at (at most HISTORY_SIZE). */
  checks: number;
  /** When it last flipped (the flipping check's time). */
  lastSeen: number;
  /** Where it keeps changing: the changes that recur, as one rectangle. */
  unstableArea: Rect | null;
}

const overlaps = (a: Rect, b: Rect) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

function union(rects: Rect[]): Rect | null {
  if (rects.length === 0) return null;
  const x = Math.min(...rects.map((r) => r.x));
  const y = Math.min(...rects.map((r) => r.y));
  const right = Math.max(...rects.map((r) => r.x + r.width));
  const bottom = Math.max(...rects.map((r) => r.y + r.height));
  return { x, y, width: right - x, height: bottom - y };
}

/** Whether `areas` cover `rect`, tested on a grid of up to 33×33 points over it. */
export function covered(rect: Rect, areas: Rect[]): boolean {
  if (areas.length === 0) return false;
  const steps = 32;
  for (let i = 0; i <= steps; i++) {
    for (let j = 0; j <= steps; j++) {
      const px = rect.x + ((rect.width - 1) * i) / steps;
      const py = rect.y + ((rect.height - 1) * j) / steps;
      if (!areas.some((a) => px >= a.x && px < a.x + a.width && py >= a.y && py < a.y + a.height)) return false;
    }
  }
  return true;
}

/**
 * The flaky signal of a screen from its history (oldest first), or null when it is not flaky.
 * A check flips when something visible changed (it or the check before it is `changed`) and
 * either it went back to a screenshot the screen had before, but not just before (A→B→A), or the
 * check before was a change nobody approved and it is unchanged again (the change went away by
 * itself). Each check flips at most once. The unstable area joins the changes of the flipping
 * checks that overlap a change of another flipping check (a change seen once is left out unless
 * nothing recurs). The history is read with today's ignore areas: a change they cover is no change
 * any more, so ignoring the area that keeps changing takes care of the screen at once.
 */
export function flakySignal(history: HistoryEntry[], ignoreAreas: Rect[] = []): FlakySignal | null {
  const shown = history.map((h) => {
    const regions = h.result === 'changed' ? h.regions.filter((r) => !covered(r, ignoreAreas)) : [];
    // A change without regions (a check from before they were kept) stays a change.
    const changed = h.result === 'changed' && (h.regions.length === 0 || regions.length > 0);
    return { ...h, regions, changed, quiet: !changed && (h.result === 'unchanged' || h.result === 'changed') };
  });
  let flips = 0;
  let lastSeen = 0;
  const involved = new Set<number>();
  const seen = new Set<string>();
  for (let i = 1; i < shown.length; i++) {
    const now = shown[i] as (typeof shown)[number];
    const before = shown[i - 1] as (typeof shown)[number];
    if (i >= 2) seen.add((shown[i - 2] as (typeof shown)[number]).imageSha);
    const visible = now.changed || before.changed;
    const returned = now.imageSha !== before.imageSha && seen.has(now.imageSha);
    const wentAway = before.changed && before.review !== 'approved' && now.quiet;
    if (!visible || !(returned || wentAway)) continue;
    flips += 1;
    lastSeen = Math.max(lastSeen, now.createdAt);
    if (now.changed) involved.add(i);
    if (before.changed) involved.add(i - 1);
  }
  if (flips < MIN_FLIPS) return null;

  const changes = [...involved].flatMap((i) => (shown[i]?.regions ?? []).map((region) => ({ i, region })));
  const recurring = changes.filter(
    ({ i, region }) => new Set(changes.filter((c) => c.i !== i && overlaps(c.region, region)).map((c) => c.i)).size > 0,
  );
  const area = union(
    (recurring.length > 0 ? recurring : changes).map(({ region: { x, y, width, height } }) => ({
      x,
      y,
      width,
      height,
    })),
  );
  if (area && covered(area, ignoreAreas)) return null;
  return {
    score: Math.round((flips / (history.length - 1)) * 100) / 100,
    flips,
    checks: history.length,
    lastSeen,
    unstableArea: area,
  };
}

/** A screen of a project on a branch, with its history (oldest first) and flaky signal. */
export interface ScreenHistory {
  snapshotKey: string;
  branch: string;
  /** Of the screen's latest check. */
  name: string;
  variant: Record<string, string>;
  history: HistoryEntry[];
  flaky: FlakySignal | null;
}

/** Keys per query, well below the parameter limits of SQLite and Postgres. */
const KEYS_PER_QUERY = 400;

/**
 * The last HISTORY_SIZE checks of each named screen of the project, per branch (or on `branch`
 * only), in one query per few hundred screens: a window over the snapshot index.
 */
export async function screenHistories(
  deps: Pick<Deps, 'db'>,
  projectId: string,
  snapshotKeys: string[],
  branch?: string,
): Promise<ScreenHistory[]> {
  const keys = [...new Set(snapshotKeys)];
  const rows = [];
  for (let at = 0; at < keys.length; at += KEYS_PER_QUERY) {
    let ranked = deps.db
      .selectFrom('checks')
      .innerJoin('builds', 'builds.id', 'checks.buildId')
      .select((eb) => [
        'checks.id',
        'checks.buildId',
        'checks.snapshotKey',
        'checks.name',
        'checks.variant',
        'checks.imageSha',
        'checks.result',
        'checks.review',
        'checks.reviewedBy',
        'checks.diff',
        'checks.createdAt',
        'builds.number as buildNumber',
        'builds.branch',
        eb.fn
          .agg<number>('row_number')
          .over((over) => over.partitionBy(['checks.snapshotKey', 'builds.branch']).orderBy('builds.number', 'desc'))
          .as('position'),
      ])
      .where('checks.projectId', '=', projectId)
      .where('checks.snapshotKey', 'in', keys.slice(at, at + KEYS_PER_QUERY));
    if (branch !== undefined) ranked = ranked.where('builds.branch', '=', branch);
    rows.push(
      ...(await deps.db.selectFrom(ranked.as('ranked')).selectAll().where('position', '<=', HISTORY_SIZE).execute()),
    );
  }
  const areas = await ignoreAreasOf(deps, projectId, keys);
  const screens = new Map<string, ScreenHistory>();
  // Newest first from the window; the history reads oldest first.
  const sorted = rows.sort((a, b) => Number(b.position) - Number(a.position));
  for (const row of sorted) {
    const id = `${row.branch}\0${row.snapshotKey}`;
    let screen = screens.get(id);
    if (!screen) {
      screen = { snapshotKey: row.snapshotKey, branch: row.branch, name: '', variant: {}, history: [], flaky: null };
      screens.set(id, screen);
    }
    const diff = row.result === 'changed' && row.diff ? (JSON.parse(row.diff) as DiffData) : null;
    screen.history.push({
      checkId: row.id,
      buildId: row.buildId,
      buildNumber: Number(row.buildNumber),
      imageSha: row.imageSha,
      result: row.result,
      review: row.review,
      reviewedBy: row.reviewedBy,
      regions: diff && 'regions' in diff ? diff.regions : [],
      createdAt: Number(row.createdAt),
    });
    screen.name = row.name;
    screen.variant = JSON.parse(row.variant) as Record<string, string>;
  }
  for (const screen of screens.values()) screen.flaky = flakySignal(screen.history, areas.get(screen.snapshotKey));
  return [...screens.values()];
}

async function ignoreAreasOf(deps: Pick<Deps, 'db'>, projectId: string, keys: string[]): Promise<Map<string, Rect[]>> {
  const out = new Map<string, Rect[]>();
  for (let at = 0; at < keys.length; at += KEYS_PER_QUERY) {
    const rows = await deps.db
      .selectFrom('snapshotAreas')
      .select(['snapshotKey', 'x', 'y', 'width', 'height'])
      .where('projectId', '=', projectId)
      .where('kind', '=', 'ignore')
      .where('snapshotKey', 'in', keys.slice(at, at + KEYS_PER_QUERY))
      .execute();
    for (const { snapshotKey, ...rect } of rows) out.set(snapshotKey, [...(out.get(snapshotKey) ?? []), rect]);
  }
  return out;
}

/** One screen's history on a branch (oldest first) with its flaky signal. */
export async function screenHistory(
  deps: Pick<Deps, 'db'>,
  screen: { projectId: string; snapshotKey: string; branch: string },
): Promise<ScreenHistory | null> {
  const [found] = await screenHistories(deps, screen.projectId, [screen.snapshotKey], screen.branch);
  return found ?? null;
}

/**
 * The project's flaky screens, per branch, most flaky first (score, then flips, then the latest
 * flip). Only screens that changed at least once are looked at: a flip needs a visible change.
 */
export async function noisyScreens(deps: Pick<Deps, 'db'>, projectId: string): Promise<ScreenHistory[]> {
  const changed = await deps.db
    .selectFrom('checks')
    .select('snapshotKey')
    .distinct()
    .where('projectId', '=', projectId)
    .where('result', '=', 'changed')
    .execute();
  const screens = await screenHistories(
    deps,
    projectId,
    changed.map((r) => r.snapshotKey),
  );
  return screens
    .filter((s) => s.flaky)
    .sort((a, b) => {
      const x = a.flaky as FlakySignal;
      const y = b.flaky as FlakySignal;
      return (
        y.score - x.score ||
        y.flips - x.flips ||
        y.lastSeen - x.lastSeen ||
        a.name.localeCompare(b.name) ||
        a.branch.localeCompare(b.branch)
      );
    });
}
