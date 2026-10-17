import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkSite, FIRST_VIEW_BUDGET } from '../scripts/site-check';

const page = (body: string) =>
  `<!doctype html><html lang="en"><head><title>t</title><meta name="description" content="d"></head><body>${body}</body></html>`;

function site(files: Record<string, string | Uint8Array>): string {
  const dir = mkdtempSync(join(tmpdir(), 'pixeltwin-site-'));
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

describe('site check', () => {
  test('the landing page in site/ passes', () => {
    const report = checkSite(join(import.meta.dir, '..', 'site'));
    expect(report.errors).toEqual([]);
    expect(report.firstViewBytes).toBeLessThan(FIRST_VIEW_BUDGET);
  });

  test('missing files, ids, alt text and dimensions are reported', () => {
    const dir = site({
      'index.html': page(
        '<a href="#nowhere">x</a><a href="docs/">y</a><a href="/root.html">z</a>' +
          '<img src="assets/a.png"><img src="assets/b.png" alt="" width="10" height="10">',
      ),
      'assets/b.png': 'png',
    });
    try {
      const { errors } = checkSite(dir);
      expect(errors.some((e) => e.includes('#nowhere'))).toBe(true);
      expect(errors.some((e) => e.includes('docs/ does not exist'))).toBe(true);
      expect(errors.some((e) => e.includes('root-relative'))).toBe(true);
      expect(errors.some((e) => e.includes('assets/a.png does not exist'))).toBe(true);
      expect(errors.some((e) => e.includes('a.png has no alt'))).toBe(true);
      expect(errors.some((e) => e.includes('a.png has no width'))).toBe(true);
      expect(errors.some((e) => e.includes('b.png'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('eager images count toward the budget, lazy ones do not', () => {
    const big = new Uint8Array(FIRST_VIEW_BUDGET);
    const img = (loading: string) => `<img src="big.webp" alt="" width="1" height="1"${loading}>`;
    const eager = site({ 'index.html': page(img('')), 'big.webp': big });
    const lazy = site({ 'index.html': page(img(' loading="lazy"')), 'big.webp': big });
    try {
      expect(checkSite(eager).errors.some((e) => e.includes('over the budget'))).toBe(true);
      expect(checkSite(lazy).errors).toEqual([]);
    } finally {
      rmSync(eager, { recursive: true, force: true });
      rmSync(lazy, { recursive: true, force: true });
    }
  });
});
