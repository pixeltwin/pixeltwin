import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createProject } from '../../src/domain/projects';
import { createTestApp, problemOf, type TestApp } from '../helpers/app';
import { BLACK, makePng, WHITE } from '../helpers/png';
import { openBuild, seedBaseline, submit } from '../helpers/scenario';

type Who = { cookie: string; id: string };

describe('project members (API)', () => {
  let t: TestApp;
  let admin: Who;
  let alice: Who;
  let bob: Who;

  beforeEach(async () => {
    t = await createTestApp();
    await createProject(t.deps, { slug: 'web', name: 'Web' });
    await createProject(t.deps, { slug: 'app', name: 'App' });
    admin = await t.userAs('admin');
    alice = await t.userAs('reviewer', 'alice@example.com', { projects: [] });
    bob = await t.userAs('viewer', 'bob@example.com', { projects: [] });
  });

  afterEach(async () => {
    await t.close();
  });

  const add = (as: Who, slug: string, json: unknown) =>
    t.request('POST', `/api/v1/projects/${slug}/members`, { as, json });
  const slugsOf = async (as: Who) =>
    (
      (await (await t.request('GET', '/api/v1/projects', { as })).json()) as { items: Array<{ slug: string }> }
    ).items.map((p) => p.slug);

  test('admins add, change and remove members; the member sees the project only meanwhile', async () => {
    expect(await slugsOf(alice)).toEqual([]);
    const res = await add(admin, 'web', { email: 'alice@example.com', role: 'viewer' });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ userId: alice.id, email: 'alice@example.com', role: 'viewer' });
    expect(await slugsOf(alice)).toEqual(['web']);
    expect((await t.request('GET', '/api/v1/projects/web', { as: alice })).status).toBe(200);
    expect((await t.request('GET', '/api/v1/projects/app', { as: alice })).status).toBe(404);

    const list = await t.request('GET', '/api/v1/projects/web/members', { as: admin });
    expect(((await list.json()) as { items: Array<{ email: string }> }).items.map((m) => m.email)).toEqual([
      'alice@example.com',
    ]);
    const changed = await t.request('PATCH', `/api/v1/projects/web/members/${alice.id}`, {
      as: admin,
      json: { role: 'maintainer' },
    });
    expect(await changed.json()).toMatchObject({ role: 'maintainer' });
    const projects = await t.request('GET', `/api/v1/users/${alice.id}/projects`, { as: admin });
    expect(await projects.json()).toEqual({ items: [{ slug: 'web', name: 'Web', role: 'maintainer' }] });

    expect((await t.request('DELETE', `/api/v1/projects/web/members/${alice.id}`, { as: admin })).status).toBe(204);
    expect(await slugsOf(alice)).toEqual([]);
    expect((await t.request('GET', '/api/v1/projects/web', { as: alice })).status).toBe(404);
  });

  test('a member gets what their role allows there: 403 when it is short', async () => {
    await add(admin, 'web', { email: 'bob@example.com' });
    const buildId = await openBuild(t.deps, 'web');
    const { check } = await submit(t.deps, buildId, makePng(10, 10));
    expect((await t.request('GET', `/api/v1/checks/${check.id}`, { as: bob })).status).toBe(200);
    const approve = await t.request('POST', `/api/v1/checks/${check.id}/approve`, { as: bob, json: {} });
    expect(await problemOf(approve)).toMatchObject({ status: 403, code: 'forbidden' });
    await t.request('PATCH', `/api/v1/projects/web/members/${bob.id}`, { as: admin, json: { role: 'reviewer' } });
    expect((await t.request('POST', `/api/v1/checks/${check.id}/approve`, { as: bob, json: {} })).status).toBe(200);
    // The screenshot is theirs to see; another project's is not.
    expect((await t.request('GET', `/api/v1/images/${check.imageSha}`, { as: bob })).status).toBe(200);
    expect((await t.request('GET', `/api/v1/images/${check.imageSha}`, { as: alice })).status).toBe(404);
  });

  test('maintainers manage their project, its tokens and members, but cannot delete it', async () => {
    await add(admin, 'web', { email: 'alice@example.com', role: 'maintainer' });
    const patched = await t.request('PATCH', '/api/v1/projects/web', { as: alice, json: { retentionDays: 9 } });
    expect(await patched.json()).toMatchObject({ retentionDays: 9 });
    expect(
      (await t.request('POST', '/api/v1/projects/web/tokens', { as: alice, json: { name: 'CI', scopes: ['read'] } }))
        .status,
    ).toBe(201);
    expect((await add(alice, 'web', { email: 'bob@example.com', role: 'reviewer' })).status).toBe(201);
    expect(await problemOf(await t.request('DELETE', '/api/v1/projects/web', { as: alice }))).toMatchObject({
      status: 403,
      code: 'forbidden',
    });
    expect(
      await problemOf(await t.request('POST', '/api/v1/projects', { as: alice, json: { name: 'New' } })),
    ).toMatchObject({
      status: 403,
      code: 'forbidden',
    });
    // Not their project: as if it did not exist.
    expect((await add(alice, 'app', { email: 'bob@example.com' })).status).toBe(404);
  });

  test('nobody changes their own membership, and admins are never members', async () => {
    await add(admin, 'web', { email: 'alice@example.com', role: 'maintainer' });
    const own = await t.request('PATCH', `/api/v1/projects/web/members/${alice.id}`, {
      as: alice,
      json: { role: 'viewer' },
    });
    expect(await problemOf(own)).toMatchObject({ status: 409, code: 'own_membership' });
    const leave = await t.request('DELETE', `/api/v1/projects/web/members/${alice.id}`, { as: alice });
    expect(await problemOf(leave)).toMatchObject({ status: 409, code: 'own_membership' });
    const adminEmail = 'admin1@example.com';
    expect(await problemOf(await add(alice, 'web', { email: adminEmail }))).toMatchObject({
      status: 409,
      code: 'user_is_admin',
    });
    expect(await problemOf(await add(alice, 'web', { email: 'alice@example.com' }))).toMatchObject({
      status: 409,
      code: 'already_member',
    });
    expect(await problemOf(await add(alice, 'web', { email: 'nobody@example.com' }))).toMatchObject({
      status: 404,
      code: 'user_not_found',
    });
    expect(await problemOf(await add(alice, 'web', { email: 'bob@example.com', role: 'admin' }))).toMatchObject({
      status: 422,
      code: 'validation_failed',
    });
  });

  test('a project visible to everyone opens to every user with their global role', async () => {
    const buildId = await openBuild(t.deps, 'web');
    const { check } = await submit(t.deps, buildId, makePng(10, 10));
    const patched = await t.request('PATCH', '/api/v1/projects/web', { as: admin, json: { visibleToAll: true } });
    expect(await patched.json()).toMatchObject({ visibleToAll: true });
    expect(await slugsOf(bob)).toEqual(['web']);
    expect((await t.request('POST', `/api/v1/checks/${check.id}/approve`, { as: bob, json: {} })).status).toBe(403);
    expect((await t.request('POST', `/api/v1/checks/${check.id}/approve`, { as: alice, json: {} })).status).toBe(200);
    // A membership raises the role there; it never lowers it.
    await add(admin, 'web', { email: 'alice@example.com', role: 'viewer' });
    expect((await t.request('POST', `/api/v1/checks/${check.id}/reset`, { as: alice })).status).toBe(200);
  });

  test('images: a member sees screenshots, baselines and diffs of their projects only', async () => {
    const web = await createProject(t.deps, { slug: 'shop', name: 'Shop' });
    const baseline = await seedBaseline(t.deps, web, makePng(10, 10));
    const buildId = await openBuild(t.deps, 'shop');
    const { check } = await submit(
      t.deps,
      buildId,
      makePng(10, 10, WHITE, [{ x: 1, y: 1, width: 3, height: 3, color: BLACK }]),
    );
    const shas = [baseline.imageSha, check.imageSha, check.diffImageSha ?? ''];
    const status = async (as: Who | { token: string }, sha: string) =>
      (await t.request('GET', `/api/v1/images/${sha}`, { as })).status;
    for (const sha of shas) expect([await status(alice, sha), await status(admin, sha)]).toEqual([404, 200]);
    await add(admin, 'shop', { email: 'alice@example.com', role: 'viewer' });
    for (const sha of shas) expect(await status(alice, sha)).toBe(200);
    for (const sha of shas) expect(await status(bob, sha)).toBe(404);
    await t.request('PATCH', '/api/v1/projects/shop', { as: admin, json: { visibleToAll: true } });
    for (const sha of shas) expect(await status(bob, sha)).toBe(200);
    const other = await t.tokenAs('app', ['read']);
    for (const sha of shas) expect(await status(other, sha)).toBe(404);
  });

  test('thumbnails: the same access as the image, for users and tokens', async () => {
    await createProject(t.deps, { slug: 'shop', name: 'Shop' });
    const buildId = await openBuild(t.deps, 'shop');
    const { check } = await submit(
      t.deps,
      buildId,
      makePng(400, 400, WHITE, [{ x: 1, y: 1, width: 30, height: 30, color: BLACK }]),
    );
    const urls = [
      `/api/v1/images/${check.imageSha}/thumb?w=160`,
      `/api/v1/images/${check.imageSha}/thumb?w=160&crop=0,0,100,100`,
      `/api/v1/images/${check.imageSha}/thumb?w=960&fit=top`,
      `/api/v1/images/${check.imageSha}/thumb?w=960&mode=diff&crop=0,0,100,100`,
    ];
    const status = async (as: Who | { token: string }, url: string) => (await t.request('GET', url, { as })).status;
    for (const url of urls) {
      const outside = await t.request('GET', url, { as: alice });
      expect(await problemOf(outside)).toMatchObject({ status: 404, code: 'image_not_found' });
    }
    await add(admin, 'shop', { email: 'alice@example.com', role: 'viewer' });
    for (const url of urls) expect(await status(alice, url)).toBe(200);
    for (const url of urls) expect(await status(bob, url)).toBe(404);
    for (const url of urls) expect(await status(admin, url)).toBe(200);
    const [own, other] = [await t.tokenAs('shop', ['read']), await t.tokenAs('app', ['read'])];
    for (const url of urls) expect([await status(own, url), await status(other, url)]).toEqual([200, 404]);
  });

  test('maintainers and admins search users to add; members with less, outsiders and tokens cannot', async () => {
    const search = (as: Who | { token: string }, q: string, slug = 'web') =>
      t.request('GET', `/api/v1/projects/${slug}/members/candidates?q=${encodeURIComponent(q)}`, { as });
    const found = await search(admin, 'EXAMPLE');
    expect(found.status).toBe(200);
    expect(await found.json()).toEqual({
      items: [
        { id: alice.id, email: 'alice@example.com', role: 'reviewer' },
        { id: bob.id, email: 'bob@example.com', role: 'viewer' },
      ],
    });
    await add(admin, 'web', { email: 'alice@example.com', role: 'maintainer' });
    const byMaintainer = (await (await search(alice, 'example')).json()) as { items: Array<{ email: string }> };
    expect(byMaintainer.items.map((u) => u.email)).toEqual(['bob@example.com']);
    expect(await problemOf(await search(alice, 'b'))).toMatchObject({ status: 422, code: 'validation_failed' });
    // Not their project: as if it did not exist, whatever the query.
    expect((await search(alice, 'example', 'app')).status).toBe(404);
    expect((await search(alice, 'b', 'app')).status).toBe(404);
    await add(admin, 'web', { email: 'bob@example.com', role: 'reviewer' });
    expect(await problemOf(await search(bob, 'example'))).toMatchObject({ status: 403, code: 'forbidden' });
    const token = await t.tokenAs('web', ['read', 'write', 'review']);
    expect(await problemOf(await search(token, 'example'))).toMatchObject({ status: 403, code: 'forbidden' });
  });

  test('tokens keep working as before: their own project only', async () => {
    const web = await t.tokenAs('web', ['read']);
    expect((await t.request('GET', '/api/v1/projects/web', { as: web })).status).toBe(200);
    expect(await problemOf(await t.request('GET', '/api/v1/projects/app', { as: web }))).toMatchObject({
      status: 403,
      code: 'token_project_mismatch',
    });
    expect(await problemOf(await t.request('GET', '/api/v1/projects/web/members', { as: web }))).toMatchObject({
      status: 403,
      code: 'forbidden',
    });
  });
});
