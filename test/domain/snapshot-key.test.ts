import { describe, expect, test } from 'bun:test';
import { canonicalVariant, snapshotKey } from '../../src/domain/snapshot-key';

describe('snapshotKey', () => {
  test('ignores variant key order', () => {
    expect(snapshotKey('home', { viewport: '1280x720', browser: 'chromium' })).toBe(
      snapshotKey('home', { browser: 'chromium', viewport: '1280x720' }),
    );
  });

  test('changes with name or any variant value', () => {
    const key = snapshotKey('home', { browser: 'chromium' });
    expect(snapshotKey('home ', { browser: 'chromium' })).not.toBe(key);
    expect(snapshotKey('home', { browser: 'firefox' })).not.toBe(key);
    expect(snapshotKey('home', {})).not.toBe(key);
  });

  test('is a 64-character hex string', () => {
    expect(snapshotKey('home', {})).toMatch(/^[0-9a-f]{64}$/);
  });

  test('canonicalVariant sorts by code unit, not locale', () => {
    expect(canonicalVariant({ b: '1', B: '2', a: '3' }).map(([k]) => k)).toEqual(['B', 'a', 'b']);
  });
});
