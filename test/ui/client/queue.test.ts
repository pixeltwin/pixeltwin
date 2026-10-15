import { describe, expect, test } from 'bun:test';
import type * as Queue from '../../../src/ui/client/queue';
import { clientModule } from '../../helpers/client';

const { nextPending, adjacent } = await clientModule<typeof Queue>('queue');

const frames = [
  { id: 'chk_a', review: 'approved' },
  { id: 'chk_b', review: 'pending' },
  { id: 'chk_c', review: 'none' },
  { id: 'chk_d', review: 'pending' },
];

describe('review queue', () => {
  test('the next waiting check comes after the current one', () => {
    expect(nextPending(frames, 'chk_b')).toBe('chk_d');
    expect(nextPending(frames, 'chk_a')).toBe('chk_b');
  });

  test('it wraps around to earlier checks still waiting', () => {
    expect(nextPending(frames, 'chk_d')).toBe('chk_b');
  });

  test('the current check never counts, and none waiting means null', () => {
    expect(nextPending([{ id: 'chk_b', review: 'pending' }], 'chk_b')).toBeNull();
    expect(nextPending([{ id: 'chk_a', review: 'approved' }], 'chk_a')).toBeNull();
  });

  test('a current check outside the list is placed by its id', () => {
    expect(nextPending(frames, 'chk_bb')).toBe('chk_d');
    expect(nextPending(frames, 'chk_z')).toBe('chk_b');
  });

  test('previous and next neighbours follow list order', () => {
    expect(adjacent(frames, 'chk_c')).toEqual({ previous: 'chk_b', next: 'chk_d' });
    expect(adjacent(frames, 'chk_a')).toEqual({ previous: null, next: 'chk_b' });
    expect(adjacent(frames, 'chk_bb')).toEqual({ previous: 'chk_b', next: 'chk_c' });
  });
});
