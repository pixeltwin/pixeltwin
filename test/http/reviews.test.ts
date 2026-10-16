import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createProject } from '../../src/domain/projects';
import { snapshotKey } from '../../src/domain/snapshot-key';
import { createTestApp, problemOf, type TestApp } from '../helpers/app';
import { BLACK, makePng, WHITE } from '../helpers/png';

const white = makePng(100, 100);
const withSquare = makePng(100, 100, WHITE, [{ x: 10, y: 10, width: 10, height: 10, color: BLACK }]);
const b64 = (png: Uint8Array) => Buffer.from(png).toString('base64');

describe('review, baseline, promotion and image routes', () => {
  let t: TestApp;
  let ci: { token: string };
  let reviewer: { cookie: string; id: string };

  beforeEach(async () => {
    t = await createTestApp();
    await createProject(t.deps, { slug: 'web', name: 'Web' });
    ci = await t.tokenAs('web', ['read', 'write']);
    reviewer = await t.userAs('reviewer');
  });

  afterEach(async () => {
    await t.close();
  });

  async function check(branch: string, png: Uint8Array, name = 'home') {
    const build = (await (
      await t.request('POST', '/api/v1/projects/web/builds', { as: ci, json: { branch } })
    ).json()) as {
      id: string;
    };
    const res = await t.request('POST', `/api/v1/builds/${build.id}/checks`, {
      as: ci,
      json: { name, imageBase64: b64(png) },
    });
    return {
      buildId: build.id,
      check: (await res.json()) as { id: string; imageSha: string; diffImageSha: string | null },
    };
  }

  test('reject with a comment, then approve; actor is the reviewer', async () => {
    const { check: c } = await check('main', white);
    const rejected = await t.request('POST', `/api/v1/checks/${c.id}/reject`, {
      as: reviewer,
      json: { comment: 'logo is broken' },
    });
    expect(await rejected.json()).toMatchObject({
      review: 'rejected',
      reviewComment: 'logo is broken',
      reviewedBy: reviewer.id,
    });
    const approved = await t.request('POST', `/api/v1/checks/${c.id}/approve`, { as: reviewer });
    expect(await approved.json()).toMatchObject({ review: 'approved' });
    const again = await t.request('POST', `/api/v1/checks/${c.id}/reject`, { as: reviewer });
    expect(await problemOf(again)).toMatchObject({ status: 409, code: 'check_not_reviewable' });
  });

  test('the review history lists who approved, rejected or undid, newest first', async () => {
    const reviewerToken = await t.tokenAs('web', ['read', 'review']);
    const { check: c } = await check('main', white);
    await t.request('POST', `/api/v1/checks/${c.id}/approve`, { as: reviewer, json: { comment: 'fine' } });
    await t.request('POST', `/api/v1/checks/${c.id}/reset`, { as: reviewerToken });
    await t.request('POST', `/api/v1/checks/${c.id}/reject`, { as: reviewer });

    const res = await t.request('GET', `/api/v1/checks/${c.id}/reviews`, { as: ci });
    expect(res.status).toBe(200);
    const { items } = (await res.json()) as { items: Array<Record<string, unknown>> };
    expect(items.map(({ action, actor, comment }) => ({ action, actor, comment }))).toEqual([
      { action: 'rejected', actor: reviewer.id, comment: null },
      { action: 'reset', actor: reviewerToken.id, comment: null },
      { action: 'approved', actor: reviewer.id, comment: 'fine' },
    ]);
    expect(items[0]).toMatchObject({ checkId: c.id, createdAt: expect.any(Number) });

    await createProject(t.deps, { slug: 'other', name: 'Other' });
    const outsider = await t.tokenAs('other', ['read']);
    expect((await t.request('GET', `/api/v1/checks/${c.id}/reviews`, { as: outsider })).status).toBe(403);
    expect((await t.request('GET', '/api/v1/checks/chk_missing/reviews', { as: reviewer })).status).toBe(404);
    const doc = (await (await t.request('GET', '/openapi.json')).json()) as {
      paths: Record<string, { get?: Record<string, unknown> }>;
    };
    expect(doc.paths['/api/v1/checks/{id}/reviews']?.get?.['x-permission']).toBe('project.read');
  });

  test('reset undoes a review; it needs the review permission', async () => {
    const reviewerToken = await t.tokenAs('web', ['read', 'review']);
    const { check: first } = await check('main', white);
    await t.request('POST', `/api/v1/checks/${first.id}/approve`, { as: reviewerToken });
    const reset = await t.request('POST', `/api/v1/checks/${first.id}/reset`, { as: reviewerToken });
    expect(reset.status).toBe(200);
    expect(await reset.json()).toMatchObject({ id: first.id, review: 'pending', reviewedBy: null });
    expect(
      await problemOf(await t.request('POST', `/api/v1/checks/${first.id}/reset`, { as: reviewerToken })),
    ).toMatchObject({
      status: 409,
      code: 'check_not_reviewable',
    });
    expect((await t.request('POST', `/api/v1/checks/${first.id}/reset`, { as: ci })).status).toBe(403);
    const doc = (await (await t.request('GET', '/openapi.json')).json()) as { paths: Record<string, unknown> };
    expect(doc.paths['/api/v1/checks/{id}/reset']).toBeDefined();
  });

  test('a write-only token cannot review', async () => {
    const { check: c } = await check('main', white);
    expect(await problemOf(await t.request('POST', `/api/v1/checks/${c.id}/approve`, { as: ci }))).toMatchObject({
      status: 403,
      code: 'forbidden',
    });
  });

  test('approve all reports how many it approved', async () => {
    const { buildId } = await check('main', white, 'a');
    const res = await t.request('POST', `/api/v1/builds/${buildId}/approve`, { as: reviewer });
    expect(await res.json()).toEqual({ approved: 1 });
  });

  test('promotion of a branch with a slash, then baseline history', async () => {
    const { check: c } = await check('feature/login', white);
    await t.request('POST', `/api/v1/checks/${c.id}/approve`, { as: reviewer });
    const promoted = await t.request('POST', '/api/v1/projects/web/branches/feature%2Flogin/promote', { as: ci });
    expect(await promoted.json()).toEqual({ promoted: 1 });

    const key = snapshotKey('home', {});
    const history = (await (
      await t.request('GET', `/api/v1/projects/web/snapshots/${key}/baselines`, { as: ci })
    ).json()) as {
      items: Array<{ branch: string }>;
    };
    expect(history.items.map((b) => b.branch)).toEqual(['main', 'feature/login']);
    const mainOnly = (await (
      await t.request('GET', `/api/v1/projects/web/snapshots/${key}/baselines?branch=main`, { as: ci })
    ).json()) as { items: unknown[] };
    expect(mainOnly.items).toHaveLength(1);
  });

  test('the promotion candidates, then promoting only some of them', async () => {
    for (const name of ['home', 'cart']) {
      const { check: c } = await check('feature/login', withSquare, name);
      await t.request('POST', `/api/v1/checks/${c.id}/approve`, { as: reviewer });
    }
    const listed = await t.request('GET', '/api/v1/projects/web/branches/feature%2Flogin/promote', { as: ci });
    const { items } = (await listed.json()) as { items: Array<{ snapshotKey: string; name: string }> };
    expect(items.map((i) => i.name)).toEqual(['cart', 'home']);

    const some = await t.request('POST', '/api/v1/projects/web/branches/feature%2Flogin/promote', {
      as: ci,
      json: { snapshotKeys: [snapshotKey('cart', {})] },
    });
    expect(await some.json()).toEqual({ promoted: 1 });
    const left = (await (
      await t.request('GET', '/api/v1/projects/web/branches/feature%2Flogin/promote', { as: ci })
    ).json()) as { items: Array<{ name: string }> };
    expect(left.items.map((i) => i.name)).toEqual(['home']);

    const bad = await t.request('POST', '/api/v1/projects/web/branches/feature%2Flogin/promote', {
      as: ci,
      json: { snapshotKeys: ['nope'] },
    });
    expect(await problemOf(bad)).toMatchObject({ status: 422, code: 'snapshot_not_on_branch' });
    const doc = (await (await t.request('GET', '/openapi.json')).json()) as {
      paths: Record<string, Record<string, Record<string, unknown>>>;
    };
    expect(doc.paths['/api/v1/projects/{slug}/branches/{branch}/promote']?.get?.['x-permission']).toBe('project.read');
  });

  test('promoting the main branch is a 400', async () => {
    const res = await t.request('POST', '/api/v1/projects/web/branches/main/promote', { as: ci });
    expect(await problemOf(res)).toMatchObject({ status: 400, code: 'invalid_promotion' });
  });

  test('images are served with immutable caching, only to callers who may see them', async () => {
    const { check: c } = await check('main', white);
    await t.request('POST', `/api/v1/checks/${c.id}/approve`, { as: reviewer });
    const { check: changed } = await check('main', withSquare);

    for (const sha of [c.imageSha, changed.diffImageSha]) {
      const res = await t.request('GET', `/api/v1/images/${sha}`, { as: ci });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('image/png');
      expect(res.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
      expect(new Uint8Array(await res.arrayBuffer()).slice(1, 4)).toEqual(new Uint8Array([0x50, 0x4e, 0x47]));
    }
    expect((await t.request('GET', `/api/v1/images/${c.imageSha}`, { as: reviewer })).status).toBe(200);

    await createProject(t.deps, { slug: 'app', name: 'App' });
    const other = await t.tokenAs('app', ['read']);
    expect(await problemOf(await t.request('GET', `/api/v1/images/${c.imageSha}`, { as: other }))).toMatchObject({
      status: 404,
      code: 'image_not_found',
    });
    expect((await t.request('GET', `/api/v1/images/${c.imageSha}`)).status).toBe(401);
    expect((await t.request('GET', '/api/v1/images/..%2F..%2Fetc%2Fpasswd', { as: ci })).status).toBe(404);
  });
});
