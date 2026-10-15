import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createTestApp, PASSWORD, problemOf, type TestApp } from '../helpers/app';

describe('HTTP foundation', () => {
  let t: TestApp;

  beforeEach(async () => {
    t = await createTestApp();
  });

  afterEach(async () => {
    await t.close();
  });

  test('healthz reports database and storage', async () => {
    const res = await t.request('GET', '/healthz');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'ok', database: 'ok', storage: 'ok' });
    expect(res.headers.get('x-request-id')).toMatch(/^req_/);
  });

  test('unknown routes are a problem+json 404 with a request id', async () => {
    const res = await t.request('GET', '/api/v1/nope');
    expect(res.status).toBe(404);
    const problem = await problemOf(res);
    expect(problem).toMatchObject({ type: 'about:blank', status: 404, code: 'not_found', title: 'Not found' });
    expect((problem as unknown as { requestId: string }).requestId).toBe(res.headers.get('x-request-id') as string);
  });

  test('validation failures are 422 with field paths', async () => {
    const res = await t.request('POST', '/api/v1/auth/login', { json: { email: 'a@b.co', password: '', extra: 1 } });
    const problem = await problemOf(res);
    expect(problem.status).toBe(422);
    expect(problem.code).toBe('validation_failed');
    expect(problem.errors?.map((e) => e.path)).toContain('password');
  });

  test('malformed JSON is a 400 problem, not a crash', async () => {
    const res = await t.request('POST', '/api/v1/auth/login', {
      body: '{"email":',
      headers: { 'content-type': 'application/json' },
    });
    expect((await problemOf(res)).status).toBe(400);
  });

  test('an invalid bearer token is rejected even on public routes', async () => {
    const res = await t.request('GET', '/api/v1/me', { as: { token: 'pt_nope' } });
    expect(await problemOf(res)).toMatchObject({ status: 401, code: 'invalid_token' });
  });

  test('other Authorization schemes (e.g. Basic from a proxy) are ignored, so the session cookie still works', async () => {
    const { cookie } = await t.userAs('viewer');
    const res = await t.request('GET', '/api/v1/me', {
      as: { cookie },
      headers: { authorization: 'Basic dXNlcjpwYXNz' },
    });
    expect(res.status).toBe(200);
    const anonymous = await t.request('GET', '/api/v1/me', { headers: { authorization: 'Basic dXNlcjpwYXNz' } });
    expect(await problemOf(anonymous)).toMatchObject({ status: 401, code: 'unauthenticated' });
  });

  test('protected routes need credentials', async () => {
    expect(await problemOf(await t.request('GET', '/api/v1/me'))).toMatchObject({
      status: 401,
      code: 'unauthenticated',
    });
  });

  test('bodies over the limit are 413', async () => {
    const res = await t.request('POST', '/api/v1/auth/login', {
      json: { email: 'a@b.co', password: 'x'.repeat(2 * 1024 * 1024) },
    });
    expect(await problemOf(res)).toMatchObject({ status: 413, code: 'payload_too_large' });
  });

  test('cookie-authenticated writes from another origin are refused', async () => {
    const { cookie } = await t.userAs('admin');
    const res = await t.request('PUT', '/api/v1/me/password', {
      as: { cookie },
      headers: { origin: 'https://evil.example' },
      json: { currentPassword: PASSWORD, newPassword: 'another long password' },
    });
    expect(await problemOf(res)).toMatchObject({ status: 403, code: 'csrf_origin_mismatch' });
  });
});

