import { describe, expect, test } from 'bun:test';
import { downscale, isTall, makeThumb, tallView, thumbEdge, thumbSize, topCrop } from '../../src/diff/thumb';
import { decodePng, makePng, pixelAt, WHITE } from '../helpers/png';

describe('thumbnails', () => {
  test('the asked edge rounds up to a size thumbnails are made at', () => {
    expect(thumbEdge(undefined)).toBe(960);
    expect(thumbEdge(100)).toBe(320);
    expect(thumbEdge(320)).toBe(320);
    expect(thumbEdge(321)).toBe(640);
    expect(thumbEdge(641)).toBe(960);
    expect(thumbEdge(5000)).toBe(960);
    expect(thumbEdge(Number.NaN)).toBe(960);
  });

  test('a full page is over 2.5 times as tall as wide; a phone screen is not', () => {
    expect(isTall({ width: 1280, height: 6000 })).toBe(true);
    expect(isTall({ width: 390, height: 844 })).toBe(false);
    expect(isTall({ width: 1280, height: 800 })).toBe(false);
    expect(topCrop({ width: 1280, height: 6000 })).toEqual({ x: 0, y: 0, width: 1280, height: 800 });
    expect(topCrop({ width: 1280, height: 500 })).toEqual({ x: 0, y: 0, width: 1280, height: 500 });
  });

  test('a full page shows its top, or the band around its topmost change when that lies lower', () => {
    const size = { width: 1280, height: 6000 };
    const top = { x: 0, y: 0, width: 1280, height: 800 };
    expect(tallView(size, [])).toEqual({ crop: top, top: true });
    expect(tallView(size, [{ x: 10, y: 700, width: 50, height: 90 }])).toEqual({ crop: top, top: true });
    // The topmost change, not the first listed, centred in the band.
    const regions = [
      { x: 0, y: 5000, width: 10, height: 10 },
      { x: 0, y: 3000, width: 100, height: 200 },
    ];
    expect(tallView(size, regions)).toEqual({ crop: { ...top, y: 2700 }, top: false });
    // Near the bottom: the band ends with the page.
    expect(tallView(size, [{ x: 0, y: 5900, width: 10, height: 60 }]).crop.y).toBe(5200);
    // Taller than the band: its start, with a little room above.
    expect(tallView(size, [{ x: 0, y: 2000, width: 10, height: 2000 }]).crop.y).toBe(1984);
  });

  test('the longer side fits the edge, the aspect ratio stays, and nothing is scaled up', () => {
    expect(thumbSize({ width: 1280, height: 3200 }, 640)).toEqual({ width: 256, height: 640 });
    expect(thumbSize({ width: 1280, height: 720 }, 640)).toEqual({ width: 640, height: 360 });
    expect(thumbSize({ width: 300, height: 200 }, 640)).toEqual({ width: 300, height: 200 });
    expect(thumbSize({ width: 10_000, height: 1 }, 320)).toEqual({ width: 320, height: 1 });
  });

  test('averages the pixels each output pixel covers', () => {
    // 4×2: a black and a white column pair → 2×1 of grey-ish halves.
    const data = new Uint8Array(4 * 2 * 4);
    for (let y = 0; y < 2; y++) {
      for (let x = 0; x < 4; x++) {
        const v = x === 0 ? 0 : x === 1 ? 100 : 255;
        data.set([v, v, v, 255], (y * 4 + x) * 4);
      }
    }
    const out = downscale(data, { width: 4, height: 2 }, { width: 2, height: 1 }, 'plain');
    expect([...out]).toEqual([50, 50, 50, 255, 255, 255, 255, 255]);
  });

  test('diff mode keeps a single changed pixel red; plain mode averages it away', () => {
    const data = new Uint8Array(8 * 8 * 4);
    for (let i = 0; i < 64; i++) data.set([240, 240, 240, 255], i * 4);
    data.set([255, 0, 0, 255], (3 * 8 + 5) * 4);
    const size = { width: 8, height: 8 };
    const out = { width: 1, height: 1 };
    expect([...downscale(data, size, out, 'diff')]).toEqual([255, 0, 0, 255]);
    const plain = downscale(data, size, out, 'plain');
    expect((plain[0] as number) - (plain[1] as number)).toBeLessThan(24);
  });

  test('makes an opaque RGB PNG of the thumbnail size', () => {
    const png = makePng(1000, 2000, WHITE, [{ x: 0, y: 0, width: 1000, height: 1000, color: [0, 0, 0, 255] }]);
    const result = makeThumb({ thumb: true, png, edge: 320, mode: 'plain' });
    if (result.kind !== 'thumb') throw new Error(result.message);
    expect([result.width, result.height]).toEqual([160, 320]);
    const decoded = decodePng(result.png);
    expect([decoded.width, decoded.height]).toEqual([160, 320]);
    expect(pixelAt(decoded, 10, 10)).toEqual([0, 0, 0, 255]);
    expect(pixelAt(decoded, 10, 300)).toEqual([255, 255, 255, 255]);
    expect(result.png.byteLength).toBeLessThan(png.byteLength);
  });
});
