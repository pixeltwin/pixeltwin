import { describe, expect, test } from 'bun:test';
import { compareImages } from '../../src/diff/compare';
import { describeChanges, elementChanges, matchElements } from '../../src/diff/elements';
import { extractRegions } from '../../src/diff/regions';
import type { Rect, SnapshotElement } from '../../src/diff/types';
import { makePng, WHITE } from '../helpers/png';

const W = 200;
const H = 120;

/** A mask of W×H with the given rectangles changed, and its regions. */
function changedAt(...rects: Rect[]) {
  const mask = new Uint8Array(W * H);
  for (const r of rects) {
    for (let y = r.y; y < r.y + r.height; y++) mask.fill(1, y * W + r.x, y * W + r.x + r.width);
  }
  return extractRegions(mask, W, H);
}

const el = (key: string, rect: Rect, extra: Partial<SnapshotElement> = {}): SnapshotElement => ({
  key,
  tag: 'div',
  ...rect,
  ...extra,
});

describe('matchElements', () => {
  test('pairs by key, then by path when the key changed with the text, then by text', () => {
    const before = [
      el('[data-testid=submit]', { x: 0, y: 0, width: 10, height: 10 }),
      el('role=heading[name="Sign in"]', { x: 0, y: 20, width: 50, height: 10 }, { tag: 'h1', path: 'main > h1' }),
      el('main > p:nth-of-type(2)', { x: 0, y: 40, width: 50, height: 10 }, { tag: 'p', text: 'Free shipping' }),
      el('#gone', { x: 0, y: 60, width: 5, height: 5 }),
    ];
    const after = [
      el('[data-testid=submit]', { x: 0, y: 4, width: 10, height: 10 }),
      el('role=heading[name="Log in"]', { x: 0, y: 20, width: 50, height: 10 }, { tag: 'h1', path: 'main > h1' }),
      el('main > p:nth-of-type(3)', { x: 0, y: 50, width: 50, height: 10 }, { tag: 'p', text: 'Free shipping' }),
      el('#new', { x: 0, y: 70, width: 5, height: 5 }),
    ];
    const { pairs, removed, added } = matchElements(before, after);
    expect(pairs.map(([a, b]) => [a.key, b.key])).toEqual([
      ['[data-testid=submit]', '[data-testid=submit]'],
      ['role=heading[name="Sign in"]', 'role=heading[name="Log in"]'],
      ['main > p:nth-of-type(2)', 'main > p:nth-of-type(3)'],
    ]);
    expect(removed.map((e) => e.key)).toEqual(['#gone']);
    expect(added.map((e) => e.key)).toEqual(['#new']);
  });

  test('a key that is not unique on one side is not paired by it', () => {
    const before = [el('a', { x: 0, y: 0, width: 1, height: 1 }), el('a', { x: 5, y: 0, width: 1, height: 1 })];
    const after = [el('a', { x: 0, y: 0, width: 1, height: 1 })];
    const { pairs } = matchElements(before, after);
    expect(pairs).toEqual([]);
  });
});

describe('elementChanges', () => {
  test('moved, text, style, added and removed, only where pixels changed, most important first', () => {
    const before = [
      el('[data-testid=submit]', { x: 10, y: 10, width: 40, height: 20 }, { tag: 'button', role: 'button' }),
      el(
        'role=heading[name="Sign in"]',
        { x: 10, y: 40, width: 80, height: 16 },
        {
          tag: 'h1',
          role: 'heading',
          name: 'Sign in',
          text: 'Sign in',
          path: 'h1',
        },
      ),
      el('#cta', { x: 100, y: 10, width: 40, height: 20 }, { tag: 'a', style: { background: '#0070f3' } }),
      el('#still', { x: 150, y: 80, width: 20, height: 20 }, { text: 'same' }),
      el('#gone', { x: 100, y: 80, width: 20, height: 20 }),
    ];
    const after = [
      el('[data-testid=submit]', { x: 10, y: 14, width: 40, height: 20 }, { tag: 'button', role: 'button' }),
      el(
        'role=heading[name="Log in"]',
        { x: 10, y: 40, width: 80, height: 16 },
        {
          tag: 'h1',
          role: 'heading',
          name: 'Log in',
          text: 'Log in',
          path: 'h1',
        },
      ),
      el('#cta', { x: 100, y: 10, width: 40, height: 20 }, { tag: 'a', style: { background: '#d1242f' } }),
      // Moved, but on pixels that did not change (e.g. under an ignore area): not a change.
      el('#still', { x: 150, y: 90, width: 20, height: 20 }, { text: 'same' }),
      el('#new', { x: 10, y: 80, width: 20, height: 20 }),
    ];
    const regions = changedAt(
      { x: 10, y: 10, width: 40, height: 24 },
      { x: 10, y: 40, width: 60, height: 16 },
      { x: 100, y: 10, width: 40, height: 20 },
      { x: 100, y: 80, width: 20, height: 20 },
      { x: 10, y: 80, width: 20, height: 20 },
    );
    const { changes, truncated, explained } = elementChanges(before, after, regions.cells, regions.regions);
    expect(truncated).toBe(false);
    expect(explained).toBe(regions.regions.length);
    expect(changes.map((c) => c.description)).toEqual([
      '`div#new` appeared',
      '`div#gone` disappeared',
      'heading text changed from "Sign in" to "Log in"',
      '`a#cta` background changed from #0070f3 to #d1242f',
      '`button[data-testid=submit]` moved 4 px down',
    ]);
    const moved = changes.find((c) => c.kind === 'moved');
    expect(moved).toMatchObject({
      key: '[data-testid=submit]',
      role: 'button',
      dx: 0,
      dy: 4,
      from: { x: 10, y: 10, width: 40, height: 20 },
      to: { x: 10, y: 14, width: 40, height: 20 },
    });
    expect(moved?.regions).toHaveLength(1);
    expect(changes.find((c) => c.kind === 'text')?.text).toEqual({ from: 'Sign in', to: 'Log in' });
    expect(changes.find((c) => c.kind === 'style')?.style).toEqual({
      background: { from: '#0070f3', to: '#d1242f' },
    });
  });

  test('elements that moved with their container are folded into it', () => {
    const shift = (e: SnapshotElement) => ({ ...e, y: e.y + 30 });
    const before = [
      el('#main', { x: 0, y: 10, width: 200, height: 60 }, { tag: 'main' }),
      el('#title', { x: 10, y: 20, width: 80, height: 10 }),
      el('#text', { x: 10, y: 40, width: 80, height: 10 }),
    ];
    const regions = changedAt({ x: 0, y: 10, width: 200, height: 90 });
    const { changes } = elementChanges(before, before.map(shift), regions.cells, regions.regions);
    expect(changes.map((c) => c.description)).toEqual(['`main#main` moved 30 px down (with 2 elements inside)']);
  });

  test('several changed aspects are named in one sentence', () => {
    const before = [el('#b', { x: 0, y: 0, width: 40, height: 20 }, { style: { color: '#222222' } })];
    const after = [el('#b', { x: 6, y: 0, width: 50, height: 20 }, { style: { color: '#ffffff' } })];
    const regions = changedAt({ x: 0, y: 0, width: 60, height: 20 });
    const [change] = elementChanges(before, after, regions.cells, regions.regions).changes;
    expect(change?.kind).toBe('style');
    expect(change?.kinds).toEqual(['style', 'resized', 'moved']);
    expect(change?.description).toBe(
      '`div#b` colour changed from #222222 to #ffffff, resized from 40×20 to 50×20 and moved 6 px right',
    );
  });

  test('at most 50 changes, flagged as truncated', () => {
    const before = Array.from({ length: 60 }, (_, i) =>
      el(`#e${i}`, { x: (i % 20) * 10, y: Math.floor(i / 20) * 10, width: 5, height: 5 }),
    );
    const regions = changedAt({ x: 0, y: 0, width: 200, height: 40 });
    const result = elementChanges(before, [], regions.cells, regions.regions);
    expect(result.changes).toHaveLength(50);
    expect(result.truncated).toBe(true);
  });
});

