import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { VERSION } from '../../src/version';

interface Manifest {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  repository?: { url: string; directory?: string };
}

const manifest = (name: string) =>
  JSON.parse(readFileSync(new URL(`../../packages/${name}/package.json`, import.meta.url), 'utf8')) as Manifest;

describe.each(['client', 'playwright', 'wdio'])('packages/%s', (name) => {
  test('is released with the server, at the same version', () => {
    expect(manifest(name).version).toBe(VERSION);
  });

  test('depends on the client of the same release', () => {
    const client = manifest(name).dependencies?.['@pixeltwin/client'];
    if (name !== 'client') expect(client).toBe(VERSION);
  });

  test('points npm at its directory in the repository', () => {
    expect(manifest(name).repository).toEqual({
      type: 'git',
      url: 'git+https://github.com/pixeltwin/pixeltwin.git',
      directory: `packages/${name}`,
    } as Manifest['repository']);
  });
});
