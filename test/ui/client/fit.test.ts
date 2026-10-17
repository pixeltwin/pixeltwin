import { describe, expect, test } from 'bun:test';
import type * as Fit from '../../../src/ui/client/fit';
import { clientModule } from '../../helpers/client';

const { fitRows, THUMB } = await clientModule<typeof Fit>('fit');

describe('fitting the build page grid to the window', () => {
  test('as many rows as fit with thumbnails at least the minimum, which then fill the height', () => {
    // 1440×900: 640 px under the filters, cards 136 px without the thumbnail.
    const fit = fitRows({ height: 640, gap: 16, body: 136 });
    expect(fit.rows).toBe(2);
    expect(fit.thumb).toBe(Math.floor(656 / 2 - 16 - 136));
    expect(2 * (fit.thumb + 136) + 16).toBeLessThanOrEqual(640);
  });

  test('a short window still gets two rows of smaller thumbnails, a very short one one row', () => {
    expect(fitRows({ height: 468, gap: 16, body: 136 })).toEqual({ rows: 2, thumb: 90 });
    expect(fitRows({ height: 300, gap: 16, body: 136 }).rows).toBe(1);
  });

  test('rows are planned for taller cards than these, so other pages fit too', () => {
    const short = fitRows({ height: 640, gap: 16, body: 60 });
    expect(short.rows).toBe(Math.floor(656 / (THUMB.min + 110 + 16)));
  });

  test('with the rows set, the thumbnail fits this page, within its bounds', () => {
    expect(fitRows({ height: 640, gap: 16, body: 200, rows: 2 }).thumb).toBe(112);
    expect(fitRows({ height: 2000, gap: 16, body: 90, rows: 1 }).thumb).toBe(THUMB.max);
    expect(fitRows({ height: 200, gap: 16, body: 180, rows: 2 }).thumb).toBe(THUMB.floor);
  });
});
