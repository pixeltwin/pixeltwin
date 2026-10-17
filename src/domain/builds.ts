import type { Db } from '../db/database';
import { isUniqueViolation } from '../db/database';
import type { Build } from '../db/schema';
import { AppError } from '../errors';
import { newId } from '../ids';
import type { Deps } from './deps';
import { type Page, toPage } from './pagination';
import { getProjectBySlug } from './projects';
import { AUTO_APPROVER } from './reviews';
import {
  createBuildSchema,
  finalizeBuildSchema,
  type PageInput,
  pageInputSchema,
  parseInput,
  timingsSchema,
} from './schemas';
import { type BuildCounts, deriveVerdict, emptyCounts, type Verdict } from './verdict';

type DbDeps = Pick<Deps, 'db'>;

/** How long pixeltwin took in the build's run, in milliseconds. */
export interface BuildTiming {
  /** Checks the SDK timed (with their retakes) and what it measured for them. */
  checks: number;
  screenshotMs: number;
  uploadMs: number;
  retakes: number;
  /** Server time of every check in the build: baseline, compare and store. */
  compareMs: number;
}

type TimingColumns = 'timingChecks' | 'timingScreenshotMs' | 'timingUploadMs' | 'timingRetakes';

export interface BuildView extends Omit<Build, TimingColumns> {
  verdict: Verdict;
  counts: BuildCounts;
  /** Parts of a parallel build that have finalized it so far (0 for an ordinary build). */
  partsFinished: number;
  timing: BuildTiming;
}

export async function getBuildRow(deps: DbDeps, id: string): Promise<Build> {
  const build = await deps.db.selectFrom('builds').selectAll().where('id', '=', id).executeTakeFirst();
  if (!build) throw new AppError('build_not_found', 404, `Build ${id} not found.`);
  return build;
}

export async function countChecks(deps: DbDeps, buildIds: string[]): Promise<Map<string, BuildCounts>> {
  const counts = new Map(buildIds.map((id) => [id, emptyCounts()]));
  if (buildIds.length === 0) return counts;
  const rows = await deps.db
    .selectFrom('checks')
    .select([
      'buildId',
      'result',
      'review',
      (eb) => eb.fn.countAll<number>().as('n'),
      (eb) => eb.fn.sum<number>(eb.case().when('reviewedBy', '=', AUTO_APPROVER).then(1).else(0).end()).as('auto'),
    ])
    .where('buildId', 'in', buildIds)
    .groupBy(['buildId', 'result', 'review'])
    .execute();
  for (const row of rows) {
    const c = counts.get(row.buildId);
    if (!c) continue;
    const n = Number(row.n);
    c.total += n;
    c.result[row.result] += n;
    c.review[row.review] += n;
    if (row.review === 'approved') c.autoApproved += Number(row.auto ?? 0);
  }
  return counts;
}

/** Finished parts per parallel build; ordinary builds are not queried. */
async function countParts(deps: DbDeps, builds: Build[]): Promise<Map<string, number>> {
  const ids = builds.filter((b) => b.parallelTotal !== null).map((b) => b.id);
  const parts = new Map<string, number>();
  if (ids.length === 0) return parts;
  const rows = await deps.db
    .selectFrom('buildParts')
    .select(['buildId', (eb) => eb.fn.countAll<number>().as('n')])
    .where('buildId', 'in', ids)
    .groupBy('buildId')
    .execute();
  for (const row of rows) parts.set(row.buildId, Number(row.n));
  return parts;
}

/** Server time of the builds' checks, added up per build. */
async function sumCompareMs(deps: DbDeps, buildIds: string[]): Promise<Map<string, number>> {
  const sums = new Map<string, number>();
  if (buildIds.length === 0) return sums;
  const rows = await deps.db
    .selectFrom('checks')
    .select(['buildId', (eb) => eb.fn.sum<number>('compareMs').as('ms')])
    .where('buildId', 'in', buildIds)
    .groupBy('buildId')
    .execute();
  for (const row of rows) sums.set(row.buildId, Number(row.ms ?? 0));
  return sums;
}

