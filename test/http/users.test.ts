import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createTestApp, PASSWORD, problemOf, type TestApp } from '../helpers/app';

describe('user routes', () => {
  let t: TestApp;
  let admin: { cookie: string; id: string };

  beforeEach(async () => {
    t = await createTestApp();
    admin = await t.userAs('admin', 'root@example.com');
  });

  afterEach(async () => {
    await t.close();
  });

  test('an admin creates, lists, updates and deletes users', async () => {
    const created = await t.request('POST', '/api/v1/users', {
      as: admin,
      json: { email: 'Ada@Example.com', password: PASSWORD, role: 'reviewer' },
    });
    expect(created.status).toBe(201);
    const ada = (await created.json()) as { id: string; email: string };
    expect(ada.email).toBe('ada@example.com');
    expect(JSON.stringify(ada)).not.toContain('argon2');

    const list = (await (await t.request('GET', '/api/v1/users', { as: admin })).json()) as { items: unknown[] };
    expect(list.items).toHaveLength(2);

    const updated = await t.request('PATCH', `/api/v1/users/${ada.id}`, { as: admin, json: { role: 'viewer' } });
    expect(await updated.json()).toMatchObject({ role: 'viewer' });
    expect((await t.request('DELETE', `/api/v1/users/${ada.id}`, { as: admin })).status).toBe(204);
  });

  test('the last admin cannot delete themselves', async () => {
    const res = await t.request('DELETE', `/api/v1/users/${admin.id}`, { as: admin });
    expect(await problemOf(res)).toMatchObject({ status: 409, code: 'last_admin' });
  });

  test('non-admins cannot manage users', async () => {
    const reviewer = await t.userAs('reviewer');
    const res = await t.request('GET', '/api/v1/users', { as: reviewer });
    expect(await problemOf(res)).toMatchObject({ status: 403, code: 'forbidden' });
  });
});
