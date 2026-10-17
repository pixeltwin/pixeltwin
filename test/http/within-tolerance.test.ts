import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createProject } from '../../src/domain/projects';
import { createTestApp, type TestApp } from '../helpers/app';
import { BLACK, makePng, WHITE } from '../helpers/png';

const white = makePng(100, 100);
const drift = makePng(100, 100, WHITE, [{ x: 10, y: 10, width: 10, height: 10, color: BLACK }]);
const b64 = (png: Uint8Array) => Buffer.from(png).toString('base64');

describe('API: checks within the tolerance', () => {
  let t: TestApp;
  let ci: { token: string };
  let agent: { token: string };

  beforeEach(async () => {
    t = await createTestApp();
    await createProject(t.deps, { slug: 'web', name: 'Web', tolerancePercent: 2 });
    ci = await t.tokenAs('web', ['read', 'write']);
    agent = await t.tokenAs('web', ['read', 'review']);
  });

  afterEach(async () => {
    await t.close();
  });

  async function build(): Promise<string> {
    const res = await t.request('POST', '/api/v1/projects/web/builds', { as: ci, json: {} });
    return ((await res.json()) as { id: string }).id;
  }
  async function post(buildId: string, png: Uint8Array, meta: Record<string, unknown> = {}) {
    const res = await t.request('POST', `/api/v1/builds/${buildId}/checks`, {
      as: ci,
      json: { name: 'home', ...meta, imageBase64: b64(png) },
    });
    return (await res.json()) as Record<string, unknown> & { id: string };
  }

  test('the check, the build counts and the filter say which passed within the tolerance', async () => {
    const first = await build();
    for (const name of ['home', 'about']) await post(first, white, { name });
    await t.request('POST', `/api/v1/builds/${first}/approve`, { as: agent, json: {} });
    const second = await build();
    const home = await post(second, drift);
    const about = await post(second, white, { name: 'about' });
    expect(home).toMatchObject({
      result: 'unchanged',
      review: 'none',
      withinTolerance: true,
      tolerancePercent: 2,
      diff: { percent: 1, tolerancePercent: 2 },
      links: { diff: expect.stringMatching(/^\/api\/v1\/images\//) },
    });
    expect(about).toMatchObject({ withinTolerance: false, links: { diff: null } });

    const counts = (
      (await (await t.request('GET', `/api/v1/builds/${second}`, { as: ci })).json()) as {
        counts: Record<string, number>;
      }
    ).counts;
    expect(counts).toMatchObject({ withinTolerance: 1, withinTolerancePassed: 1 });

    const listed = (await (
      await t.request('GET', `/api/v1/builds/${second}/checks?withinTolerance=true`, { as: ci })
    ).json()) as { items: Array<{ id: string }> };
    expect(listed.items.map((c) => c.id)).toEqual([home.id]);
    const all = (await (
      await t.request('GET', `/api/v1/builds/${second}/checks?withinTolerance=false`, { as: ci })
    ).json()) as {
      items: unknown[];
    };
    expect(all.items).toHaveLength(2);
    expect((await t.request('GET', `/api/v1/builds/${second}/checks?withinTolerance=yes`, { as: ci })).status).toBe(
      422,
    );

    // A token approves it as the new baseline; reset puts it back to passed.
    const approved = await t.request('POST', `/api/v1/checks/${home.id}/approve`, {
      as: agent,
      json: { reason: 'drift' },
    });
    expect(await approved.json()).toMatchObject({ review: 'approved', outcome: 'applied' });
    const reset = await t.request('POST', `/api/v1/checks/${home.id}/reset`, { as: agent });
    expect(await reset.json()).toMatchObject({ review: 'none', withinTolerance: true });
  });

  test('the project setting and the SDK meta make one wait for review', async () => {
    const admin = await t.userAs('admin');
    const patched = await t.request('PATCH', '/api/v1/projects/web', {
      as: admin,
      json: { reviewWithinTolerance: true },
    });
    expect(await patched.json()).toMatchObject({ reviewWithinTolerance: true });
    const first = await build();
    for (const name of ['home', 'about']) await post(first, white, { name });
    await t.request('POST', `/api/v1/builds/${first}/approve`, { as: agent, json: {} });
    const second = await build();
    expect(await post(second, drift)).toMatchObject({ review: 'pending', withinTolerance: true });
    expect(await post(second, drift, { name: 'about', reviewWithinTolerance: false })).toMatchObject({
      review: 'none',
    });
    const res = await t.request('GET', `/api/v1/builds/${second}`, { as: ci });
    expect(await res.json()).toMatchObject({ verdict: 'pending' });
  });
});
