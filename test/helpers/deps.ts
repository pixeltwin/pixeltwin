import type { DatabaseHandle } from '../../src/db/database';
import { compareImages } from '../../src/diff/compare';
import type { DiffJob, DiffJobResult, DiffRunner } from '../../src/diff/types';
import type { Deps } from '../../src/domain/deps';
import { MemoryStorage } from '../../src/storage/memory';
import { createTestDb } from './db';

export interface TestDeps extends Deps {
  storage: MemoryStorage;
  handle: DatabaseHandle;
  /** Jobs passed to runDiff, in order. */
  diffJobs: DiffJob[];
}

/** Test deps: fresh database, in-memory storage, diffs computed inline (no workers). */
export async function createTestDeps(runDiff?: DiffRunner): Promise<TestDeps> {
  const handle = await createTestDb();
  const diffJobs: DiffJob[] = [];
  const compute: DiffRunner = runDiff ?? (async (job): Promise<DiffJobResult> => compareImages(job));
  return {
    handle,
    db: handle.db,
    storage: new MemoryStorage(),
    limits: { maxImageBytes: 10 * 1024 * 1024, maxImagePixels: 40_000_000 },
    diffJobs,
    runDiff: (job) => {
      diffJobs.push(job);
      return compute(job);
    },
  };
}
