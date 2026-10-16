import { sql } from 'kysely';
import type { Baseline, Build, CheckResult, CheckReview, CheckRow } from '../db/schema';
import { IDENTICAL_SUMMARY } from '../diff/summary';
import type { DiffData, DiffErrorData, DiffJobResult, Rect, Size } from '../diff/types';
import { AppError } from '../errors';
import { newId } from '../ids';
import { resolveBaseline } from './baselines';
import { getBuildRow } from './builds';
import type { Deps } from './deps';
import { loadImage, type PngSize, readPngHeader, sha256Hex, storeImage } from './images';
import { supersedingCheck } from './outdated';
import { type Page, toPage } from './pagination';
import { getProjectById } from './projects';
import { checkMetaSchema, type PageInput, pageInputSchema, parseInput } from './schemas';
import { snapshotKey } from './snapshot-key';

export interface CheckView {
  id: string;
  buildId: string;
  projectId: string;
  name: string;
  variant: Record<string, string>;
  snapshotKey: string;
  imageSha: string;
  baseline: { id: string; branch: string; fallback: boolean; imageSha: string } | null;
  diffImageSha: string | null;
  ignoreRegions: Rect[];
  colorThreshold: number;
  tolerancePercent: number;
  result: CheckResult;
  review: CheckReview;
  diff: DiffData | DiffErrorData | null;
  reviewedBy: string | null;
  reviewedAt: number | null;
  reviewComment: string | null;
  supersededBy: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface SubmitCheckInput {
  /** Check metadata, validated against `checkMetaSchema`. */
  meta: unknown;
  /** PNG bytes. */
  image: Uint8Array;
}

interface Outcome {
  result: CheckResult;
  diff: DiffData | DiffErrorData | null;
  diffPng: Uint8Array | null;
  diffSize: Size | null;
}

type CheckWithJoins = CheckRow & {
  baselineBranch: string | null;
  baselineImageSha: string | null;
  buildBranch: string;
};

function initialReview(result: CheckResult): CheckReview {
  return result === 'changed' || result === 'new' ? 'pending' : 'none';
}

function errorOutcome(code: 'diff_timeout' | 'diff_failed', message: string): Outcome {
  return { result: 'error', diff: { error: { code, message } }, diffPng: null, diffSize: null };
}

function buildFinalized(build: Build): AppError {
  const at = new Date(build.finalizedAt ?? 0).toISOString();
  return new AppError('build_finalized', 409, `Build ${build.id} was finalized at ${at}.`);
}

function invalidImage(message: string): AppError {
  return new AppError('invalid_image', 422, message);
}

/** What a comparison skips: the check's own ignore regions plus the snapshot's drawn areas. */
interface SnapshotRegions {
  ignore: Rect[];
  compare: Rect[];
}

async function regionsFor(
  db: Deps['db'],
  projectId: string,
  snapshotKey: string,
  checkIgnore: Rect[],
): Promise<SnapshotRegions> {
  const areas = await db
    .selectFrom('snapshotAreas')
    .select(['kind', 'x', 'y', 'width', 'height'])
    .where('projectId', '=', projectId)
    .where('snapshotKey', '=', snapshotKey)
    .orderBy('id')
    .execute();
  const rect = ({ x, y, width, height }: Rect) => ({ x, y, width, height });
  return {
    ignore: [...checkIgnore, ...areas.filter((a) => a.kind === 'ignore').map(rect)],
    compare: areas.filter((a) => a.kind === 'compare').map(rect),
  };
}

async function evaluate(
  deps: Deps,
  image: Uint8Array,
  imageSha: string,
  header: PngSize,
  baseline: Baseline | null,
  regions: SnapshotRegions,
  colorThreshold: number,
  tolerancePercent: number,
): Promise<Outcome> {
  const job = {
    current: image,
    ignoreRegions: regions.ignore,
    compareRegions: regions.compare,
    colorThreshold,
    tolerancePercent,
    maxPixels: deps.limits.maxImagePixels,
  };

  if (!baseline) {
    const validated = await deps.runDiff({ ...job, baseline: null });
    if (validated.kind === 'invalid_image') throw invalidImage(validated.message);
    if (validated.kind === 'error') return errorOutcome(validated.code, validated.message);
    return { result: 'new', diff: null, diffPng: null, diffSize: null };
  }

  if (baseline.imageSha === imageSha) {
    return {
      result: 'unchanged',
      diff: {
        percent: 0,
        pixels: 0,
        colorThreshold,
        tolerancePercent,
        dimensions: null,
        regions: [],
        regionsTruncated: false,
        summary: IDENTICAL_SUMMARY,
      },
      diffPng: null,
      diffSize: null,
    };
  }

  const baselineBytes = await loadImage(deps, baseline.imageSha);
  if (!baselineBytes)
    return errorOutcome('diff_failed', `Baseline image ${baseline.imageSha} is missing from storage.`);

  const compared: DiffJobResult = await deps.runDiff({ ...job, baseline: baselineBytes });
  switch (compared.kind) {
    case 'invalid_image':
      throw invalidImage(compared.message);
    case 'error':
      return errorOutcome(compared.code, compared.message);
    case 'validated':
      return errorOutcome('diff_failed', 'Diff worker returned no comparison.');
    case 'compared': {
      const dims = compared.diff.dimensions;
      const diffSize = dims
        ? {
            width: Math.max(dims.baseline.width, dims.current.width),
            height: Math.max(dims.baseline.height, dims.current.height),
          }
        : header;
      return { result: compared.result, diff: compared.diff, diffPng: compared.diffPng, diffSize };
    }
  }
}

function checksWithJoins(deps: Pick<Deps, 'db'>) {
  return deps.db
    .selectFrom('checks')
    .innerJoin('builds', 'builds.id', 'checks.buildId')
    .leftJoin('baselines', 'baselines.id', 'checks.baselineId')
    .selectAll('checks')
    .select([
      'baselines.branch as baselineBranch',
      'baselines.imageSha as baselineImageSha',
      'builds.branch as buildBranch',
    ]);
}

function toCheckView(row: CheckWithJoins): CheckView {
  const { baselineBranch, baselineImageSha, buildBranch, variant, ignoreRegions, diff, baselineId, ...rest } = row;
  return {
    ...rest,
    variant: JSON.parse(variant) as Record<string, string>,
    ignoreRegions: JSON.parse(ignoreRegions) as Rect[],
    diff: diff ? (JSON.parse(diff) as DiffData | DiffErrorData) : null,
    baseline:
      baselineId && baselineBranch && baselineImageSha
        ? {
            id: baselineId,
            branch: baselineBranch,
            fallback: baselineBranch !== buildBranch,
            imageSha: baselineImageSha,
          }
        : null,
  };
}

export async function getCheck(deps: Pick<Deps, 'db'>, id: string): Promise<CheckView> {
  const row = await checksWithJoins(deps).where('checks.id', '=', id).executeTakeFirst();
  if (!row) throw new AppError('check_not_found', 404, `Check ${id} not found.`);
  return toCheckView(row);
}

/** Oldest first. */
export async function listChecks(
  deps: Pick<Deps, 'db'>,
  buildId: string,
  options: { result?: CheckResult; review?: CheckReview } & PageInput = {},
): Promise<Page<CheckView>> {
  const { result, review, ...pageOptions } = options;
  const page = parseInput(pageInputSchema, pageOptions);
  await getBuildRow(deps, buildId);
  let query = checksWithJoins(deps).where('checks.buildId', '=', buildId);
  if (result) query = query.where('checks.result', '=', result);
  if (review) query = query.where('checks.review', '=', review);
  if (page.cursor) query = query.where('checks.id', '>', page.cursor);
  const rows = await query
    .orderBy('checks.id', 'asc')
    .limit(page.limit + 1)
    .execute();
  const pageRows = toPage(rows, page.limit);
  return { items: pageRows.items.map(toCheckView), nextCursor: pageRows.nextCursor };
}

/**
 * Compares a screenshot with its baseline and records the result. Posting the same snapshot
 * to an open build again replaces the earlier check in place (`created: false`).
 */
export async function submitCheck(
  deps: Deps,
  buildId: string,
  input: SubmitCheckInput,
): Promise<{ check: CheckView; created: boolean }> {
  const build = await getBuildRow(deps, buildId);
  if (build.state === 'finalized') throw buildFinalized(build);
  const meta = parseInput(checkMetaSchema, input.meta);
  const header = readPngHeader(input.image, deps.limits);
  const project = await getProjectById(deps, build.projectId);
  const key = snapshotKey(meta.name, meta.variant);
  const colorThreshold = meta.colorThreshold ?? project.colorThreshold;
  const tolerancePercent = meta.tolerancePercent ?? project.tolerancePercent;
  const resolved = await resolveBaseline(deps.db, project.id, key, build.branch, build.baseBranch);
  const imageSha = sha256Hex(input.image);

  const outcome = await evaluate(
    deps,
    input.image,
    imageSha,
    header,
    resolved?.baseline ?? null,
    await regionsFor(deps.db, project.id, key, meta.ignoreRegions),
    colorThreshold,
    tolerancePercent,
  );

  await storeImage(deps, input.image, header);
  const diffImageSha =
    outcome.diffPng && outcome.diffSize ? await storeImage(deps, outcome.diffPng, outcome.diffSize) : null;

  // A newer build of this branch may already have approved this screen (a late post to an
  // older, still open build): then this check is outdated from the start.
  const initial = initialReview(outcome.result);
  const newer =
    initial === 'pending'
      ? await supersedingCheck(deps.db, {
          projectId: project.id,
          snapshotKey: key,
          branch: build.branch,
          buildNumber: build.number,
        })
      : null;
  const now = Date.now();
  const values = {
    buildId,
    projectId: project.id,
    name: meta.name,
    variant: JSON.stringify(meta.variant),
    snapshotKey: key,
    imageSha,
    baselineId: resolved?.baseline.id ?? null,
    diffImageSha,
    ignoreRegions: JSON.stringify(meta.ignoreRegions),
    colorThreshold,
    tolerancePercent,
    result: outcome.result,
    review: newer ? ('outdated' as const) : initial,
    supersededBy: newer?.id ?? null,
    diff: outcome.diff ? JSON.stringify(outcome.diff) : null,
    reviewedBy: null,
    reviewedAt: null,
    reviewComment: null,
    updatedAt: now,
  };
  // The diff above can take seconds; the build may have been finalized meanwhile. Locking the
  // open build row (a no-op update) makes a concurrent finalize wait until this check commits.
  const created = await deps.db.transaction().execute(async (tx) => {
    const stillOpen = await tx
      .updateTable('builds')
      .set((eb) => ({ state: eb.ref('state') }))
      .where('id', '=', buildId)
      .where('state', '=', 'open')
      .executeTakeFirst();
    if (Number(stillOpen.numUpdatedRows) === 0) throw buildFinalized(await getBuildRow({ db: tx }, buildId));
    const existing = await tx
      .selectFrom('checks')
      .select('id')
      .where('buildId', '=', buildId)
      .where('snapshotKey', '=', key)
      .executeTakeFirst();
    await tx
      .insertInto('checks')
      .values({ id: newId('chk'), createdAt: now, ...values })
      .onConflict((oc) => oc.columns(['buildId', 'snapshotKey']).doUpdateSet(values))
      .execute();
    return !existing;
  });
  const row = await checksWithJoins(deps)
    .where('checks.buildId', '=', buildId)
    .where('checks.snapshotKey', '=', key)
    .executeTakeFirstOrThrow();
  return { check: toCheckView(row), created };
}

/**
 * Compares a check with its baseline again, after the snapshot's areas changed (Plan 6). The
 * result and diff follow the new comparison; a check nobody reviewed yet gets the review state a
 * new check with this result would get, a reviewed one keeps its review.
 */
export async function recomputeCheck(deps: Deps, checkId: string): Promise<CheckView> {
  const check = await getCheck(deps, checkId);
  if (!check.baseline) return check;
  const baseline = await deps.db
    .selectFrom('baselines')
    .selectAll()
    .where('id', '=', check.baseline.id)
    .executeTakeFirst();
  if (!baseline) return check;
  const image = await loadImage(deps, check.imageSha);
  if (!image) return check;
  const header = readPngHeader(image, deps.limits);
  const regions = () => regionsFor(deps.db, check.projectId, check.snapshotKey, check.ignoreRegions);
  // Areas drawn or deleted while the comparison ran mean it is already out of date: compare again,
  // so of two quick edits the comparison that saw both is the one that stays.
  let used = await regions();
  for (;;) {
    const outcome = await evaluate(
      deps,
      image,
      check.imageSha,
      header,
      baseline,
      used,
      check.colorThreshold,
      check.tolerancePercent,
    );
    const latest = await regions();
    if (JSON.stringify(latest) !== JSON.stringify(used)) {
      used = latest;
      continue;
    }
    const diffImageSha =
      outcome.diffPng && outcome.diffSize ? await storeImage(deps, outcome.diffPng, outcome.diffSize) : null;
    const initial = initialReview(outcome.result);
    await deps.db
      .updateTable('checks')
      .set((eb) => ({
        result: outcome.result,
        diff: outcome.diff ? JSON.stringify(outcome.diff) : null,
        diffImageSha,
        // Decided in SQL, not from the read above: a review made while the comparison ran stays.
        review: eb
          .case()
          .when('review', 'in', ['approved', 'rejected', 'outdated'])
          .then(eb.ref('review'))
          .else(sql.lit(initial))
          .end(),
        updatedAt: Date.now(),
      }))
      .where('id', '=', checkId)
      .execute();
    return getCheck(deps, checkId);
  }
}

export interface CheckNeighbors {
  previous: string | null;
  next: string | null;
  /** The next check awaiting review after this one, wrapping around; null when none is left. */
  nextPending: string | null;
}

/** Navigation within a build, in the order `listChecks` uses (oldest first). */
export async function checkNeighbors(
  deps: Pick<Deps, 'db'>,
  check: { id: string; buildId: string },
): Promise<CheckNeighbors> {
  const inBuild = deps.db.selectFrom('checks').select('id').where('buildId', '=', check.buildId);
  const [previous, next, pendingAfter, pendingFirst] = await Promise.all([
    inBuild.where('id', '<', check.id).orderBy('id', 'desc').limit(1).executeTakeFirst(),
    inBuild.where('id', '>', check.id).orderBy('id', 'asc').limit(1).executeTakeFirst(),
    inBuild.where('id', '>', check.id).where('review', '=', 'pending').orderBy('id', 'asc').limit(1).executeTakeFirst(),
    inBuild
      .where('id', '!=', check.id)
      .where('review', '=', 'pending')
      .orderBy('id', 'asc')
      .limit(1)
      .executeTakeFirst(),
  ]);
  return {
    previous: previous?.id ?? null,
    next: next?.id ?? null,
    nextPending: pendingAfter?.id ?? pendingFirst?.id ?? null,
  };
}

/** The build's first check waiting for review, in posting order; null when none waits. */
export async function firstPendingCheckId(deps: Pick<Deps, 'db'>, buildId: string): Promise<string | null> {
  const row = await deps.db
    .selectFrom('checks')
    .select('id')
    .where('buildId', '=', buildId)
    .where('review', '=', 'pending')
    .orderBy('id')
    .limit(1)
    .executeTakeFirst();
  return row?.id ?? null;
}
