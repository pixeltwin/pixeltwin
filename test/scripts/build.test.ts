import { describe, expect, test } from 'bun:test';
import { bunTarget, nativeTarget, outfileFor, parseTargets, TARGETS } from '../../scripts/build';

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

  test('x64 binaries use the baseline build, so CPUs without AVX2 can run them', () => {
    expect(bunTarget('linux-x64')).toBe('bun-linux-x64-baseline');
    expect(bunTarget('darwin-x64')).toBe('bun-darwin-x64-baseline');
    expect(bunTarget('windows-x64')).toBe('bun-windows-x64-baseline');
    expect(bunTarget('linux-arm64')).toBe('bun-linux-arm64');
    expect(bunTarget('darwin-arm64')).toBe('bun-darwin-arm64');
  });

  test('names files by version and target', () => {
    expect(outfileFor('linux-x64', '1.2.3')).toBe('pixeltwin-1.2.3-linux-x64');
    expect(outfileFor('windows-x64', '1.2.3')).toBe('pixeltwin-1.2.3-windows-x64.exe');
  });
});
