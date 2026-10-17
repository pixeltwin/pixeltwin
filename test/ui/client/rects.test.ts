import { describe, expect, test } from 'bun:test';
import type * as Rects from '../../../src/ui/client/rects';
import { clientModule } from '../../helpers/client';

const { copyPlace, dragged, same, COPY_GAP, COPY_NUDGE, MIN_SIZE } = await clientModule<typeof Rects>('rects');

const image = { width: 480, height: 300 };
const date = { x: 100, y: 40, width: 120, height: 20 };

describe('copyPlace', () => {
  test('a duplicate goes just below its original, the same size', () => {
    expect(copyPlace(date, image)).toEqual({ x: 100, y: 40 + 20 + COPY_GAP, width: 120, height: 20 });
  });

  test('at the bottom of the image it goes right of the original instead', () => {
    const low = { ...date, y: 270 };
    expect(copyPlace(low, image)).toEqual({ x: 100 + 120 + COPY_GAP, y: 270, width: 120, height: 20 });
  });

  test('with no room below or right it overlaps the original, shifted by 16 px inside the image', () => {
    const corner = { x: 300, y: 270, width: 170, height: 20 };
    expect(copyPlace(corner, image)).toEqual({ x: 310, y: 280, width: 170, height: 20 });
    const middle = { x: 200, y: 200, width: 200, height: 90 };
    expect(copyPlace(middle, image)).toEqual({ x: 200 + COPY_NUDGE, y: 210, width: 200, height: 90 });
  });

  test('an area the size of the image still gets a copy inside it', () => {
    const whole = { x: 0, y: 0, ...image };
    expect(copyPlace(whole, image)).toEqual(whole);
  });

  test('in the bottom-right corner the shift goes up and left', () => {
    const corner = { x: 380, y: 200, width: 100, height: 100 };
    expect(copyPlace(corner, image)).toEqual({ x: 380 - COPY_NUDGE, y: 200 - COPY_NUDGE, width: 100, height: 100 });
  });

  test('a step repeats the last duplicate move while it fits', () => {
    expect(copyPlace(date, image, { dx: 0, dy: 64 })).toEqual({ ...date, y: 104 });
    expect(copyPlace(date, image, { dx: 150, dy: 10 })).toEqual({ ...date, x: 250, y: 50 });
  });

  test('a step that would leave the image, or no step at all, falls back to below', () => {
    expect(copyPlace(date, image, { dx: 0, dy: 400 })).toEqual({ ...date, y: 68 });
    expect(copyPlace(date, image, { dx: 0, dy: 0 })).toEqual({ ...date, y: 68 });
  });
});

describe('dragged', () => {
  test('a move keeps the size and stays inside the image', () => {
    expect(dragged(date, 'move', 1, -1, 480, 300)).toEqual({ ...date, x: 101, y: 39 });
    expect(dragged(date, 'move', 1000, 1000, 480, 300)).toEqual({ ...date, x: 360, y: 280 });
    expect(dragged(date, 'move', -1000, -1000, 480, 300)).toEqual({ ...date, x: 0, y: 0 });
  });

  test('a resize never shrinks below the minimum size', () => {
    expect(dragged(date, 'e', -500, 0, 480, 300).width).toBe(MIN_SIZE);
    expect(dragged(date, 'se', 10, 10, 480, 300)).toEqual({ x: 100, y: 40, width: 130, height: 30 });
  });

  test('same compares every side', () => {
    expect(same(date, { ...date })).toBe(true);
    expect(same(date, { ...date, height: 21 })).toBe(false);
  });
});
