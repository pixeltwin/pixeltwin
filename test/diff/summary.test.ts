import { describe, expect, test } from 'bun:test';
import { formatPercent, positionOf, type SummaryInput, summarize } from '../../src/diff/summary';

const base: SummaryInput = {
  regions: [{ x: 45, y: 45, width: 10, height: 10, pixels: 100 }],
  regionCount: 1,
  pixels: 100,
  percent: 1,
  width: 100,
  height: 100,
  dimensions: null,
  withinTolerance: false,
  tolerancePercent: 0,
};

describe('positionOf', () => {
  test('maps the region center to a 3×3 grid', () => {
    const at = (x: number, y: number) => positionOf({ x, y, width: 2, height: 2, pixels: 4 }, 90, 90);
    expect(at(0, 0)).toBe('top-left');
    expect(at(44, 0)).toBe('top-center');
    expect(at(88, 0)).toBe('top-right');
    expect(at(0, 44)).toBe('middle-left');
    expect(at(44, 44)).toBe('center');
    expect(at(88, 88)).toBe('bottom-right');
  });
});

describe('formatPercent', () => {
  test('uses two decimals, or <0.01% for tiny non-zero changes', () => {
    expect(formatPercent(1.836, 10)).toBe('1.84%');
    expect(formatPercent(0, 0)).toBe('0.00%');
    expect(formatPercent(0, 1)).toBe('<0.01%');
  });
});

describe('summarize', () => {
  test('describes a single region', () => {
    expect(summarize(base)).toBe('1 changed region; largest 10×10 at (45,45) in center; 1.00% of pixels changed.');
  });

  test('pluralizes and counts truncated regions', () => {
    expect(summarize({ ...base, regionCount: 60 })).toStartWith('60 changed regions;');
  });

  test('reports no changes', () => {
    expect(summarize({ ...base, regions: [], regionCount: 0, pixels: 0, percent: 0 })).toBe('No visible changes.');
  });

  test('appends size change and tolerance notes', () => {
    const text = summarize({
      ...base,
      dimensions: { baseline: { width: 100, height: 100 }, current: { width: 100, height: 120 } },
      withinTolerance: true,
      tolerancePercent: 1.5,
    });
    expect(text).toEndWith('of pixels changed. Size changed from 100×100 to 100×120. Within tolerance of 1.5%.');
  });
});
