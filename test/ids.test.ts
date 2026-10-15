import { describe, expect, test } from 'bun:test';
import { newId } from '../src/ids';

describe('newId', () => {
  test('prefixes a 26-character ULID', () => {
    expect(newId('bld')).toMatch(/^bld_[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  test('later ids sort after earlier ids', () => {
    const ids = Array.from({ length: 100 }, () => newId('chk'));
    expect([...ids].sort()).toEqual(ids);
  });
});
