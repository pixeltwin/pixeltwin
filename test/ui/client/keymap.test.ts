import { describe, expect, test } from 'bun:test';
import type * as Keymap from '../../../src/ui/client/keymap';
import type { KeyInput } from '../../../src/ui/client/keymap';
import { clientModule } from '../../helpers/client';

const { shortcutOf } = await clientModule<typeof Keymap>('keymap');

const key = (k: string, extra: Partial<KeyInput> = {}): KeyInput => ({
  key: k,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  editing: false,
  ...extra,
});

describe('shortcutOf', () => {
  test('letters and digits map to themselves, lower case', () => {
    expect(shortcutOf(key('a'))).toBe('a');
    expect(shortcutOf(key('A'))).toBe('a');
    expect(shortcutOf(key('3'))).toBe('3');
    expect(shortcutOf(key('?'))).toBe('?');
  });

  test('named keys are lower case', () => {
    expect(shortcutOf(key('Escape'))).toBe('escape');
    expect(shortcutOf(key('ArrowLeft'))).toBe('arrowleft');
  });

  test('typing in a field never triggers a shortcut, except Escape', () => {
    expect(shortcutOf(key('a', { editing: true }))).toBeNull();
    expect(shortcutOf(key('?', { editing: true }))).toBeNull();
    expect(shortcutOf(key('Escape', { editing: true }))).toBe('escape');
  });

  test('Ctrl/Cmd+K is the palette everywhere, even in a field; other modified keys are left alone', () => {
    expect(shortcutOf(key('k', { metaKey: true }))).toBe('mod+k');
    expect(shortcutOf(key('K', { ctrlKey: true, editing: true }))).toBe('mod+k');
    expect(shortcutOf(key('a', { ctrlKey: true }))).toBeNull();
    expect(shortcutOf(key('c', { metaKey: true }))).toBeNull();
    expect(shortcutOf(key('a', { altKey: true }))).toBeNull();
  });

  test('Shift with an arrow is its own shortcut; Shift with other keys is just the character', () => {
    expect(shortcutOf(key('ArrowRight', { shiftKey: true }))).toBe('shift+arrowright');
    expect(shortcutOf(key('ArrowRight'))).toBe('arrowright');
    expect(shortcutOf(key('?', { shiftKey: true }))).toBe('?');
    expect(shortcutOf(key('A', { shiftKey: true }))).toBe('a');
  });

  test('bare modifier presses are ignored', () => {
    expect(shortcutOf(key('Shift'))).toBeNull();
    expect(shortcutOf(key('Meta', { metaKey: true }))).toBeNull();
  });
});
