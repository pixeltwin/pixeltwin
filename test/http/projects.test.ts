import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createTestApp, problemOf, type TestApp } from '../helpers/app';

describe('project and token routes', () => {
  let t: TestApp;
  let admin: { cookie: string; id: string };

  beforeEach(async () => {
    t = await createTestApp();
    admin = await t.userAs('admin');
  });

  afterEach(async () => {
    await t.close();
  });

  test('an admin manages projects', async () => {
    const created = await t.request('POST', '/api/v1/projects', { as: admin, json: { slug: 'web', name: 'Web' } });
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ slug: 'web', mainBranch: 'main', colorThreshold: 0.1 });

    const dup = await t.request('POST', '/api/v1/projects', { as: admin, json: { slug: 'web', name: 'Again' } });
    expect(await problemOf(dup)).toMatchObject({ status: 409, code: 'project_slug_taken' });

    const patched = await t.request('PATCH', '/api/v1/projects/web', { as: admin, json: { mainBranch: 'trunk' } });
    expect(await patched.json()).toMatchObject({ mainBranch: 'trunk' });
    expect((await t.request('DELETE', '/api/v1/projects/web', { as: admin })).status).toBe(204);
    expect(await problemOf(await t.request('GET', '/api/v1/projects/web', { as: admin }))).toMatchObject({
      status: 404,
      code: 'project_not_found',
    });
  });

  test('tokens are shown once, listed without secrets, and revocable', async () => {
    await t.request('POST', '/api/v1/projects', { as: admin, json: { slug: 'web', name: 'Web' } });
    const created = await t.request('POST', '/api/v1/projects/web/tokens', {
      as: admin,
      json: { name: 'CI', scopes: ['read', 'write'] },
    });
    expect(created.status).toBe(201);
    const { token, id } = (await created.json()) as { token: string; id: string };
    expect(token).toMatch(/^pt_/);

    const listed = await (await t.request('GET', '/api/v1/projects/web/tokens', { as: admin })).text();
    expect(listed).not.toContain(token);

    expect((await t.request('GET', '/api/v1/projects/web', { as: { token } })).status).toBe(200);
    expect((await t.request('DELETE', `/api/v1/projects/web/tokens/${id}`, { as: admin })).status).toBe(204);
    expect(await problemOf(await t.request('GET', '/api/v1/projects/web', { as: { token } }))).toMatchObject({
      status: 401,
      code: 'invalid_token',
    });
  });

  test('a token sees only its own project', async () => {
    for (const slug of ['web', 'app']) {
      await t.request('POST', '/api/v1/projects', { as: admin, json: { slug, name: slug } });
    }
    const { token } = await t.tokenAs('web', ['read']);
    const list = (await (await t.request('GET', '/api/v1/projects', { as: { token } })).json()) as {
      items: Array<{ slug: string }>;
    };
    expect(list.items.map((p) => p.slug)).toEqual(['web']);
    expect(await problemOf(await t.request('GET', '/api/v1/projects/app', { as: { token } }))).toMatchObject({
      status: 403,
      code: 'token_project_mismatch',
    });
  });
});
