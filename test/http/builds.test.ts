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

  test('branches lists each branch with its latest build; read access to the project is enough', async () => {
    const { token } = await t.tokenAs('web', ['write']);
    for (const branch of ['main', 'feature/cart', 'main']) {
      await t.request('POST', '/api/v1/projects/web/builds', { as: { token }, json: { branch } });
    }
    const { token: reader } = await t.tokenAs('web', ['read']);
    const res = await t.request('GET', '/api/v1/projects/web/branches', { as: { token: reader } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ branch: string; latest: { number: number }; recent: unknown[] }>;
    expect(body.map((b) => [b.branch, b.latest.number, b.recent.length])).toEqual([
      ['main', 3, 2],
      ['feature/cart', 2, 1],
    ]);

    await t.request('POST', '/api/v1/projects', { as: admin, json: { slug: 'app', name: 'App' } });
    const { token: other } = await t.tokenAs('app', ['read']);
    expect((await t.request('GET', '/api/v1/projects/web/branches', { as: { token: other } })).status).toBe(403);
  });

  test('the contract documents the build number', async () => {
    const doc = (await (await t.request('GET', '/openapi.json')).json()) as {
      components: { schemas: { Build: { required: string[]; properties: Record<string, unknown> } } };
    };
    expect(doc.components.schemas.Build.required).toContain('number');
    expect(doc.components.schemas.Build.properties.number).toMatchObject({ type: 'integer' });
  });

  test('DELETE /builds/{id} removes a build for admins only, and is a 404 afterwards', async () => {
    const admin = await t.userAs('admin');
    const viewer = await t.userAs('viewer', 'view@example.com');
    const { openBuild } = await import('../helpers/scenario');
    const id = await openBuild(t.deps, 'web');
    expect((await t.request('DELETE', `/api/v1/builds/${id}`, { as: viewer })).status).toBe(403);
    expect((await t.request('DELETE', `/api/v1/builds/${id}`, { as: admin })).status).toBe(204);
    expect((await t.request('GET', `/api/v1/builds/${id}`, { as: admin })).status).toBe(404);
  });

  test('a parallel build: each part finalizes it, the last one closes it; no body still closes at once', async () => {
    const { token } = await t.tokenAs('web', ['write']);
    const as = { token };
    const open = await t.request('POST', '/api/v1/projects/web/builds', {
      as,
      json: { externalId: 'gitlab-77', parallelTotal: 2 },
    });
    const build = (await open.json()) as { id: string; parallelTotal: number; partsFinished: number };
    expect(build).toMatchObject({ parallelTotal: 2, partsFinished: 0 });
    const finalize = async (json?: unknown) =>
      (await (await t.request('POST', `/api/v1/builds/${build.id}/finalize`, { as, json })).json()) as {
        state: string;
        partsFinished: number;
      };
    expect(await finalize({ part: 'job-1' })).toMatchObject({ state: 'open', partsFinished: 1 });
    expect(await finalize({ part: 'job-2' })).toMatchObject({ state: 'finalized', partsFinished: 2 });

    const plain = (await (await t.request('POST', '/api/v1/projects/web/builds', { as, json: {} })).json()) as {
      id: string;
    };
    const closed = await t.request('POST', `/api/v1/builds/${plain.id}/finalize`, { as });
    expect(closed.status).toBe(200);
    expect(((await closed.json()) as { state: string }).state).toBe('finalized');
    const bad = await t.request('POST', `/api/v1/builds/${plain.id}/finalize`, { as, json: { part: '' } });
    expect(bad.status).toBe(422);

    // Finalize took no body before parallel builds: a JSON content type with an empty body still works.
    const other = (await (await t.request('POST', '/api/v1/projects/web/builds', { as, json: {} })).json()) as {
      id: string;
    };
    const empty = await t.request('POST', `/api/v1/builds/${other.id}/finalize`, {
      as,
      headers: { 'content-type': 'application/json' },
    });
    expect(empty.status).toBe(200);
  });

  test('POST /builds/{id}/timings adds what an SDK worker measured; the build sums it up', async () => {
    const { token } = await t.tokenAs('web', ['read', 'write']);
    const as = { token };
    const build = (await (await t.request('POST', '/api/v1/projects/web/builds', { as, json: {} })).json()) as {
      id: string;
      timing: unknown;
    };
    expect(build.timing).toEqual({ checks: 0, screenshotMs: 0, uploadMs: 0, retakes: 0, compareMs: 0 });
    const res = await t.request('POST', `/api/v1/builds/${build.id}/timings`, {
      as,
      json: { checks: 2, screenshotMs: 700, uploadMs: 300, retakes: 1 },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { timing: unknown }).timing).toMatchObject({ checks: 2, screenshotMs: 700 });
    const { token: reader } = await t.tokenAs('web', ['read']);
    const refused = await t.request('POST', `/api/v1/builds/${build.id}/timings`, { as: { token: reader }, json: {} });
    expect(refused.status).toBe(403);
  });
});
