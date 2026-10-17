import { describe, expect, test } from 'bun:test';
import { PNG } from 'pngjs';
import { crop, decodePng, encodePng, shrink } from '../../packages/client/src/png-image';
import { makePng, WHITE } from '../helpers/png';

const RED = [255, 0, 0, 255] as [number, number, number, number];

describe('the MCP server PNG helpers', () => {
  test('decode what pngjs writes, crop, and encode a PNG pngjs reads back', () => {
    const png = makePng(40, 30, WHITE, [{ x: 10, y: 5, width: 4, height: 3, color: RED }]);
    const image = decodePng(png);
    expect([image?.width, image?.height]).toEqual([40, 30]);
    const part = image && crop(image, { x: 8, y: 4, width: 10, height: 10 });
    expect([part?.width, part?.height]).toEqual([10, 10]);
    const back = PNG.sync.read(Buffer.from(encodePng(part ?? { width: 0, height: 0, data: new Uint8Array() })));
    expect([back.width, back.height]).toEqual([10, 10]);
    // (10, 5) in the image is (2, 1) in the crop: red.
    expect([...back.data.subarray((1 * 10 + 2) * 4, (1 * 10 + 2) * 4 + 4)]).toEqual(RED);
    expect(image && crop(image, { x: 100, y: 0, width: 5, height: 5 })).toBeNull();
  });

  test('RGB without alpha (as browsers write) and shrinking by a whole factor', () => {
    const rgb = new PNG({ width: 4, height: 2, colorType: 2, inputHasAlpha: false });
    rgb.data = Buffer.from(Array.from({ length: 4 * 2 * 3 }, (_, i) => (i % 3 === 0 ? 200 : 0)));
    const image = decodePng(new Uint8Array(PNG.sync.write(rgb, { colorType: 2, inputHasAlpha: false })));
    expect(image?.data.subarray(0, 4)).toEqual(new Uint8Array([200, 0, 0, 255]));
    const half = image && shrink(image, 2);
    expect([half?.width, half?.height]).toEqual([2, 1]);
  });

  test('what it cannot read is null', () => {
    expect(decodePng(new Uint8Array([1, 2, 3]))).toBeNull();
  });
});
