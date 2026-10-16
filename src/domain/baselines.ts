import type { Db } from '../db/database';
import type { Baseline } from '../db/schema';
import { AppError } from '../errors';
import { newId } from '../ids';
import type { Deps } from './deps';
import { outdateOlder } from './outdated';
import { type Page, toPage } from './pagination';
import { getProjectBySlug } from './projects';
import { type PageInput, pageInputSchema, parseInput } from './schemas';

export interface BaselineView extends Omit<Baseline, 'variant'> {
  variant: Record<string, string>;
}

export function toBaselineView(row: Baseline): BaselineView {
  return { ...row, variant: JSON.parse(row.variant) as Record<string, string> };
}

/** Latest baseline for the snapshot on exactly this branch. Accepts a transaction. */
export function findCurrentBaseline(
  db: Db,
  projectId: string,
  snapshotKey: string,
  branch: string,
): Promise<Baseline | undefined> {
  return db
    .selectFrom('baselines')
    .selectAll()
    .where('projectId', '=', projectId)
    .where('snapshotKey', '=', snapshotKey)
    .where('branch', '=', branch)
    .orderBy('createdAt', 'desc')
    .orderBy('id', 'desc')
    .limit(1)
    .executeTakeFirst();
}

/** The build's own branch first, then its base branch. */
export async function resolveBaseline(
  db: Db,
  projectId: string,
  snapshotKey: string,
  branch: string,
  baseBranch: string,
): Promise<{ baseline: Baseline; fallback: boolean } | null> {
  const own = await findCurrentBaseline(db, projectId, snapshotKey, branch);
  if (own) return { baseline: own, fallback: false };
  if (baseBranch !== branch) {
    const base = await findCurrentBaseline(db, projectId, snapshotKey, baseBranch);
    if (base) return { baseline: base, fallback: true };
  }
  return null;
}

export interface NewBaseline {
  projectId: string;
  snapshotKey: string;
  name: string;
  /** JSON text, as stored on the check. */
  variant: string;
  branch: string;
  imageSha: string;
  sourceCheckId: string | null;
  approvedBy: string;
}

/** Appends to the history; the newest row becomes current. Accepts a transaction. */
export async function appendBaseline(db: Db, input: NewBaseline): Promise<Baseline> {
  const baseline: Baseline = { id: newId('bln'), ...input, createdAt: Date.now() };
  await db.insertInto('baselines').values(baseline).execute();
  return baseline;
}

/** Newest first. */
export async function baselineHistory(
  deps: Pick<Deps, 'db'>,
  projectSlug: string,
  snapshotKey: string,
  options: { branch?: string } & PageInput = {},
): Promise<Page<BaselineView>> {
  const { branch, ...pageOptions } = options;
  const page = parseInput(pageInputSchema, pageOptions);
  const project = await getProjectBySlug(deps, projectSlug);
  let query = deps.db
    .selectFrom('baselines')
    .selectAll()
    .where('projectId', '=', project.id)
    .where('snapshotKey', '=', snapshotKey);
  if (branch) query = query.where('branch', '=', branch);
  if (page.cursor) query = query.where('id', '<', page.cursor);
  const rows = await query
    .orderBy('id', 'desc')
    .limit(page.limit + 1)
    .execute();
  const result = toPage(rows, page.limit);
  return { items: result.items.map(toBaselineView), nextCursor: result.nextCursor };
}

/**
 * Copies the current baseline of every snapshot on `branch` to the project's main branch,
 * skipping snapshots whose main baseline already has the same image. Idempotent.
 */
export async function promoteBranch(
  deps: Pick<Deps, 'db'>,
  projectSlug: string,
  branch: string,
  actor: string,
): Promise<{ promoted: number }> {
  const project = await getProjectBySlug(deps, projectSlug);
  if (branch === project.mainBranch) {
    throw new AppError('invalid_promotion', 400, `Branch "${branch}" is the main branch; there is nothing to promote.`);
  }
  return deps.db.transaction().execute(async (tx) => {
    // Lock the project row (a no-op update) so concurrent promotions run one after another;
    // each then sees the main baselines the previous one appended.
    await tx
      .updateTable('projects')
      .set((eb) => ({ slug: eb.ref('slug') }))
      .where('id', '=', project.id)
      .execute();
    const rows = await tx
      .selectFrom('baselines')
      .selectAll()
      .where('projectId', '=', project.id)
      .where('branch', '=', branch)
      .orderBy('createdAt', 'desc')
      .orderBy('id', 'desc')
      .execute();
    const latest = new Map<string, Baseline>();
    for (const row of rows) if (!latest.has(row.snapshotKey)) latest.set(row.snapshotKey, row);

    let promoted = 0;
    for (const baseline of latest.values()) {
      const main = await findCurrentBaseline(tx, project.id, baseline.snapshotKey, project.mainBranch);
      if (main?.imageSha === baseline.imageSha) continue;
      await appendBaseline(tx, {
        projectId: project.id,
        snapshotKey: baseline.snapshotKey,
        name: baseline.name,
        variant: baseline.variant,
        branch: project.mainBranch,
        imageSha: baseline.imageSha,
        sourceCheckId: baseline.sourceCheckId,
        approvedBy: actor,
      });
      // Older main builds must not put their screenshot of this screen back over it.
      if (baseline.sourceCheckId) {
        const source = await tx
          .selectFrom('checks')
          .innerJoin('builds', 'builds.id', 'checks.buildId')
          .select('builds.number')
          .where('checks.id', '=', baseline.sourceCheckId)
          .executeTakeFirst();
        if (source) {
          await outdateOlder(
            tx,
            {
              projectId: project.id,
              snapshotKey: baseline.snapshotKey,
              branch: project.mainBranch,
              buildNumber: source.number,
            },
            baseline.sourceCheckId,
          );
        }
      }
      promoted += 1;
    }
    return { promoted };
  });
}