function toView(build: Build, counts: BuildCounts, partsFinished: number, compareMs: number): BuildView {
  const { timingChecks, timingScreenshotMs, timingUploadMs, timingRetakes, ...row } = build;
  return {
    ...row,
    verdict: deriveVerdict(counts),
    counts,
    partsFinished,
    timing: {
      checks: Number(timingChecks),
      screenshotMs: Number(timingScreenshotMs),
      uploadMs: Number(timingUploadMs),
      retakes: Number(timingRetakes),
      compareMs,
    },
  };
}

/** Adds verdict and counts to build rows, counting all their checks in one query. */
export async function viewsOf(deps: DbDeps, builds: Build[]): Promise<BuildView[]> {
  const ids = builds.map((b) => b.id);
  const [counts, parts, compare] = await Promise.all([
    countChecks(deps, ids),
    countParts(deps, builds),
    sumCompareMs(deps, ids),
  ]);
  return builds.map((b) => toView(b, counts.get(b.id) ?? emptyCounts(), parts.get(b.id) ?? 0, compare.get(b.id) ?? 0));
}

export async function getBuild(deps: DbDeps, id: string): Promise<BuildView> {
  const [view] = await viewsOf(deps, [await getBuildRow(deps, id)]);
  if (!view) throw new AppError('build_not_found', 404, `Build ${id} not found.`);
  return view;
}

function findByExternalId(deps: DbDeps, projectId: string, externalId: string): Promise<Build | undefined> {
  return deps.db
    .selectFrom('builds')
    .selectAll()
    .where('projectId', '=', projectId)
    .where('externalId', '=', externalId)
    .executeTakeFirst();
}

/**
 * Opens a build. With `externalId`, repeated calls return the existing build
 * (`created: false`), so CI retries and the other parts of a parallel build get the same one.
 */
export async function createBuild(
  deps: DbDeps,
  projectSlug: string,
  input: unknown,
): Promise<{ build: BuildView; created: boolean }> {
  const data = parseInput(createBuildSchema, input);
  const project = await getProjectBySlug(deps, projectSlug);

  // The part count is the first one named: a part that opens the build later cannot change it.
  // A part opening a finalized parallel build is a retried CI job: the build opens again, takes
  // its screenshots (same screens replace their checks) and is finalized again when it ends.
  const existingBuild = async (existing: Build) => {
    if (existing.state === 'finalized' && existing.parallelTotal !== null && data.parallelTotal !== undefined) {
      await deps.db
        .updateTable('builds')
        .set({ state: 'open', finalizedAt: null })
        .where('id', '=', existing.id)
        .execute();
    }
    if (existing.parallelTotal === null && data.parallelTotal !== undefined) {
      await deps.db
        .updateTable('builds')
        .set({ parallelTotal: data.parallelTotal })
        .where('id', '=', existing.id)
        .where('parallelTotal', 'is', null)
        .execute();
    }
    return { build: await getBuild(deps, existing.id), created: false };
  };

  if (data.externalId) {
    const existing = await findByExternalId(deps, project.id, data.externalId);
    if (existing) return existingBuild(existing);
  }

  let build: Build;
  try {
    // Taking the next number locks the project row, so concurrent creates get distinct numbers;
    // a create that loses an externalId race rolls back and leaves no gap.
    build = await deps.db.transaction().execute(async (tx) => {
      const { buildSeq } = await tx
        .updateTable('projects')
        .set((eb) => ({ buildSeq: eb('buildSeq', '+', 1) }))
        .where('id', '=', project.id)
        .returning('buildSeq')
        .executeTakeFirstOrThrow();
      const row: Build = {
        id: newId('bld'),
        projectId: project.id,
        number: buildSeq,
        branch: data.branch ?? project.mainBranch,
        baseBranch: data.baseBranch ?? project.mainBranch,
        externalId: data.externalId ?? null,
        commitSha: data.commitSha ?? null,
        state: 'open',
        createdAt: Date.now(),
        finalizedAt: null,
        parallelTotal: data.parallelTotal ?? null,
        timingChecks: 0,
        timingScreenshotMs: 0,
        timingUploadMs: 0,
        timingRetakes: 0,
      };
      await tx.insertInto('builds').values(row).execute();
      return row;
    });
  } catch (err) {
    // A concurrent request with the same externalId won the race.
    if (data.externalId && isUniqueViolation(err)) {
      const existing = await findByExternalId(deps, project.id, data.externalId);
      if (existing) return existingBuild(existing);
    }
    throw err;
  }
  return { build: toView(build, emptyCounts(), 0, 0), created: true };
}

