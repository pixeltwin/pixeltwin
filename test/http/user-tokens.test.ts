import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { getCheck } from '../../src/domain/checks';
import { createProject } from '../../src/domain/projects';
import { createTestApp, PASSWORD, problemOf, type TestApp } from '../helpers/app';
import { BLACK, makePng, WHITE } from '../helpers/png';
import { openBuild, seedBaseline, submit } from '../helpers/scenario';

const white = makePng(100, 100);
const withSquare = makePng(100, 100, WHITE, [{ x: 10, y: 10, width: 10, height: 10, color: BLACK }]);

// A personal token from email and password, for pages served from elsewhere (a test report)
// that act as the user: no cookie, so it is sent as a Bearer token, cross-origin.
describe('personal tokens (POST /api/v1/auth/token)', () => {
  let t: TestApp;

  beforeEach(async () => {
    t = await createTestApp();
  });

  afterEach(async () => {
    await t.close();
  });

  const tokenFor = async (email: string, password = PASSWORD) =>
    t.request('POST', '/api/v1/auth/token', { json: { email, password } });

  async function changedCheck() {
    const project = await createProject(t.deps, { slug: 'web', name: 'Web' });
    await seedBaseline(t.deps, project, white);
    const buildId = await openBuild(t.deps, 'web');
    return (await submit(t.deps, buildId, withSquare)).check;
  }

  test('email and password give a pu_ token that acts as the user, with their role', async () => {
    const check = await changedCheck();
    await t.userAs('reviewer', 'rev@example.com');
    const res = await tokenFor('rev@example.com');
    expect(res.status).toBe(201);
    const body = (await res.json()) as { token: string; expiresAt: number; user: { email: string; role: string } };
    expect(body.token).toMatch(/^pu_/);
    expect(body.expiresAt).toBeGreaterThan(Date.now());
    expect(body.user).toMatchObject({ email: 'rev@example.com', role: 'reviewer' });
    // No cookie: the token is the credential.
    expect(res.headers.get('set-cookie')).toBeNull();

    const approve = await t.request('POST', `/api/v1/checks/${check.id}/approve`, {
      headers: { authorization: `Bearer ${body.token}`, origin: 'null' },
    });
    expect(approve.status).toBe(200);
    expect((await getCheck(t.deps, check.id)).review).toBe('approved');
    const me = await t.request('GET', '/api/v1/me', { headers: { authorization: `Bearer ${body.token}` } });
    expect(await me.json()).toMatchObject({ email: 'rev@example.com' });
  });

  test("a viewer's token cannot approve, and a wrong password or an unknown token is a 401", async () => {
    const check = await changedCheck();
    await t.userAs('viewer', 'view@example.com');
    const { token } = (await (await tokenFor('view@example.com')).json()) as { token: string };
    const approve = await t.request('POST', `/api/v1/checks/${check.id}/approve`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(approve.status).toBe(403);
    expect(await problemOf(await tokenFor('view@example.com', 'wrong password'))).toMatchObject({
      status: 401,
      code: 'invalid_credentials',
    });
    const unknown = await t.request('GET', '/api/v1/me', { headers: { authorization: 'Bearer pu_nope' } });
    expect(await problemOf(unknown)).toMatchObject({ status: 401, code: 'invalid_token' });
  });

  test('changing the password ends the personal tokens too', async () => {
    const reviewer = await t.userAs('reviewer', 'rev@example.com');
    const { token } = (await (await tokenFor('rev@example.com')).json()) as { token: string };
    const res = await t.request('PUT', '/api/v1/me/password', {
      as: reviewer,
      json: { currentPassword: PASSWORD, newPassword: 'another long password' },
    });
    expect(res.status).toBe(204);
    const me = await t.request('GET', '/api/v1/me', { headers: { authorization: `Bearer ${token}` } });
    expect(me.status).toBe(401);
  });

  test('the API answers cross-origin: preflights, and every response (errors too) allows any origin', async () => {
    const preflight = await t.request('OPTIONS', '/api/v1/auth/token', {
      headers: {
        origin: 'null',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type',
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe('*');
    expect(preflight.headers.get('access-control-allow-headers')).toBe('authorization, content-type');
    expect(preflight.headers.get('access-control-allow-methods')).toContain('POST');
    // Never with credentials: a cross-origin page cannot ride on someone's session cookie.
    expect(preflight.headers.get('access-control-allow-credentials')).toBeNull();
    const failed = await t.request('GET', '/api/v1/me', {
      headers: { authorization: 'Bearer pu_nope', origin: 'null' },
    });
    expect(failed.headers.get('access-control-allow-origin')).toBe('*');
  });
});
