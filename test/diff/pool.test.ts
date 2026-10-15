import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DiffPool } from '../../src/diff/pool';
import type { DiffJob } from '../../src/diff/types';
import { BLACK, makePng, WHITE } from '../helpers/png';

const job = (current: Uint8Array, baseline: Uint8Array | null, colorThreshold = 0.1): DiffJob => ({
  current,
  baseline,
  ignoreRegions: [],
  colorThreshold,
  tolerancePercent: 0,
  maxPixels: 40_000_000,
});

const misbehaving = new URL('./misbehaving-worker.ts', import.meta.url).href;
const broken = new URL('./broken-worker.ts', import.meta.url).href;
const BROKEN_WORKER_LOG = join(tmpdir(), 'pixeltwin-broken-worker-loads');

describe('DiffPool', () => {
  let pool: DiffPool | undefined;

  afterEach(async () => {
    await pool?.close();
    pool = undefined;
  });

  test('runs compare jobs on the real worker', async () => {
    pool = new DiffPool({ size: 2, timeoutMs: 10_000 });
    const square = makePng(50, 50, WHITE, [{ x: 0, y: 0, width: 5, height: 5, color: BLACK }]);
    const results = await Promise.all([
      pool.run(job(square, makePng(50, 50))),
      pool.run(job(makePng(50, 50), null)),
      pool.run(job(new Uint8Array([1]), null)),
    ]);
    expect(results.map((r) => r.kind)).toEqual(['compared', 'validated', 'invalid_image']);
    const first = results[0];
    if (first?.kind !== 'compared') throw new Error('expected compared');
    expect(first.diff.pixels).toBe(25);
    expect(first.diffPng).toBeInstanceOf(Uint8Array);
  });

  test('times out a hung job and keeps serving', async () => {
    pool = new DiffPool({ size: 1, timeoutMs: 300, workerSpecifier: misbehaving });
    expect(await pool.run(job(new Uint8Array(), null, 0.5))).toEqual({
      kind: 'error',
      code: 'diff_timeout',
      message: 'Diff took longer than 300 ms.',
    });
    expect((await pool.run(job(new Uint8Array(), null))).kind).toBe('validated');
  });

  test('survives a crashing worker', async () => {
    pool = new DiffPool({ size: 1, timeoutMs: 5_000, workerSpecifier: misbehaving });
    expect(await pool.run(job(new Uint8Array(), null, 0.9))).toEqual({
      kind: 'error',
      code: 'diff_failed',
      message: 'Diff worker crashed.',
    });
    expect((await pool.run(job(new Uint8Array(), null))).kind).toBe('validated');
  });

  test('resolves queued and future jobs with an error after close', async () => {
    pool = new DiffPool({ size: 1, timeoutMs: 5_000, workerSpecifier: misbehaving });
    const hung = pool.run(job(new Uint8Array(), null, 0.5));
    const queued = pool.run(job(new Uint8Array(), null));
    await pool.close();
    expect((await hung).kind).toBe('error');
    expect((await queued).kind).toBe('error');
    expect((await pool.run(job(new Uint8Array(), null))).kind).toBe('error');
  });

  test('a worker that fails to load is not respawned in a loop', async () => {
    rmSync(BROKEN_WORKER_LOG, { force: true });
    try {
      pool = new DiffPool({ size: 1, timeoutMs: 5_000, workerSpecifier: broken });
      expect(await pool.run(job(new Uint8Array(), null))).toEqual({
        kind: 'error',
        code: 'diff_failed',
        message: 'Diff worker crashed.',
      });
      await Bun.sleep(300);
      expect(readFileSync(BROKEN_WORKER_LOG, 'utf8').length).toBeLessThanOrEqual(2);
    } finally {
      rmSync(BROKEN_WORKER_LOG, { force: true });
    }
  });
});
