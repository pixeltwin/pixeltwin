import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { buildOpenApiDocument } from '../../src/http/doc-app';
import { createTestApp, PUBLIC_URL, type TestApp } from '../helpers/app';

describe('documentation routes', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(async () => {
    await t.close();
  });

  test('openapi.json matches the committed contract (run `bun run openapi` after API changes)', () => {
    const committed = JSON.parse(readFileSync(new URL('../../openapi.json', import.meta.url), 'utf8'));
    expect(buildOpenApiDocument()).toEqual(committed);
  });

  test('/openapi.json serves the document', async () => {
    const doc = (await (await t.request('GET', '/openapi.json')).json()) as { openapi: string; paths: object };
    expect(doc.openapi).toBe('3.1.0');
    expect(Object.keys(doc.paths)).toContain('/api/v1/builds/{id}/checks');
  });

  test('/docs is self-contained: no third-party URLs, strict CSP', async () => {
    const res = await t.request('GET', '/docs');
    const html = await res.text();
    expect(html).toContain('src="docs/scalar.js"');
    expect(html).not.toMatch(/https?:\/\//);
    expect(res.headers.get('content-security-policy')).toContain("script-src 'self'");
    const bundle = await t.request('GET', '/docs/scalar.js');
    expect(bundle.headers.get('content-type')).toStartWith('text/javascript');
    expect((await bundle.text()).length).toBeGreaterThan(1_000_000);
  });

  test('/llms.txt explains the workflow with this server URL', async () => {
    const text = await (await t.request('GET', '/llms.txt')).text();
    expect(text).toContain(`${PUBLIC_URL}/api/v1/projects/<slug>/builds`);
    expect(text).toContain(`${PUBLIC_URL}/openapi.json`);
    for (const word of [
      'unchanged',
      'changed',
      'pending',
      'passed',
      'diff.summary',
      'diff.regions',
      'diff.changes',
      '"reason"',
      'suggestion',
      'npx pixeltwin mcp',
      'review_group',
      'groupId',
      '/groups/<groupId>/approve',
      'flaky',
      'noisy-screens',
    ]) {
      expect(text).toContain(word);
    }
  });
});
