import { createHash } from 'node:crypto';
import type { Db } from '../db/database';
import type { SnapshotElement } from '../diff/types';

/**
 * Stores a screenshot's elements once per content hash and returns the hash. Storing a set again
 * refreshes its age, so element GC (which spares young sets) cannot take it while a check that is
 * about to point at it is still being written. Null for no elements.
 */
export async function storeElements(db: Db, elements: SnapshotElement[] | undefined): Promise<string | null> {
  if (!elements) return null;
  const data = JSON.stringify(elements);
  const sha = createHash('sha256').update(data).digest('hex');
  const now = Date.now();
  await db
    .insertInto('elementSets')
    .values({ sha, data, count: elements.length, createdAt: now })
    .onConflict((oc) => oc.column('sha').doUpdateSet({ createdAt: now }))
    .execute();
  return sha;
}

/** The elements stored under `sha`; null when there is no sha or the set is gone. */
export async function loadElements(db: Db, sha: string | null): Promise<SnapshotElement[] | null> {
  if (!sha) return null;
  const row = await db.selectFrom('elementSets').select('data').where('sha', '=', sha).executeTakeFirst();
  return row ? (JSON.parse(row.data) as SnapshotElement[]) : null;
}

/** The elements of both sides of a comparison, when both have them (the diff then lists element changes). */
export async function comparedElements(
  db: Db,
  baselineSha: string | null,
  currentSha: string | null,
): Promise<{ baseline: SnapshotElement[]; current: SnapshotElement[] } | null> {
  if (!baselineSha || !currentSha) return null;
  const [baseline, current] = await Promise.all([loadElements(db, baselineSha), loadElements(db, currentSha)]);
  return baseline && current ? { baseline, current } : null;
}
