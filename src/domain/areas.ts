import type { SnapshotArea } from '../db/schema';
import { AppError } from '../errors';
import { newId } from '../ids';
import { type CheckView, getCheck, recomputeCheck } from './checks';
import type { Deps } from './deps';
import { areaInputSchema, parseInput } from './schemas';

// Plan 6: ignore and compare areas drawn on a snapshot. They are addressed through a check —
// the one on screen — and apply to every check of its snapshot, on every branch. Changing them
// compares that check again at once; other checks pick them up when they are next compared.

/** More than this many areas on one snapshot is a mistake, not a configuration. */
export const MAX_AREAS_PER_SNAPSHOT = 50;

export type Area = SnapshotArea;

/** The areas of the check's snapshot, oldest first. */
export async function listAreas(deps: Pick<Deps, 'db'>, checkId: string): Promise<Area[]> {
  const check = await getCheck(deps, checkId);
  return deps.db
    .selectFrom('snapshotAreas')
    .selectAll()
    .where('projectId', '=', check.projectId)
    .where('snapshotKey', '=', check.snapshotKey)
    .orderBy('id')
    .execute();
}

export async function createArea(
  deps: Deps,
  checkId: string,
  actor: string,
  input: unknown,
): Promise<{ area: Area; check: CheckView }> {
  const rect = parseInput(areaInputSchema, input);
  const check = await getCheck(deps, checkId);
  const existing = await listAreas(deps, checkId);
  if (existing.length >= MAX_AREAS_PER_SNAPSHOT) {
    throw new AppError(
      'too_many_areas',
      422,
      `Snapshot ${check.name} already has ${MAX_AREAS_PER_SNAPSHOT} areas; delete one first.`,
    );
  }
  const area: Area = {
    id: newId('are'),
    projectId: check.projectId,
    snapshotKey: check.snapshotKey,
    kind: rect.kind,
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
    createdBy: actor,
    createdAt: Date.now(),
  };
  await deps.db.insertInto('snapshotAreas').values(area).execute();
  return { area, check: await recomputeCheck(deps, checkId) };
}

/** Deletes one area of the check's snapshot and compares the check again. */
export async function deleteArea(deps: Deps, checkId: string, areaId: string): Promise<CheckView> {
  const check = await getCheck(deps, checkId);
  const deleted = await deps.db
    .deleteFrom('snapshotAreas')
    .where('id', '=', areaId)
    .where('projectId', '=', check.projectId)
    .where('snapshotKey', '=', check.snapshotKey)
    .executeTakeFirst();
  if (Number(deleted.numDeletedRows) === 0) {
    throw new AppError('area_not_found', 404, `Area ${areaId} not found on snapshot ${check.name}.`);
  }
  return recomputeCheck(deps, checkId);
}
