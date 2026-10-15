import { sql } from 'kysely';
import { type BuildView, viewsOf } from './builds';
import type { Deps } from './deps';
import { getProjectBySlug } from './projects';
import type { Verdict } from './verdict';

type DbDeps = Pick<Deps, 'db'>;

export const MAX_BRANCHES = 50;
export const RECENT_BUILDS = 10;

export interface RecentBuild {
  id: string;
  number: number;
  verdict: Verdict;
  createdAt: number;
}

export interface BranchSummary {
  branch: string;
  latest: BuildView;
  /** The branch's last builds, newest first, at most RECENT_BUILDS. */
  recent: RecentBuild[];
}

/**
 * UI spec §3.5: the project's branches with their latest build and recent verdicts. The main
 * branch comes first; the others follow by their latest build, newest first, up to MAX_BRANCHES.
 */
export async function listBranchSummaries(deps: DbDeps, projectSlug: string): Promise<BranchSummary[]> {
  const project = await getProjectBySlug(deps, projectSlug);
  const branches = await deps.db
    .selectFrom('builds')
    .select((eb) => ['branch', eb.fn.max('createdAt').as('lastAt')])
    .where('projectId', '=', project.id)
    .groupBy('branch')
    .orderBy(sql`case when branch = ${project.mainBranch} then 0 else 1 end`)
    .orderBy('lastAt', 'desc')
    .orderBy('branch')
    .limit(MAX_BRANCHES)
    .execute();
  if (branches.length === 0) return [];

  const ranked = await deps.db
    .selectFrom((eb) =>
      eb
        .selectFrom('builds')
        .selectAll()
        .select((inner) =>
          inner.fn
            .agg<number>('row_number')
            .over((over) => over.partitionBy('branch').orderBy('createdAt', 'desc').orderBy('id', 'desc'))
            .as('position'),
        )
        .where('projectId', '=', project.id)
        .where(
          'branch',
          'in',
          branches.map((b) => b.branch),
        )
        .as('ranked'),
    )
    .selectAll()
    .where('position', '<=', RECENT_BUILDS)
    .orderBy('position')
    .execute();
  const views = await viewsOf(
    deps,
    ranked.map(({ position: _, ...build }) => build),
  );

  const byBranch = new Map<string, BuildView[]>();
  for (const view of views) byBranch.set(view.branch, [...(byBranch.get(view.branch) ?? []), view]);
  return branches.map(({ branch }) => {
    const builds = byBranch.get(branch) ?? [];
    return {
      branch,
      latest: builds[0] as BuildView,
      recent: builds.map(({ id, number, verdict, createdAt }) => ({ id, number, verdict, createdAt })),
    };
  });
}
