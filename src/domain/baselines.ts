import type { Db } from '../db/database';
import type { Baseline, Project } from '../db/schema';
import { AppError } from '../errors';
import { newId } from '../ids';
import type { Deps } from './deps';
import { outdateOlder } from './outdated';
import { type Page, toPage } from './pagination';
import { getProjectBySlug } from './projects';
import { type PageInput, pageInputSchema, parseInput } from './schemas';

export interface BaselineView extends Omit<Baseline, 'variant' | 'elementsSha'> {
  variant: Record<string, string>;
}

export function toBaselineView(row: Baseline): BaselineView {
  const { elementsSha: _elementsSha, ...rest } = row;
  return { ...rest, variant: JSON.parse(row.variant) as Record<string, string> };
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
  /** The page elements of the screenshot (`element_sets.sha`), when the SDK sent them. */
  elementsSha?: string | null;
}

/** Appends to the history; the newest row becomes current. Accepts a transaction. */
export async function appendBaseline(db: Db, input: NewBaseline): Promise<Baseline> {
  const baseline: Baseline = {
    id: newId('bln'),
    ...input,
    elementsSha: input.elementsSha ?? null,
    createdAt: Date.now(),
  };
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

/** A branch screen whose current baseline differs from main's (or main has none). */
export interface PromotionCandidate {
  snapshotKey: string;
  name: string;
  variant: Record<string, string>;
  branchImageSha: string;
  /** main's current baseline image; null when main has none for this screen. */
  mainImageSha: string | null;
  /** When the branch baseline was approved. */
  approvedAt: number;
}

/** The branch's latest baseline per screen, newest first by approval. */
async function latestBranchBaselines(db: Db, projectId: string, branch: string): Promise<Baseline[]> {
  const rows = await db
    .selectFrom('baselines')
    .selectAll()
    .where('projectId', '=', projectId)
    .where('branch', '=', branch)
    .orderBy('createdAt', 'desc')
    .orderBy('id', 'desc')
    .execute();
  const latest = new Map<string, Baseline>();
  for (const row of rows) if (!latest.has(row.snapshotKey)) latest.set(row.snapshotKey, row);
  return [...latest.values()];
}

async function candidatesOf(
  db: Db,
  project: Project,
  branch: string,
): Promise<Array<PromotionCandidate & { baseline: Baseline }>> {
  const out: Array<PromotionCandidate & { baseline: Baseline }> = [];
  for (const baseline of await latestBranchBaselines(db, project.id, branch)) {
    const main = await findCurrentBaseline(db, project.id, baseline.snapshotKey, project.mainBranch);
    if (main?.imageSha === baseline.imageSha) continue;
    out.push({
      snapshotKey: baseline.snapshotKey,
      name: baseline.name,
      variant: JSON.parse(baseline.variant) as Record<string, string>,
      branchImageSha: baseline.imageSha,
      mainImageSha: main?.imageSha ?? null,
      approvedAt: baseline.createdAt,
      baseline,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name) || a.snapshotKey.localeCompare(b.snapshotKey));
}

function assertPromotable(project: Project, branch: string): void {
  if (branch === project.mainBranch) {
    throw new AppError('invalid_promotion', 400, `Branch "${branch}" is the main branch; there is nothing to promote.`);
  }
}

/** What promoting `branch` would change on main: its screens that differ from main, by name. */
export async function promotionCandidates(
  deps: Pick<Deps, 'db'>,
  projectSlug: string,
  branch: string,
): Promise<PromotionCandidate[]> {
  const project = await getProjectBySlug(deps, projectSlug);
  assertPromotable(project, branch);
  return (await candidatesOf(deps.db, project, branch)).map(({ baseline: _baseline, ...candidate }) => candidate);
}

/**
 * Copies the branch's current baselines to the main branch (after merging), all of them or only
 * `snapshotKeys`. Screens main already has unchanged are skipped. Every main check of a promoted
 * screen that still waits for review becomes outdated: main has decided that screen now.
 */
export async function promoteBranch(
  deps: Pick<Deps, 'db'>,
  projectSlug: string,
  branch: string,
  actor: string,
  options: { snapshotKeys?: string[] } = {},
): Promise<{ promoted: number }> {
  const project = await getProjectBySlug(deps, projectSlug);
  assertPromotable(project, branch);
  return deps.db.transaction().execute(async (tx) => {
    // Lock the project row (a no-op update) so concurrent promotions run one after another;
    // each then sees the main baselines the previous one appended.
    await tx
      .updateTable('projects')
      .set((eb) => ({ slug: eb.ref('slug') }))
      .where('id', '=', project.id)
      .execute();
    let chosen = await candidatesOf(tx, project, branch);
    if (options.snapshotKeys) {
      const onBranch = new Set((await latestBranchBaselines(tx, project.id, branch)).map((b) => b.snapshotKey));
      const missing = options.snapshotKeys.filter((key) => !onBranch.has(key));
      if (missing.length > 0) {
        throw new AppError(
          'snapshot_not_on_branch',
          422,
          `Branch "${branch}" has no baseline for ${missing.map((k) => `"${k}"`).join(', ')}.`,
        );
      }
      const keys = new Set(options.snapshotKeys);
      chosen = chosen.filter((c) => keys.has(c.snapshotKey));
    }
    for (const { baseline } of chosen) {
      await appendBaseline(tx, {
        projectId: project.id,
        snapshotKey: baseline.snapshotKey,
        name: baseline.name,
        variant: baseline.variant,
        branch: project.mainBranch,
        imageSha: baseline.imageSha,
        sourceCheckId: baseline.sourceCheckId,
        approvedBy: actor,
        elementsSha: baseline.elementsSha,
      });
      // Every main build that still waits on this screen is decided by the promotion, also those
      // made after the branch build (a run right after the merge).
      if (baseline.sourceCheckId) {
        await outdateOlder(
          tx,
          {
            projectId: project.id,
            snapshotKey: baseline.snapshotKey,
            branch: project.mainBranch,
            buildNumber: null,
          },
          baseline.sourceCheckId,
        );
      }
    }
    return { promoted: chosen.length };
  });
}
