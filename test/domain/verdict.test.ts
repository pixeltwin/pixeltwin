import { describe, expect, test } from 'bun:test';
import { type BuildCounts, deriveVerdict, emptyCounts } from '../../src/domain/verdict';

function counts(result: Partial<BuildCounts['result']>, review: Partial<BuildCounts['review']>): BuildCounts {
  const c = emptyCounts();
  Object.assign(c.result, result);
  Object.assign(c.review, review);
  c.total = Object.values(c.result).reduce((a, b) => a + b, 0);
  return c;
}

describe('deriveVerdict', () => {
  test('empty build', () => {
    expect(deriveVerdict(emptyCounts())).toBe('empty');
  });

  test('errors win over everything', () => {
    expect(deriveVerdict(counts({ error: 1, changed: 1 }, { rejected: 1, none: 1 }))).toBe('error');
  });

  test('rejected beats pending', () => {
    expect(deriveVerdict(counts({ changed: 2 }, { rejected: 1, pending: 1 }))).toBe('rejected');
  });

  test('pending while anything awaits review', () => {
    expect(deriveVerdict(counts({ new: 1, unchanged: 1 }, { pending: 1, none: 1 }))).toBe('pending');
  });

  test('passed when everything is unchanged or approved', () => {
    expect(deriveVerdict(counts({ unchanged: 1, changed: 1 }, { none: 1, approved: 1 }))).toBe('passed');
  });
});
