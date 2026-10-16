import type { Db } from '../db/database';
import type { DiffRunner } from '../diff/types';
import type { Storage } from '../storage/storage';

export interface ImageLimits {
  maxImageBytes: number;
  maxImagePixels: number;
}

/** Everything domain functions need. Built once in main.ts; built per test in test/helpers. */
export interface Deps {
  db: Db;
  storage: Storage;
  runDiff: DiffRunner;
  limits: ImageLimits;
  /** Diff jobs waiting for a worker; the upload route refuses new work while it is too long. */
  diffBacklog?: () => number;
}