/** Newest first. */
export async function listBuilds(
  deps: DbDeps,
  projectSlug: string,
  options: { branch?: string } & PageInput = {},
): Promise<Page<BuildView>> {
  const { branch, ...pageOptions } = options;
  const page = parseInput(pageInputSchema, pageOptions);
  const project = await getProjectBySlug(deps, projectSlug);
  let query = deps.db.selectFrom('builds').selectAll().where('projectId', '=', project.id);
  if (branch) query = query.where('branch', '=', branch);
  if (page.cursor) query = query.where('id', '<', page.cursor);
  const rows = await query
    .orderBy('id', 'desc')
    .limit(page.limit + 1)
    .execute();
  const result = toPage(rows, page.limit);
  return { items: await viewsOf(deps, result.items), nextCursor: result.nextCursor };
}

/**
 * Closes the build to new checks. Idempotent: keeps the first `finalizedAt`. A part of a parallel
 * build (`{ part }`) is counted once; the build closes when every part has finalized it. Without a
 * part it closes at once (a CI job that never ran, or an admin).
 */
export async function finalizeBuild(deps: DbDeps, id: string, input: unknown = {}): Promise<BuildView> {
  const { part } = parseInput(finalizeBuildSchema, input);
  const build = await getBuildRow(deps, id);
  if (build.state === 'open' && build.parallelTotal !== null && part) {
    await deps.db
      .insertInto('buildParts')
      .values({ buildId: id, part, finishedAt: Date.now() })
      .onConflict((oc) => oc.columns(['buildId', 'part']).doNothing())
      .execute();
    // Each part counts after its own insert, so the last of parts finishing together sees them all.
    const finished = (await countParts(deps, [build])).get(id) ?? 0;
    if (finished < build.parallelTotal) return getBuild(deps, id);
  }
  await deps.db
    .updateTable('builds')
    .set({ state: 'finalized', finalizedAt: Date.now() })
    .where('id', '=', id)
    .where('state', '=', 'open')
    .execute();
  return getBuild(deps, id);
}

/**
 * Adds what one SDK worker measured to the build's timing totals. Also on a finalized build: the
 * workers of a run report as they end, which can be after the build is finalized.
 */
export async function addTimings(deps: DbDeps, id: string, input: unknown): Promise<BuildView> {
  const t = parseInput(timingsSchema, input);
  await getBuildRow(deps, id);
  await deps.db
    .updateTable('builds')
    .set((eb) => ({
      timingChecks: eb('timingChecks', '+', t.checks),
      timingScreenshotMs: eb('timingScreenshotMs', '+', t.screenshotMs),
      timingUploadMs: eb('timingUploadMs', '+', t.uploadMs),
      timingRetakes: eb('timingRetakes', '+', t.retakes),
    }))
    .where('id', '=', id)
    .execute();
  return getBuild(deps, id);
}

/**
 * Deletes builds with their checks (and those checks' review history). Baselines approved in them
 * stay; their `sourceCheckId` is cleared. Shared by the retention job and manual deletion.
 */
export async function removeBuilds(db: Db, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await db.transaction().execute(async (tx) => {
    await tx
      .updateTable('baselines')
      .set({ sourceCheckId: null })
      .where('sourceCheckId', 'in', tx.selectFrom('checks').select('id').where('buildId', 'in', ids))
      .execute();
    await tx.deleteFrom('builds').where('id', 'in', ids).execute();
  });
}

/** Deletes some of a project's builds (all must be the project's); returns how many. */
export async function deleteBuilds(deps: Pick<Deps, 'db'>, projectId: string, ids: string[]): Promise<number> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return 0;
  const found = await deps.db
    .selectFrom('builds')
    .select('id')
    .where('projectId', '=', projectId)
    .where('id', 'in', unique)
    .execute();
  if (found.length !== unique.length) {
    throw new AppError('not_found', 404, 'Some of these builds do not exist in this project.');
  }
  await removeBuilds(deps.db, unique);
  return unique.length;
}
