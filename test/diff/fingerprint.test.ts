import { describe, expect, test } from 'bun:test';
import { compareImages } from '../../src/diff/compare';
import { changeKeyOf } from '../../src/diff/fingerprint';
import type { DiffJob, DiffJobResult } from '../../src/diff/types';
import { BLACK, type FilledRect, makePng, type Rgba, WHITE } from '../helpers/png';

const job = (current: Uint8Array, baseline: Uint8Array): DiffJob => ({
  current,
  baseline,
  ignoreRegions: [],
  colorThreshold: 0.1,
  tolerancePercent: 0,
  maxPixels: 40_000_000,
});

function compared(result: DiffJobResult) {
  if (result.kind !== 'compared') throw new Error(`expected compared, got ${JSON.stringify(result)}`);
  return result;
}

const RED: Rgba = [229, 72, 77, 255];
const GREY: Rgba = [120, 120, 120, 255];

/** A page: its own content (`body`) and a header bar whose logo is `logo` wide, at `top`. */
function page(body: FilledRect[], logo: number, top = 0, size: [number, number] = [200, 160]) {
  return makePng(size[0], size[1], WHITE, [
    { x: 0, y: top, width: 200, height: 20, color: GREY },
    { x: 10, y: top + 4, width: logo, height: 12, color: BLACK },
    ...body,
  ]);
}

const home = [{ x: 20, y: 60, width: 80, height: 40, color: RED }];
const cart = [{ x: 120, y: 90, width: 50, height: 50, color: BLACK }];

describe('change fingerprints', () => {
  test('the same change on different screens has the same fingerprint and change key', () => {
    const a = compared(compareImages(job(page(home, 60), page(home, 40))));
    const b = compared(compareImages(job(page(cart, 60), page(cart, 40))));
    expect(a.result).toBe('changed');
    expect(a.diff.regions).toHaveLength(1);
    expect(a.diff.regions[0]?.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(b.diff.regions[0]?.fingerprint).toBe(a.diff.regions[0]?.fingerprint as string);
    expect(a.changeKey).toMatch(/^[0-9a-f]{16}$/);
    expect(b.changeKey).toBe(a.changeKey as string);
  });

  test('where the change is on the screen does not matter', () => {
    const top = compared(compareImages(job(page(home, 60), page(home, 40))));
    const lower = compared(compareImages(job(page(home, 60, 120), page(home, 40, 120))));
    expect(lower.diff.regions[0]?.y).not.toBe(top.diff.regions[0]?.y as number);
    expect(lower.changeKey).toBe(top.changeKey as string);
  });

  test('another change, or the same pixels changed to another colour, has another fingerprint', () => {
    const logo = compared(compareImages(job(page(home, 60), page(home, 40))));
    const longer = compared(compareImages(job(page(home, 70), page(home, 40))));
    const tinted = compared(
      compareImages(
        job(
          makePng(200, 160, WHITE, [
            { x: 0, y: 0, width: 200, height: 20, color: GREY },
            { x: 10, y: 4, width: 40, height: 12, color: BLACK },
            { x: 50, y: 4, width: 20, height: 12, color: RED },
            ...home,
          ]),
          page(home, 40),
        ),
      ),
    );
    expect(longer.changeKey).not.toBe(logo.changeKey as string);
    expect(tinted.diff.regions[0]?.width).toBe(logo.diff.regions[0]?.width as number);
    expect(tinted.changeKey).not.toBe(logo.changeKey as string);
  });

  test('unchanged pixels inside the change are left out: the page around a change may differ', () => {
    // A frame drawn around each page's own content: the frame is the change, the inside is the page.
    const framed = (inside: FilledRect, frame: boolean) =>
      makePng(200, 160, WHITE, [
        ...(frame
          ? [
              { x: 40, y: 40, width: 100, height: 4, color: BLACK },
              { x: 40, y: 96, width: 100, height: 4, color: BLACK },
              { x: 40, y: 40, width: 4, height: 60, color: BLACK },
              { x: 136, y: 40, width: 4, height: 60, color: BLACK },
            ]
          : []),
        inside,
      ]);
    const one = { x: 60, y: 60, width: 30, height: 20, color: RED };
    const two = { x: 80, y: 55, width: 40, height: 30, color: GREY };
    const a = compared(compareImages(job(framed(one, true), framed(one, false))));
    const b = compared(compareImages(job(framed(two, true), framed(two, false))));
    expect(a.diff.regions).toHaveLength(1);
    expect(b.changeKey).toBe(a.changeKey as string);
  });

  test('a screen with one more change has another change key: groups are exact', () => {
    const header = compared(compareImages(job(page(home, 60), page(home, 40))));
    const more = compared(
      compareImages(job(page([...home, { x: 150, y: 130, width: 20, height: 20, color: BLACK }], 60), page(home, 40))),
    );
    expect(more.diff.regions).toHaveLength(2);
    expect(more.diff.regions.map((r) => r.fingerprint)).toContain(header.diff.regions[0]?.fingerprint);
    expect(more.changeKey).not.toBe(header.changeKey as string);
  });

  test('no change key without a change, after a resize, or when regions were truncated', () => {
    const same = compared(compareImages(job(page(home, 40), page(home, 40))));
    expect(same.changeKey).toBeNull();
    const resized = compared(compareImages(job(page(home, 60, 0, [200, 180]), page(home, 40))));
    expect(resized.result).toBe('changed');
    expect(resized.changeKey).toBeNull();
    expect(resized.diff.regions.every((r) => r.fingerprint === undefined)).toBe(true);
    // 60 dots far apart: more regions than are kept.
    const dots = Array.from({ length: 60 }, (_, i) => ({
      x: (i % 10) * 20,
      y: 40 + Math.floor(i / 10) * 20,
      width: 2,
      height: 2,
      color: BLACK,
    }));
    const many = compared(compareImages(job(makePng(200, 160, WHITE, dots), makePng(200, 160))));
    expect(many.diff.regionsTruncated).toBe(true);
    expect(many.changeKey).toBeNull();
  });

  test('the change key is the set of fingerprints, whatever their order', () => {
    expect(changeKeyOf(['b', 'a', 'a'])).toBe(changeKeyOf(['a', 'b', 'a']));
    expect(changeKeyOf(['a', 'b'])).not.toBe(changeKeyOf(['a', 'b', 'b']));
  });
});