describe('auth routes', () => {
  let t: TestApp;

  afterEach(async () => {
    await t.close();
  });

  test('setup creates the first admin who can then log in', async () => {
    t = await createTestApp({ setupToken: 'setup-secret' });
    const wrong = await t.request('POST', '/api/v1/setup', {
      json: { token: 'guess', email: 'root@example.com', password: PASSWORD },
    });
    expect(await problemOf(wrong)).toMatchObject({ status: 403, code: 'invalid_setup_token' });
    const res = await t.request('POST', '/api/v1/setup', {
      json: { token: 'setup-secret', email: 'Root@Example.com', password: PASSWORD },
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ email: 'root@example.com', role: 'admin' });
    const again = await t.request('POST', '/api/v1/setup', {
      json: { token: 'setup-secret', email: 'x@example.com', password: PASSWORD },
    });
    expect(await problemOf(again)).toMatchObject({ status: 409, code: 'setup_complete' });
  });

  test('login sets a hardened session cookie; me and logout use it', async () => {
    t = await createTestApp();
    const { cookie } = await t.userAs('reviewer', 'ada@example.com');
    const res = await t.request('POST', '/api/v1/auth/login', {
      json: { email: 'ADA@example.com', password: PASSWORD },
    });
    expect(res.status).toBe(200);
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).toContain('Path=/');
    expect(setCookie).not.toContain('Secure');

    const me = await t.request('GET', '/api/v1/me', { as: { cookie } });
    expect(await me.json()).toMatchObject({ email: 'ada@example.com', role: 'reviewer' });
    expect((await t.request('POST', '/api/v1/auth/logout', { as: { cookie } })).status).toBe(204);
    expect((await t.request('GET', '/api/v1/me', { as: { cookie } })).status).toBe(401);
  });

  test('an extended session is sent back to the browser with the new expiry', async () => {
    t = await createTestApp();
    const { cookie } = await t.userAs('viewer');
    const fresh = await t.request('GET', '/api/v1/me', { as: { cookie } });
    expect(fresh.headers.get('set-cookie')).toBeNull();

    await t.deps.db
      .updateTable('sessions')
      .set({ expiresAt: Date.now() + 13 * 24 * 60 * 60 * 1000 })
      .execute();
    const res = await t.request('GET', '/api/v1/me', { as: { cookie } });
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain(`pt_session=${cookie}`);
    expect(setCookie).toContain('HttpOnly');
    const expires = Date.parse(/Expires=([^;]+)/.exec(setCookie)?.[1] ?? '');
    expect(expires).toBeGreaterThan(Date.now() + 13.9 * 24 * 60 * 60 * 1000);
  });

  test('wrong credentials are 401 and the 11th attempt in a minute is 429', async () => {
    t = await createTestApp();
    await t.userAs('viewer', 'ada@example.com');
    const attempt = () =>
      t.request('POST', '/api/v1/auth/login', { json: { email: 'ada@example.com', password: 'wrong password' } });
    expect(await problemOf(await attempt())).toMatchObject({ status: 401, code: 'invalid_credentials' });
    for (let i = 0; i < 8; i++) await attempt();
    expect(await problemOf(await attempt())).toMatchObject({ status: 429, code: 'rate_limited' });
  });

  test('a project token cannot use session-only endpoints', async () => {
    t = await createTestApp();
    const { createProject } = await import('../../src/domain/projects');
    await createProject(t.deps, { slug: 'web', name: 'Web' });
    const { token } = await t.tokenAs('web', ['read', 'write', 'review']);
    expect(await problemOf(await t.request('GET', '/api/v1/me', { as: { token } }))).toMatchObject({
      status: 403,
      code: 'forbidden',
    });
  });

  test('changing the password logs out the other sessions but keeps this one', async () => {
    t = await createTestApp();
    const mine = await t.userAs('viewer', 'ada@example.com');
    const login = await t.request('POST', '/api/v1/auth/login', {
      json: { email: 'ada@example.com', password: PASSWORD },
    });
    const other = /pt_session=([^;]+)/.exec(login.headers.get('set-cookie') ?? '')?.[1] ?? '';
    const res = await t.request('PUT', '/api/v1/me/password', {
      as: mine,
      json: { currentPassword: PASSWORD, newPassword: 'another long password' },
    });
    expect(res.status).toBe(204);
    expect((await t.request('GET', '/api/v1/me', { as: mine })).status).toBe(200);
    expect((await t.request('GET', '/api/v1/me', { as: { cookie: other } })).status).toBe(401);
  });

  test('changing the password requires the current one', async () => {
    t = await createTestApp();
    const { cookie } = await t.userAs('viewer', 'ada@example.com');
    const bad = await t.request('PUT', '/api/v1/me/password', {
      as: { cookie },
      json: { currentPassword: 'wrong', newPassword: 'another long password' },
    });
    expect(await problemOf(bad)).toMatchObject({ status: 403, code: 'invalid_current_password' });
    const ok = await t.request('PUT', '/api/v1/me/password', {
      as: { cookie },
      json: { currentPassword: PASSWORD, newPassword: 'another long password' },
    });
    expect(ok.status).toBe(204);
  });
});
