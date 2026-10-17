import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createProject } from '../../src/domain/projects';
import { createTestApp, problemOf, type TestApp } from '../helpers/app';
import { BLACK, makePng, WHITE } from '../helpers/png';

const white = makePng(100, 100);
const withSquare = makePng(100, 100, WHITE, [{ x: 10, y: 10, width: 10, height: 10, color: BLACK }]);
const b64 = (png: Uint8Array) => Buffer.from(png).toString('base64');

interface CheckBody {
  id: string;
  result: string;
  review: string;
  imageSha: string;
  diff: { summary: string; regions: unknown[] } | null;
  links: { image: string; baseline: string | null; diff: string | null; review: string };
}

describe('build and check routes', () => {
  let t: TestApp;
  let ci: { token: string };
  let reviewer: { cookie: string };

  beforeEach(async () => {
    t = await createTestApp();
    await createProject(t.deps, { slug: 'web', name: 'Web' });
    ci = await t.tokenAs('web', ['read', 'write']);
    reviewer = await t.userAs('reviewer');
  });

  afterEach(async () => {
    await t.close();
  });

  async function openBuild(json: Record<string, unknown> = {}): Promise<string> {
    const res = await t.request('POST', '/api/v1/projects/web/builds', { as: ci, json });
    return ((await res.json()) as { id: string }).id;
  }

  function postJson(buildId: string, png: Uint8Array, meta: Record<string, unknown> = {}) {
    return t.request('POST', `/api/v1/builds/${buildId}/checks`, {
      as: ci,
      json: { name: 'home', ...meta, imageBase64: b64(png) },
    });
  }

  function postMultipart(buildId: string, png: Uint8Array<ArrayBuffer>, meta: Record<string, unknown> = {}) {
    const form = new FormData();
    form.set('image', new File([png], 'shot.png', { type: 'image/png' }));
    form.set('meta', JSON.stringify({ name: 'home', ...meta }));
    return t.request('POST', `/api/v1/builds/${buildId}/checks`, { as: ci, body: form });
  }

  test('build creation is idempotent on externalId: 201, then 200', async () => {
    const first = await t.request('POST', '/api/v1/projects/web/builds', { as: ci, json: { externalId: 'run-1' } });
    const second = await t.request('POST', '/api/v1/projects/web/builds', { as: ci, json: { externalId: 'run-1' } });
    expect([first.status, second.status]).toEqual([201, 200]);
    expect(((await first.json()) as { id: string }).id).toBe(((await second.json()) as { id: string }).id);
  });

  test('the full CI flow: new → approve → unchanged → changed, with links', async () => {
    const first = await openBuild();
    const created = await postMultipart(first, white);
    expect(created.status).toBe(201);
    const check = (await created.json()) as CheckBody;
    expect(check).toMatchObject({ result: 'new', review: 'pending', diff: null });
    expect(check.links).toEqual({
      image: `/api/v1/images/${check.imageSha}`,
      baseline: null,
      diff: null,
      review: `/ui/checks/${check.id}`,
    });
    expect((await t.request('POST', `/api/v1/checks/${check.id}/approve`, { as: reviewer })).status).toBe(200);
    const finalized = await t.request('POST', `/api/v1/builds/${first}/finalize`, { as: ci });
    expect(await finalized.json()).toMatchObject({ state: 'finalized', verdict: 'passed' });

    const second = await openBuild();
    expect(((await (await postJson(second, white)).json()) as CheckBody).result).toBe('unchanged');
    const changed = (await (await postJson(second, withSquare, { name: 'home' })).json()) as CheckBody;
    expect(changed.result).toBe('changed');
    expect(changed.diff?.summary).toBe(
      '1 changed region; largest 10×10 at (10,10) in top-left; 1.00% of pixels changed.',
    );
    expect(changed.links.diff).toMatch(/^\/api\/v1\/images\/[0-9a-f]{64}$/);
    expect(changed.links.baseline).toBe(check.links.image);
  });

  test('resubmitting a snapshot answers 200 with the same check', async () => {
    const build = await openBuild();
    const first = (await (await postJson(build, white)).json()) as CheckBody;
    const again = await postJson(build, white);
    expect(again.status).toBe(200);
    expect(((await again.json()) as CheckBody).id).toBe(first.id);
  });

  test('upload problems are explicit', async () => {
    const build = await openBuild();
    expect(await problemOf(await postJson(build, new Uint8Array([1, 2, 3])))).toMatchObject({
      status: 422,
      code: 'invalid_image',
    });
    const badMeta = await t.request('POST', `/api/v1/builds/${build}/checks`, {
      as: ci,
      json: { name: '', colour: 'red', imageBase64: b64(white) },
    });
    expect((await problemOf(badMeta)).errors?.map((e) => e.path)).toContain('name');
    const noImage = await t.request('POST', `/api/v1/builds/${build}/checks`, { as: ci, json: { name: 'x' } });
    expect((await problemOf(noImage)).errors?.[0]?.path).toBe('imageBase64');
    const plain = await t.request('POST', `/api/v1/builds/${build}/checks`, {
      as: ci,
      body: 'x',
      headers: { 'content-type': 'text/plain' },
    });
    expect(await problemOf(plain)).toMatchObject({ status: 415, code: 'unsupported_media_type' });
    const form = new FormData();
    form.set('meta', '{"name":"x"}');
    const missingPart = await t.request('POST', `/api/v1/builds/${build}/checks`, { as: ci, body: form });
    expect((await problemOf(missingPart)).errors?.map((e) => e.path)).toEqual(['image']);
  });

  test('a finalized build refuses checks with 409', async () => {
    const build = await openBuild();
    await t.request('POST', `/api/v1/builds/${build}/finalize`, { as: ci });
    expect(await problemOf(await postJson(build, white))).toMatchObject({ status: 409, code: 'build_finalized' });
  });

  test('a server with too many diffs waiting answers 503 with Retry-After, and takes uploads again later', async () => {
    const busy = await createTestApp({ diffQueueMax: 40 });
    try {
      await createProject(busy.deps, { slug: 'web', name: 'Web' });
      const token = await busy.tokenAs('web', ['write']);
      const res = await busy.request('POST', '/api/v1/projects/web/builds', { as: token, json: {} });
      const { id } = (await res.json()) as { id: string };
      const post = () =>
        busy.request('POST', `/api/v1/builds/${id}/checks`, {
          as: token,
          json: { name: 'home', imageBase64: b64(white) },
        });

      let backlog = 40;
      busy.deps.diffBacklog = () => backlog;
      const refused = await post();
      expect(await problemOf(refused)).toMatchObject({ status: 503, code: 'server_busy' });
      expect(Number(refused.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);

      backlog = 39;
      expect((await post()).status).toBe(201);
    } finally {
      await busy.close();
    }
  });

  test('DIFF_QUEUE_MAX=0 never refuses uploads', async () => {
    const open = await createTestApp({ diffQueueMax: 0 });
    try {
      await createProject(open.deps, { slug: 'web', name: 'Web' });
      const token = await open.tokenAs('web', ['write']);
      const res = await open.request('POST', '/api/v1/projects/web/builds', { as: token, json: {} });
      const { id } = (await res.json()) as { id: string };
      open.deps.diffBacklog = () => 10_000;
      const posted = await open.request('POST', `/api/v1/builds/${id}/checks`, {
        as: token,
        json: { name: 'home', imageBase64: b64(white) },
      });
      expect(posted.status).toBe(201);
    } finally {
      await open.close();
    }
  });

  test('an oversized upload is refused before it is parsed', async () => {
    const small = await createTestApp({ maxImageBytes: 2048 });
    try {
      await createProject(small.deps, { slug: 'web', name: 'Web' });
      const token = await small.tokenAs('web', ['write']);
      const res = await small.request('POST', '/api/v1/projects/web/builds', { as: token, json: {} });
      const { id } = (await res.json()) as { id: string };
      const big = await small.request('POST', `/api/v1/builds/${id}/checks`, {
        as: token,
        json: { name: 'x', imageBase64: 'A'.repeat(400_000) },
      });
      expect(await problemOf(big)).toMatchObject({ status: 413, code: 'payload_too_large' });
    } finally {
      await small.close();
    }
  });

  test('lists builds and checks with filters', async () => {
    const build = await openBuild({ branch: 'feature/x' });
    await postJson(build, white, { name: 'a' });
    await postJson(build, white, { name: 'b' });
    const builds = (await (
      await t.request('GET', '/api/v1/projects/web/builds?branch=feature%2Fx', { as: ci })
    ).json()) as {
      items: Array<{ id: string; counts: { total: number } }>;
    };
    expect(builds.items.map((b) => [b.id, b.counts.total])).toEqual([[build, 2]]);
    const page = (await (
      await t.request('GET', `/api/v1/builds/${build}/checks?limit=1&review=pending`, { as: ci })
    ).json()) as {
      items: CheckBody[];
      nextCursor: string | null;
    };
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).not.toBeNull();
    const bad = await t.request('GET', `/api/v1/builds/${build}/checks?result=weird`, { as: ci });
    expect(await problemOf(bad)).toMatchObject({ status: 422, code: 'validation_failed' });
  });
});
