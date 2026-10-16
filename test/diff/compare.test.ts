import { describe, expect, test } from 'bun:test';
import { compareImages } from '../../src/diff/compare';
import type { DiffJob, DiffJobResult } from '../../src/diff/types';
import { BLACK, decodePng, makePng, pixelAt, type Rgba, WHITE } from '../helpers/png';

const job = (current: Uint8Array, baseline: Uint8Array | null, extra: Partial<DiffJob> = {}): DiffJob => ({
  current,
  baseline,
  ignoreRegions: [],
  colorThreshold: 0.1,
  tolerancePercent: 0,
  maxPixels: 40_000_000,
  ...extra,
});

function compared(result: DiffJobResult) {
  if (result.kind !== 'compared') throw new Error(`expected compared, got ${JSON.stringify(result)}`);
  return result;
}

const white = makePng(100, 100);
const withSquare = makePng(100, 100, WHITE, [{ x: 10, y: 10, width: 10, height: 10, color: BLACK }]);

describe('compareImages', () => {
  test('rejects bytes that are not a PNG', () => {
    expect(compareImages(job(new Uint8Array([1, 2, 3]), null)).kind).toBe('invalid_image');
  });

  test('validates a PNG when there is no baseline', () => {
    expect(compareImages(job(white, null))).toEqual({ kind: 'validated', width: 100, height: 100 });
  });

  test('reports a corrupt baseline as an error, not as an invalid upload', () => {
    const result = compareImages(job(white, new Uint8Array([1, 2, 3])));
    expect(result.kind).toBe('error');
  });

  test('finds no change between pixel-identical images', () => {
    const result = compared(compareImages(job(makePng(100, 100), white)));
    expect(result.result).toBe('unchanged');
    expect(result.diff.pixels).toBe(0);
    expect(result.diff.summary).toBe('No visible changes.');
    expect(result.diffPng).toBeNull();
  });

  test('describes a changed square', () => {
    const result = compared(compareImages(job(withSquare, white)));
    expect(result.result).toBe('changed');
    expect(result.diff).toEqual({
      percent: 1,
      pixels: 100,
      colorThreshold: 0.1,
      tolerancePercent: 0,
      dimensions: null,
      regions: [{ x: 10, y: 10, width: 10, height: 10, pixels: 100 }],
      regionsTruncated: false,
      summary: '1 changed region; largest 10×10 at (10,10) in top-left; 1.00% of pixels changed.',
    });
    const diff = decodePng(result.diffPng as Uint8Array);
    expect(pixelAt(diff, 15, 15)).toEqual([255, 0, 0, 255]);
  });

  test('ignores changes inside ignore regions', () => {
    const result = compared(
      compareImages(job(withSquare, white, { ignoreRegions: [{ x: 5, y: 5, width: 20, height: 20 }] })),
    );
    expect(result.result).toBe('unchanged');
    expect(result.diff.pixels).toBe(0);
  });

  test('compare regions limit the comparison to themselves', () => {
    const twoSquares = makePng(100, 100, WHITE, [
      { x: 10, y: 10, width: 10, height: 10, color: BLACK },
      { x: 70, y: 70, width: 10, height: 10, color: BLACK },
    ]);
    const onlyFirst = compared(
      compareImages(job(twoSquares, white, { compareRegions: [{ x: 0, y: 0, width: 50, height: 50 }] })),
    );
    expect(onlyFirst.diff.pixels).toBe(100);
    expect(onlyFirst.diff.regions.map((r) => [r.x, r.y])).toEqual([[10, 10]]);
    const nothing = compareImages(
      job(twoSquares, white, { compareRegions: [{ x: 30, y: 30, width: 20, height: 20 }] }),
    );
    expect(compared(nothing).result).toBe('unchanged');
  });

  test('an ignore region inside a compare region still ignores', () => {
    const result = compareImages(
      job(withSquare, white, {
        compareRegions: [{ x: 0, y: 0, width: 50, height: 50 }],
        ignoreRegions: [{ x: 5, y: 5, width: 20, height: 20 }],
      }),
    );
    expect(compared(result).result).toBe('unchanged');
  });

  test('accepts changes within tolerance but still reports them', () => {
    const result = compared(compareImages(job(withSquare, white, { tolerancePercent: 1.5 })));
    expect(result.result).toBe('unchanged');
    expect(result.diff.pixels).toBe(100);
    expect(result.diff.summary).toEndWith('Within tolerance of 1.5%.');
  });

  test('a single changed pixel on a large image is still a change at tolerance 0', () => {
    const big = makePng(2000, 2000);
    const dot = makePng(2000, 2000, WHITE, [{ x: 1000, y: 1000, width: 1, height: 1, color: BLACK }]);
    const result = compared(compareImages(job(dot, big)));
    expect(result.result).toBe('changed');
    expect(result.diff.percent).toBe(0);
    expect(result.diff.summary).toContain('<0.01% of pixels changed');
  });

  test('counts added area as changed even when both pages are white', () => {
    const result = compared(compareImages(job(makePng(100, 120), white)));
    expect(result.result).toBe('changed');
    expect(result.diff.pixels).toBe(2000);
    expect(result.diff.dimensions).toEqual({
      baseline: { width: 100, height: 100 },
      current: { width: 100, height: 120 },
    });
    expect(result.diff.regions).toEqual([{ x: 0, y: 100, width: 100, height: 20, pixels: 2000 }]);
    expect(result.diff.summary).toEndWith('Size changed from 100×100 to 100×120.');
  });

  test('colorThreshold controls sensitivity to subtle colour shifts', () => {
    const offWhite: Rgba = [250, 250, 250, 255];
    const shifted = makePng(10, 10, offWhite);
    const base = makePng(10, 10);
    expect(compared(compareImages(job(shifted, base))).result).toBe('unchanged');
    expect(compared(compareImages(job(shifted, base, { colorThreshold: 0 }))).result).toBe('changed');
  });

  test('refuses a comparison canvas larger than maxPixels, even when each image is within it', () => {
    const wide = makePng(100, 10);
    const tall = makePng(10, 100);
    expect(compareImages(job(tall, wide, { maxPixels: 5000 }))).toEqual({
      kind: 'error',
      code: 'diff_failed',
      message: 'Images of 100×10 and 10×100 need a 100×100 comparison canvas (10000 pixels); the limit is 5000.',
    });
  });
});
