import { describe, expect, test } from 'bun:test';
import type * as Changes from '../../../src/ui/client/changes';
import { clientModule } from '../../helpers/client';

const { changeMask, MASK_COLOR } = await clientModule<typeof Changes>('changes');

/** A width×height diff image: grey everywhere, pure red at `red`. */
function diffImage(width: number, height: number, red: Array<[number, number]>): Uint8ClampedArray {
  const px = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) px.set([200, 200, 200, 255], i * 4);
  for (const [x, y] of red) px.set([255, 0, 0, 255], (y * width + x) * 4);
  return px;
}

const alpha = (mask: Uint8ClampedArray, width: number, x: number, y: number) => mask[(y * width + x) * 4 + 3];

describe('changeMask', () => {
  test('paints changed (pure red) pixels and their neighbours, everything else stays transparent', () => {
    const mask = changeMask(diffImage(7, 7, [[3, 3]]), 7, 7);
    for (let y = 2; y <= 4; y++) for (let x = 2; x <= 4; x++) expect(alpha(mask, 7, x, y)).toBe(MASK_COLOR[3]);
    expect([...mask.subarray((3 * 7 + 3) * 4, (3 * 7 + 3) * 4 + 3)]).toEqual(MASK_COLOR.slice(0, 3));
    for (const [x, y] of [
      [1, 3],
      [5, 3],
      [3, 1],
      [3, 5],
      [0, 0],
    ] as const) {
      expect(alpha(mask, 7, x, y)).toBe(0);
    }
  });

  test('stays inside the image at the edges, and an unchanged diff gives an empty mask', () => {
    const corner = changeMask(diffImage(3, 3, [[0, 0]]), 3, 3);
    expect(alpha(corner, 3, 1, 1)).toBe(MASK_COLOR[3]);
    expect(alpha(corner, 3, 2, 2)).toBe(0);
    const empty = changeMask(diffImage(4, 4, []), 4, 4);
    expect(empty.every((v) => v === 0)).toBe(true);
  });
});
