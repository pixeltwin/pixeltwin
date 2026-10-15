import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

test('the Docker build uses the Bun version pinned in .bun-version', () => {
  const pinned = read('.bun-version').trim();
  const used = /FROM\s+(?:--platform=\S+\s+)?oven\/bun:(\S+)/.exec(read('Dockerfile'))?.[1];
  expect(used).toBe(pinned);
});

test('the image runs as non-root, keeps data in a volume and checks its own health', () => {
  const dockerfile = read('Dockerfile');
  expect(dockerfile).toContain('USER nonroot');
  expect(dockerfile).toContain('VOLUME /data');
  expect(dockerfile).toContain('HEALTHCHECK');
  expect(dockerfile).toContain('"healthcheck"');
});
