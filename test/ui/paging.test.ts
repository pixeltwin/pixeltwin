import { describe, expect, test } from 'bun:test';
import { pageNumbers, pageOf, pageSizeOf, rangeText, slotsOf } from '../../src/ui/paging';

const checks = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `c${i}`, groupId: null }));

describe('build page paging', () => {
  test('a change group is one slot where its newest check is; a group of one listed is a check', () => {
    const slots = slotsOf([
      { id: 'a', groupId: null },
      { id: 'b', groupId: 'g1' },
      { id: 'c', groupId: 'g2' },
      { id: 'd', groupId: 'g1' },
      { id: 'e', groupId: 'g1' },
    ]);
    expect(slots).toEqual([
      { key: 'a', ids: ['a'], groupId: null },
      { key: 'group-g1', ids: ['b', 'd', 'e'], groupId: 'g1' },
      { key: 'c', ids: ['c'], groupId: null },
    ]);
  });

  test('the page size comes from ?size=, else the cookie, clamped to 2–60', () => {
    expect(pageSizeOf(undefined)).toBe(24);
    expect(pageSizeOf('15')).toBe(15);
    expect(pageSizeOf('1')).toBe(2);
    expect(pageSizeOf('1000')).toBe(60);
    expect(pageSizeOf('abc', '18')).toBe(18);
    expect(pageSizeOf(undefined, '-3')).toBe(24);
    expect(pageSizeOf('10', '18')).toBe(10);
  });

  test('a page past the end is the last page, a bad one the first', () => {
    const slots = slotsOf(checks(30));
    expect(pageOf(slots, { page: '2', size: 12 })).toMatchObject({ page: 2, pages: 3, offset: 12, total: 30 });
    expect(pageOf(slots, { page: '9', size: 12 })).toMatchObject({ page: 3, offset: 24 });
    expect(pageOf(slots, { page: '9', size: 12 }).slots).toHaveLength(6);
    expect(pageOf(slots, { page: 'x', size: 12 }).page).toBe(1);
    expect(pageOf(slots, { page: '-2', size: 12 }).page).toBe(1);
    expect(pageOf([], { page: '3', size: 12 })).toMatchObject({ page: 1, pages: 1, total: 0, slots: [] });
  });

  test('focus picks the page that holds the card, also a check inside a group', () => {
    const slots = slotsOf([...checks(20), { id: 'g-a', groupId: 'g' }, { id: 'g-b', groupId: 'g' }]);
    expect(pageOf(slots, { page: '1', size: 8, focus: 'c13' }).page).toBe(2);
    expect(pageOf(slots, { size: 8, focus: 'g-b' }).page).toBe(3);
    expect(pageOf(slots, { size: 8, focus: 'group-g' }).page).toBe(3);
    expect(pageOf(slots, { page: '2', size: 8, focus: 'gone' }).page).toBe(2);
  });

  test('page numbers keep the first, the last and two around the current one', () => {
    expect(pageNumbers(1, 1)).toEqual([1]);
    expect(pageNumbers(1, 5)).toEqual([1, 2, 3, 4, 5]);
    expect(pageNumbers(1, 9)).toEqual([1, 2, 3, 'gap', 9]);
    expect(pageNumbers(5, 9)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(pageNumbers(6, 12)).toEqual([1, 'gap', 4, 5, 6, 7, 8, 'gap', 12]);
    expect(pageNumbers(12, 12)).toEqual([1, 'gap', 10, 11, 12]);
  });

  test('the range says which cards of how many', () => {
    const slots = slotsOf(checks(87));
    expect(rangeText(pageOf(slots, { page: '2', size: 12 }))).toBe('13–24 of 87');
    expect(rangeText(pageOf(slots, { page: '8', size: 12 }))).toBe('85–87 of 87');
    expect(rangeText(pageOf(slotsOf(checks(13)), { page: '2', size: 12 }))).toBe('13 of 13');
  });
});
