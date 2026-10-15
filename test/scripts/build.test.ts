import { describe, expect, test } from 'bun:test';
import { nativeTarget, outfileFor, parseTargets, TARGETS } from '../../scripts/build';

describe('build script', () => {
  test('maps this machine to a target', () => {
    expect(nativeTarget('darwin', 'arm64')).toBe('darwin-arm64');
    expect(nativeTarget('linux', 'x64')).toBe('linux-x64');
    expect(nativeTarget('win32', 'x64')).toBe('windows-x64');
    expect(() => nativeTarget('freebsd', 'x64')).toThrow('No binary target');
  });

  test('parses target arguments', () => {
    expect(parseTargets([])).toEqual([nativeTarget()]);
    expect(parseTargets(['all'])).toEqual([...TARGETS]);
    expect(parseTargets(['linux-arm64', 'darwin-x64'])).toEqual(['linux-arm64', 'darwin-x64']);
    expect(() => parseTargets(['linux-386'])).toThrow('Unknown target "linux-386"');
  });

  test('names files by version and target', () => {
    expect(outfileFor('linux-x64', '1.2.3')).toBe('pixeltwin-1.2.3-linux-x64');
    expect(outfileFor('windows-x64', '1.2.3')).toBe('pixeltwin-1.2.3-windows-x64.exe');
  });
});