describe('describeChanges', () => {
  test('names elements that moved the same distance together', () => {
    const before = [
      el('#a', { x: 0, y: 0, width: 50, height: 10 }),
      el('#b', { x: 60, y: 0, width: 50, height: 10 }),
      el('#c', { x: 120, y: 0, width: 50, height: 10 }),
    ];
    const after = before.map((e) => ({ ...e, y: e.y + 20 }));
    const regions = changedAt({ x: 0, y: 0, width: 200, height: 30 });
    const { changes, truncated } = elementChanges(before, after, regions.cells, regions.regions);
    expect(describeChanges(changes, truncated)).toBe('`div#a` and 2 other elements moved 20 px down.');
  });
});

describe('compareImages with elements', () => {
  const button = (y: number) => makePng(W, H, WHITE, [{ x: 20, y, width: 60, height: 20, color: [0, 112, 243, 255] }]);
  const job = (baseline: Uint8Array, current: Uint8Array, elements?: SnapshotElement[][]) => ({
    current,
    baseline,
    ignoreRegions: [],
    colorThreshold: 0.1,
    tolerancePercent: 0,
    maxPixels: 1e7,
    ...(elements ? { elements: { baseline: elements[0] ?? [], current: elements[1] ?? [] } } : {}),
  });

  test('the summary names the element; regions it does not explain are counted', () => {
    const base = makePng(W, H, WHITE, [{ x: 20, y: 20, width: 60, height: 20, color: [0, 112, 243, 255] }]);
    const changed = makePng(W, H, WHITE, [
      { x: 20, y: 28, width: 60, height: 20, color: [0, 112, 243, 255] },
      { x: 160, y: 90, width: 10, height: 10, color: [0, 0, 0, 255] },
    ]);
    const before = [el('[data-testid=submit]', { x: 20, y: 20, width: 60, height: 20 }, { tag: 'button' })];
    const after = [el('[data-testid=submit]', { x: 20, y: 28, width: 60, height: 20 }, { tag: 'button' })];
    const result = compareImages(job(base, changed, [before, after]));
    if (result.kind !== 'compared') throw new Error(result.kind);
    expect(result.diff.summary).toMatch(
      /^`button\[data-testid=submit\]` moved 8 px down\. 1 other changed region\. [\d.]+% of pixels changed\.$/,
    );
    expect(result.diff.changes).toHaveLength(1);
    expect(result.diff.changesTruncated).toBe(false);
  });

  test('without elements the diff is exactly as before: no changes field, the region summary', () => {
    const result = compareImages(job(button(20), button(28)));
    if (result.kind !== 'compared') throw new Error(result.kind);
    expect(result.diff).not.toHaveProperty('changes');
    expect(result.diff.summary).toMatch(/^2 changed regions; largest/);
  });

  test('elements that explain nothing keep the region summary but list no changes', () => {
    const result = compareImages(job(button(20), button(28), [[], []]));
    if (result.kind !== 'compared') throw new Error(result.kind);
    expect(result.diff.changes).toEqual([]);
    expect(result.diff.summary).toMatch(/^2 changed regions; largest/);
  });
});
