import { describe, expect, test } from 'bun:test';
import type * as Rank from '../../../src/ui/client/rank';
import { clientModule } from '../../helpers/client';

const { rank, matchScore, pollDelay } = await clientModule<typeof Rank>('rank');

const items = [
  { label: 'Web shop', recency: 1 },
  { label: 'Docs website', recency: 5 },
  { label: 'feature/web-cart', recency: 9 },
  { label: 'wonderful-banner', recency: 3 },
];

describe('palette ranking', () => {
  test('prefix beats substring beats scattered letters', () => {
    expect(matchScore('web', 'Web shop')).toBeGreaterThan(matchScore('web', 'Docs website') as number);
    expect(matchScore('web', 'Docs website')).toBeGreaterThan(matchScore('web', 'wonderful-banner') as number);
    expect(matchScore('xyz', 'Web shop')).toBeNull();
  });

  test('matching ignores case and spaces in the query', () => {
    expect(matchScore('WEB', 'web shop')).not.toBeNull();
    expect(matchScore('  web ', 'Web shop')).not.toBeNull();
  });

  test('results are ordered by score, then by recency, and cut to the limit', () => {
    expect(rank(items, 'web').map((i) => i.label)).toEqual([
      'Web shop',
      'feature/web-cart',
      'Docs website',
      'wonderful-banner',
    ]);
    expect(rank(items, 'web', 2)).toHaveLength(2);
  });

  test('an empty query lists everything by recency', () => {
    expect(rank(items, '').map((i) => i.label)).toEqual([
      'feature/web-cart',
      'Docs website',
      'wonderful-banner',
      'Web shop',
    ]);
  });
});

describe('live polling', () => {
  test('polls every 5 s, slowing to 30 s after 10 polls without a change', () => {
    expect(pollDelay(0)).toBe(5000);
    expect(pollDelay(9)).toBe(5000);
    expect(pollDelay(10)).toBe(30_000);
  });
});
