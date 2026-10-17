import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createProject } from '../../src/domain/projects';
import { createTestApp, problemOf, type TestApp } from '../helpers/app';
import { BLACK, makePng, WHITE } from '../helpers/png';

const white = makePng(100, 100);
const withClock = makePng(100, 100, WHITE, [{ x: 10, y: 10, width: 10, height: 10, color: BLACK }]);
const b64 = (png: Uint8Array) => Buffer.from(png).toString('base64');

describe('area routes', () => {
  let t: TestApp;
  let ci: { token: string; id: string };
  let reviewer: { cookie: string; id: string };

  beforeEach(async () => {
    t = await createTestApp();
    await createProject(t.deps, { slug: 'web', name: 'Web' });
    ci = await t.tokenAs('web', ['read', 'write', 'review']);
    reviewer = await t.userAs('reviewer');
  });

  afterEach(async () => {
    await t.close();
  });

  async function post(png: Uint8Array) {
    const build = (await (await t.request('POST', '/api/v1/projects/web/builds', { as: ci, json: {} })).json()) as {
      id: string;
    };
    const res = await t.request('POST', `/api/v1/builds/${build.id}/checks`, {
      as: ci,
      json: { name: 'home', imageBase64: b64(png) },
    });
    return (await res.json()) as { id: string; result: string };
  }

  test('reviewers draw areas on a check; the check is compared again at once', async () => {
    const first = await post(white);
    await t.request('POST', `/api/v1/checks/${first.id}/approve`, { as: ci });
    const check = await post(withClock);
    expect(check.result).toBe('changed');

    const created = await t.request('POST', `/api/v1/checks/${check.id}/areas`, {
      as: reviewer,
      json: { kind: 'ignore', x: 5, y: 5, width: 20, height: 20 },
    });
    expect(created.status).toBe(201);
    const body = (await created.json()) as { area: { id: string; kind: string }; check: { result: string } };
    expect(body.area.kind).toBe('ignore');
    expect(body.check.result).toBe('unchanged');

    const listed = await t.request('GET', `/api/v1/checks/${check.id}/areas`, { as: ci });
    expect(((await listed.json()) as { items: unknown[] }).items).toHaveLength(1);

    const moved = await t.request('PATCH', `/api/v1/checks/${check.id}/areas/${body.area.id}`, {
      as: reviewer,
      json: { x: 50, y: 50, width: 20, height: 20 },
    });
    expect(moved.status).toBe(200);
    const after = (await moved.json()) as { area: { id: string; x: number }; check: { result: string } };
    expect(after.area).toMatchObject({ id: body.area.id, x: 50 });
    expect(after.check.result).toBe('changed');

    const removed = await t.request('DELETE', `/api/v1/checks/${check.id}/areas/${body.area.id}`, { as: reviewer });
    expect(removed.status).toBe(200);
    expect(((await removed.json()) as { result: string }).result).toBe('changed');
    expect(
      (
        await t.request('PATCH', `/api/v1/checks/${check.id}/areas/${body.area.id}`, {
          as: reviewer,
          json: { x: 0, y: 0, width: 5, height: 5 },
        })
      ).status,
    ).toBe(404);
  });

  test('viewers and write-only tokens cannot draw; bad areas are 422', async () => {
    const check = await post(white);
    const viewer = await t.userAs('viewer');
    const writer = await t.tokenAs('web', ['read', 'write']);
    const area = { kind: 'ignore', x: 0, y: 0, width: 10, height: 10 };
    expect((await t.request('POST', `/api/v1/checks/${check.id}/areas`, { as: viewer, json: area })).status).toBe(403);
    expect((await t.request('POST', `/api/v1/checks/${check.id}/areas`, { as: writer, json: area })).status).toBe(403);
    const bad = await t.request('POST', `/api/v1/checks/${check.id}/areas`, {
      as: reviewer,
      json: { ...area, width: 0 },
    });
    expect(await problemOf(bad)).toMatchObject({ status: 422, code: 'validation_failed' });
    expect((await t.request('DELETE', `/api/v1/checks/${check.id}/areas/are_missing`, { as: reviewer })).status).toBe(
      404,
    );
    const doc = (await (await t.request('GET', '/openapi.json')).json()) as {
      paths: Record<string, Record<string, Record<string, unknown>>>;
    };
    expect(doc.paths['/api/v1/checks/{id}/areas']?.post?.['x-permission']).toBe('check.review');
    expect(doc.paths['/api/v1/checks/{id}/areas/{areaId}']?.patch?.['x-permission']).toBe('check.review');
    const rect = { x: 0, y: 0, width: 10, height: 10 };
    expect(
      (await t.request('PATCH', `/api/v1/checks/${check.id}/areas/are_x`, { as: viewer, json: rect })).status,
    ).toBe(403);
  });

  test('POST /checks/{id}/areas/ignore-changes ignores every change at once', async () => {
    const first = await post(white);
    await t.request('POST', `/api/v1/checks/${first.id}/approve`, { as: ci });
    const check = await post(withClock);
    const res = await t.request('POST', `/api/v1/checks/${check.id}/areas/ignore-changes`, { as: reviewer });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { areas: { kind: string; x: number }[]; check: { result: string } };
    expect(body.areas.map((a) => [a.kind, a.x])).toEqual([['ignore', 6]]);
    expect(body.check.result).toBe('unchanged');
    const again = await t.request('POST', `/api/v1/checks/${check.id}/areas/ignore-changes`, { as: reviewer });
    expect((await problemOf(again)).code).toBe('no_changes');
  });
  test('DELETE /checks/{id}/areas deletes every area of the snapshot and compares again', async () => {
    const first = await post(white);
    await t.request('POST', `/api/v1/checks/${first.id}/approve`, { as: ci });
    const check = await post(withClock);
    for (const x of [0, 20]) {
      const res = await t.request('POST', `/api/v1/checks/${check.id}/areas`, {
        as: reviewer,
        json: { kind: 'ignore', x, y: 0, width: 10, height: 10 },
      });
      expect(res.status).toBe(201);
    }
    const viewer = await t.userAs('viewer');
    expect((await t.request('DELETE', `/api/v1/checks/${check.id}/areas`, { as: viewer })).status).toBe(403);
    const res = await t.request('DELETE', `/api/v1/checks/${check.id}/areas`, { as: reviewer });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deleted: number; check: { id: string } };
    expect(body.deleted).toBe(2);
    const list = (await (await t.request('GET', `/api/v1/checks/${check.id}/areas`, { as: reviewer })).json()) as {
      items: unknown[];
    };
    expect(list.items).toEqual([]);
    const again = await t.request('DELETE', `/api/v1/checks/${check.id}/areas`, { as: reviewer });
    expect((await problemOf(again)).code).toBe('area_not_found');
    const doc = (await (await t.request('GET', '/openapi.json')).json()) as {
      paths: Record<string, Record<string, { 'x-permission'?: string }>>;
    };
    expect(doc.paths['/api/v1/checks/{id}/areas']?.delete?.['x-permission']).toBe('check.review');
  });
});
