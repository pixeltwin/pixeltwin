import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createProject } from '../../src/domain/projects';
import { createTestApp, problemOf, type TestApp } from '../helpers/app';
import { BLACK, makePng, WHITE } from '../helpers/png';

const b64 = (png: Uint8Array) => Buffer.from(png).toString('base64');
const page = (logo: number, body: number) =>
  makePng(120, 100, WHITE, [
    { x: 0, y: 0, width: 120, height: 16, color: [120, 120, 120, 255] },
    { x: 8, y: 4, width: logo, height: 8, color: BLACK },
    { x: 10 + body * 20, y: 50, width: 16, height: 16, color: BLACK },
  ]);

interface GroupJson {
  id: string;
  size: number;
  counts: Record<string, number>;
  checks: Array<{ id: string; review: string }>;
}

describe('change group routes', () => {
  let t: TestApp;
  let ci: { token: string };
  let reviewer: { cookie: string; id: string };
  let buildId: string;
  let checkIds: string[];

  async function post(build: string, name: string, png: Uint8Array) {
    const res = await t.request('POST', `/api/v1/builds/${build}/checks`, {
      as: ci,
      json: { name, imageBase64: b64(png) },
    });
    return (await res.json()) as { id: string; groupId: string | null };
  }

  beforeEach(async () => {
    t = await createTestApp();
    await createProject(t.deps, { slug: 'web', name: 'Web' });
    ci = await t.tokenAs('web', ['read', 'write']);
    reviewer = await t.userAs('reviewer');
    const open = async () =>
      ((await (await t.request('POST', '/api/v1/projects/web/builds', { as: ci, json: {} })).json()) as { id: string })
        .id;
    const first = await open();
    for (let i = 0; i < 3; i++) await post(first, `page-${i}`, page(30, i));
    await t.request('POST', `/api/v1/builds/${first}/approve`, { as: reviewer });
    buildId = await open();
    checkIds = [];
    for (let i = 0; i < 3; i++) checkIds.push((await post(buildId, `page-${i}`, page(50, i))).id);
  });

  afterEach(async () => {
    await t.close();
  });

  test('a build lists its groups and every check names its group', async () => {
    const res = await t.request('GET', `/api/v1/builds/${buildId}/groups`, { as: ci });
    expect(res.status).toBe(200);
    const { items } = (await res.json()) as { items: GroupJson[] };
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ size: 3, counts: { pending: 3, approved: 0, rejected: 0, outdated: 0 } });
    const check = (await (await t.request('GET', `/api/v1/checks/${checkIds[0]}`, { as: ci })).json()) as {
      groupId: string;
      diff: { regions: Array<{ fingerprint: string }> };
    };
    expect(check.groupId).toBe(items[0]?.id as string);
    expect(check.diff.regions[0]?.fingerprint).toMatch(/^[0-9a-f]{16}$/);
  });

  test('approve needs the review permission, answers with the new verdict, and reset undoes it', async () => {
    const groups = (await (await t.request('GET', `/api/v1/builds/${buildId}/groups`, { as: ci })).json()) as {
      items: GroupJson[];
    };
    const groupId = groups.items[0]?.id as string;
    const url = `/api/v1/builds/${buildId}/groups/${groupId}`;

    expect((await problemOf(await t.request('POST', `${url}/approve`, { as: ci }))).code).toBe('forbidden');

    const approved = await t.request('POST', `${url}/approve`, { as: reviewer, json: { comment: 'new logo' } });
    expect(approved.status).toBe(200);
    const body = (await approved.json()) as { changed: string[]; skipped: unknown[]; verdict: string };
    expect(body.changed.sort()).toEqual([...checkIds].sort());
    expect(body.skipped).toEqual([]);
    expect(body.verdict).toBe('passed');

    const reset = await t.request('POST', `${url}/reset`, { as: reviewer, json: { checkIds: body.changed } });
    expect(((await reset.json()) as { verdict: string }).verdict).toBe('pending');

    const rejected = (await (await t.request('POST', `${url}/reject`, { as: reviewer })).json()) as {
      verdict: string;
      group: GroupJson;
    };
    expect(rejected.verdict).toBe('rejected');
    expect(rejected.group.counts.rejected).toBe(3);

    const missing = await t.request('POST', `/api/v1/builds/${buildId}/groups/nope/approve`, { as: reviewer });
    expect(await problemOf(missing)).toMatchObject({ status: 404, code: 'group_not_found' });

    await createProject(t.deps, { slug: 'other', name: 'Other' });
    const outsider = await t.tokenAs('other', ['read', 'review']);
    expect((await t.request('GET', `/api/v1/builds/${buildId}/groups`, { as: outsider })).status).toBe(403);
    expect((await t.request('POST', `${url}/approve`, { as: outsider })).status).toBe(403);
  });
});
