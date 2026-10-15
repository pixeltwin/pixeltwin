import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createTestApp, type TestApp } from '../helpers/app';

describe('build routes', () => {
  let t: TestApp;
  let admin: { cookie: string; id: string };

  beforeEach(async () => {
    t = await createTestApp();
    admin = await t.userAs('admin');
    await t.request('POST', '/api/v1/projects', { as: admin, json: { slug: 'web', name: 'Web' } });
  });

  afterEach(async () => {
    await t.close();
  });

  test('builds carry their per-project number; the project never shows its counter', async () => {
    const { token } = await t.tokenAs('web', ['read', 'write']);
    const open = async () =>
      (await (await t.request('POST', '/api/v1/projects/web/builds', { as: { token }, json: {} })).json()) as {
        id: string;
        number: number;
      };
    const first = await open();
    const second = await open();
    expect([first.number, second.number]).toEqual([1, 2]);
    const fetched = (await (await t.request('GET', `/api/v1/builds/${second.id}`, { as: { token } })).json()) as {
      number: number;
    };
    expect(fetched.number).toBe(2);

    const project = (await (await t.request('GET', '/api/v1/projects/web', { as: admin })).json()) as object;
    expect(Object.keys(project)).not.toContain('buildSeq');
  });

  test('the contract documents the build number', async () => {
    const doc = (await (await t.request('GET', '/openapi.json')).json()) as {
      components: { schemas: { Build: { required: string[]; properties: Record<string, unknown> } } };
    };
    expect(doc.components.schemas.Build.required).toContain('number');
    expect(doc.components.schemas.Build.properties.number).toMatchObject({ type: 'integer' });
  });
});
