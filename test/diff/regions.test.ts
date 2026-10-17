import { describe, expect, test } from 'bun:test';
import { extractRegions } from '../../src/diff/regions';

function mask(width: number, height: number, points: Array<[number, number]>): Uint8Array {
  const m = new Uint8Array(width * height);
  for (const [x, y] of points) m[y * width + x] = 1;
  return m;
}

function block(x0: number, y0: number, w: number, h: number): Array<[number, number]> {
  const points: Array<[number, number]> = [];
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) points.push([x, y]);
  return points;
}

describe('extractRegions', () => {
  test('returns nothing for an empty mask', () => {
    expect(extractRegions(new Uint8Array(100 * 100), 100, 100)).toMatchObject({
      regions: [],
      total: 0,
      truncated: false,
    });
  });

  test('reports a tight box around a block', () => {
    const result = extractRegions(mask(100, 100, block(20, 30, 10, 10)), 100, 100);
    expect(result.regions).toEqual([{ x: 20, y: 30, width: 10, height: 10, pixels: 100 }]);
  });

  test('keeps distant blocks apart and sorts by size', () => {
    const points = [...block(0, 0, 2, 2), ...block(60, 60, 5, 5)];
    const result = extractRegions(mask(100, 100, points), 100, 100);
    expect(result.regions).toEqual([
      { x: 60, y: 60, width: 5, height: 5, pixels: 25 },
      { x: 0, y: 0, width: 2, height: 2, pixels: 4 },
    ]);
  });

  test('merges specks in neighbouring cells, including diagonals', () => {
    expect(
      extractRegions(
        mask(32, 32, [
          [5, 5],
          [9, 5],
        ]),
        32,
        32,
      ).regions,
    ).toEqual([{ x: 5, y: 5, width: 5, height: 1, pixels: 2 }]);
    expect(
      extractRegions(
        mask(32, 32, [
          [7, 7],
          [8, 8],
        ]),
        32,
        32,
      ).regions,
    ).toEqual([{ x: 7, y: 7, width: 2, height: 2, pixels: 2 }]);
  });

  test('handles partial cells at the image edge', () => {
    expect(extractRegions(mask(10, 10, [[9, 9]]), 10, 10).regions).toEqual([
      { x: 9, y: 9, width: 1, height: 1, pixels: 1 },
    ]);
  });

  test('truncates to maxRegions but reports the total', () => {
    const result = extractRegions(
      mask(100, 100, [
        [0, 0],
        [50, 0],
        [0, 50],
      ]),
      100,
      100,
      8,
      2,
    );
    expect(result.regions).toHaveLength(2);
    expect(result.total).toBe(3);
    expect(result.truncated).toBe(true);
  });
});
