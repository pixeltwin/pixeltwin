import { describe, expect, test } from 'bun:test';
import type * as Zoom from '../../../src/ui/client/zoom';
import { clientModule } from '../../helpers/client';

const { fitView, actualView, zoomAt, panBy, regionView, clampPan, MAX_SCALE } = await clientModule<typeof Zoom>('zoom');

const box = { width: 800, height: 600 };

describe('zoom math', () => {
  test('fit shrinks a big image into the box and centres it both ways', () => {
    expect(fitView({ width: 1600, height: 600 }, box)).toEqual({ scale: 0.5, x: 0, y: 150 });
    expect(fitView({ width: 800, height: 1200 }, box)).toEqual({ scale: 0.5, x: 200, y: 0 });
  });

  test('fit never enlarges a small image', () => {
    expect(fitView({ width: 400, height: 300 }, box)).toEqual({ scale: 1, x: 200, y: 150 });
  });

  test('100% shows real pixels from the top-left corner, centred when the image is narrower', () => {
    expect(actualView({ width: 1600, height: 1200 }, box)).toEqual({ scale: 1, x: 0, y: 0 });
    expect(actualView({ width: 400, height: 1200 }, box)).toEqual({ scale: 1, x: 200, y: 0 });
  });

  test('zooming keeps the point under the pointer still', () => {
    const image = { width: 1600, height: 1200 };
    const start = { scale: 1, x: -400, y: -300 };
    const zoomed = zoomAt(start, 2, { x: 400, y: 300 }, image, box);
    expect(zoomed.scale).toBe(2);
    // Image pixel under (400,300) before: (800,600); after: still (800,600).
    expect((400 - zoomed.x) / zoomed.scale).toBe(800);
    expect((300 - zoomed.y) / zoomed.scale).toBe(600);
  });

  test('zoom stays between the fit scale and the maximum', () => {
    const image = { width: 1600, height: 1200 };
    expect(zoomAt({ scale: 1, x: 0, y: 0 }, 1000, { x: 0, y: 0 }, image, box).scale).toBe(MAX_SCALE);
    expect(zoomAt({ scale: 0.5, x: 0, y: 0 }, 0.01, { x: 0, y: 0 }, image, box).scale).toBe(0.5);
  });

  test('panning cannot drag the image away from the box', () => {
    const image = { width: 1600, height: 1200 };
    expect(panBy({ scale: 1, x: 0, y: 0 }, 500, 500, image, box)).toEqual({ scale: 1, x: 0, y: 0 });
    expect(panBy({ scale: 1, x: 0, y: 0 }, -5000, -5000, image, box)).toEqual({ scale: 1, x: -800, y: -600 });
    // An image smaller than the box stays centred.
    expect(clampPan({ scale: 1, x: 90, y: 90 }, { width: 400, height: 300 }, box)).toEqual({
      scale: 1,
      x: 200,
      y: 150,
    });
  });

  test('a region is shown enlarged and centred, with room around it', () => {
    const image = { width: 1600, height: 1200 };
    const view = regionView({ x: 700, y: 500, width: 100, height: 50 }, image, box, 50);
    // (100 + 2·50) wide fits 800 at 4×, (50 + 2·50) high fits 600 at 4×.
    expect(view.scale).toBe(4);
    expect((400 - view.x) / view.scale).toBe(750);
    expect((300 - view.y) / view.scale).toBe(525);
  });
});
