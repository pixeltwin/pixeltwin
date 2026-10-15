import { isUniqueViolation } from '../db/database';
import type { Build } from '../db/schema';
import { AppError } from '../errors';
import { newId } from '../ids';
import type { Deps } from './deps';
import { type Page, toPage } from './pagination';
import { getProjectBySlug } from './projects';
import { createBuildSchema, type PageInput, pageInputSchema, parseInput } from './schemas';
import { type BuildCounts, deriveVerdict, emptyCounts, type Verdict } from './verdict';

type DbDeps = Pick<Deps, 'db'>;

export interface BuildView extends Build {
  verdict: Verdict;
  counts: BuildCounts;
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
    .select(['buildId', 'result', 'review', (eb) => eb.fn.countAll<number>().as('n')])
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
  }
  return counts;
}

function toView(build: Build, counts: BuildCounts): BuildView {
  return { ...build, verdict: deriveVerdict(counts), counts };
}

export async function getBuild(deps: DbDeps, id: string): Promise<BuildView> {
  const build = await getBuildRow(deps, id);
  const counts = await countChecks(deps, [id]);
  return toView(build, counts.get(id) ?? emptyCounts());
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
 * (`created: false`), so CI retries are safe.
 */
export async function createBuild(
  deps: DbDeps,
  projectSlug: string,
  input: unknown,
): Promise<{ build: BuildView; created: boolean }> {
  const data = parseInput(createBuildSchema, input);
  const project = await getProjectBySlug(deps, projectSlug);

  if (data.externalId) {
    const existing = await findByExternalId(deps, project.id, data.externalId);
    if (existing) return { build: await getBuild(deps, existing.id), created: false };
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
      };
      await tx.insertInto('builds').values(row).execute();
      return row;
    });
  } catch (err) {
    // A concurrent request with the same externalId won the race.
    if (data.externalId && isUniqueViolation(err)) {
      const existing = await findByExternalId(deps, project.id, data.externalId);
      if (existing) return { build: await getBuild(deps, existing.id), created: false };
    }
    throw err;
  }
  return { build: toView(build, emptyCounts()), created: true };
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
  const counts = await countChecks(
    deps,
    result.items.map((b) => b.id),
  );
  return {
    items: result.items.map((b) => toView(b, counts.get(b.id) ?? emptyCounts())),
    nextCursor: result.nextCursor,
  };
}

/** Closes the build to new checks. Idempotent: keeps the first `finalizedAt`. */
export async function finalizeBuild(deps: DbDeps, id: string): Promise<BuildView> {
  await getBuildRow(deps, id);
  await deps.db
    .updateTable('builds')
    .set({ state: 'finalized', finalizedAt: Date.now() })
    .where('id', '=', id)
    .where('state', '=', 'open')
    .execute();
  return getBuild(deps, id);
}
