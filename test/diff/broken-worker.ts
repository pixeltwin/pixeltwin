// Test double for DiffPool: appends to a fixed temp file on each load, then fails to load.
// pool.test.ts reads the same path.
import { appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BROKEN_WORKER_LOG = join(tmpdir(), 'pixeltwin-broken-worker-loads');

appendFileSync(BROKEN_WORKER_LOG, 'x');
throw new Error('worker failed to load');
