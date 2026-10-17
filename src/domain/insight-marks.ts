import type { Db } from '../db/database';
import { newId } from '../ids';

// Marks the days whose insights a change made out of date (see migration 0017). Called inside the
// transaction that made the change, so the mark commits with it; an append-only insert, so two
// reviews never wait on each other's mark. The next refresh (insights.ts) recomputes those days.

export const DAY_MS = 24 * 60 * 60 * 1000;

/** Days since the epoch (UTC) of a time in epoch milliseconds. */
export function dayOf(at: number): number {
  return Math.floor(at / DAY_MS);
}

/** Keys per query, well below the parameter limits of SQLite and Postgres. */
const KEYS_PER_QUERY = 400;

/** Marks the days of these builds (their creation day, on their branch). */
export async function markBuilds(db: Db, buildIds: Iterable<string>): Promise<void> {
  const ids = [...new Set(buildIds)];
  const days = new Map<string, { projectId: string; branch: string; day: number }>();
  for (let at = 0; at < ids.length; at += KEYS_PER_QUERY) {
    const rows = await db
      .selectFrom('builds')
      .select(['projectId', 'branch', 'createdAt'])
      .where('id', 'in', ids.slice(at, at + KEYS_PER_QUERY))
      .execute();
    for (const row of rows) {
      const day = dayOf(Number(row.createdAt));
      days.set(`${row.projectId}\0${row.branch}\0${day}`, { projectId: row.projectId, branch: row.branch, day });
    }
  }
  if (days.size === 0) return;
  const now = Date.now();
  await db
    .insertInto('insightMarks')
    .values([...days.values()].map((d) => ({ id: newId('imk'), ...d, createdAt: now })))
    .execute();
}

/** Marks the days of the builds these checks are in. */
export async function markChecks(db: Db, checkIds: Iterable<string>): Promise<void> {
  const ids = [...new Set(checkIds)];
  const builds: string[] = [];
  for (let at = 0; at < ids.length; at += KEYS_PER_QUERY) {
    const rows = await db
      .selectFrom('checks')
      .select('buildId')
      .distinct()
      .where('id', 'in', ids.slice(at, at + KEYS_PER_QUERY))
      .execute();
    builds.push(...rows.map((r) => r.buildId));
  }
  await markBuilds(db, builds);
}
