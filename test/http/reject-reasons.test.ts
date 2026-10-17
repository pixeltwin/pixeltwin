import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createProject } from '../../src/domain/projects';
import { createTestApp, problemOf, type TestApp } from '../helpers/app';
import { BLACK, makePng, WHITE } from '../helpers/png';

const b64 = (png: Uint8Array) => Buffer.from(png).toString('base64');
const page = (logo: number, body: number) =>
  makePng(120, 100, WHITE, [
    { x: 8, y: 4, width: logo, height: 8, color: BLACK },
    { x: 10 + body * 20, y: 50, width: 16, height: 16, color: BLACK },
  ]);

describe('reject reason routes', () => {
  let t: TestApp;
  let ci: { token: string };
  let agent: { token: string };
  let reviewer: { cookie: string; id: string };
  let buildId: string;
  let checkIds: string[];

  const open = async () =>
    ((await (await t.request('POST', '/api/v1/projects/web/builds', { as: ci, json: {} })).json()) as { id: string })
      .id;
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
    agent = await t.tokenAs('web', ['read', 'review']);
    reviewer = await t.userAs('reviewer');
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

  test('reject takes reasonCode and reason; the check and its history answer with them', async () => {
    const res = await t.request('POST', `/api/v1/checks/${checkIds[0]}/reject`, {
      as: reviewer,
      json: { reasonCode: 'late_asset', reason: 'The hero banner was still blank' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      review: 'rejected',
      outcome: 'applied',
      reviewReasonCode: 'late_asset',
      reviewComment: 'The hero banner was still blank',
    });
    const history = await t.request('GET', `/api/v1/checks/${checkIds[0]}/reviews`, { as: ci });
    expect(((await history.json()) as { items: unknown[] }).items[0]).toMatchObject({
      action: 'rejected',
      reasonCode: 'late_asset',
      comment: 'The hero banner was still blank',
    });
  });

  test('an unknown code, or a code on approve, is 422', async () => {
    const bad = await t.request('POST', `/api/v1/checks/${checkIds[0]}/reject`, {
      as: reviewer,
      json: { reasonCode: 'too_slow' },
    });
    expect(bad.status).toBe(422);
    expect((await problemOf(bad)).errors?.[0]?.path).toBe('reasonCode');
    const onApprove = await t.request('POST', `/api/v1/checks/${checkIds[0]}/approve`, {
      as: reviewer,
      json: { reasonCode: 'not_loaded' },
    });
    expect((await problemOf(onApprove)).errors?.[0]?.path).toBe('reasonCode');
  });

  test('a group rejection puts the reason on every member', async () => {
    const check = (await (await t.request('GET', `/api/v1/checks/${checkIds[0]}`, { as: ci })).json()) as {
      groupId: string;
    };
    const res = await t.request('POST', `/api/v1/builds/${buildId}/groups/${check.groupId}/reject`, {
      as: reviewer,
      json: { reasonCode: 'animation', reason: 'Logo caught mid-fade' },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { changed: string[] }).changed).toHaveLength(3);
    for (const id of checkIds) {
      const history = (await (await t.request('GET', `/api/v1/checks/${id}/reviews`, { as: ci })).json()) as {
        items: Array<{ reasonCode: string; comment: string }>;
      };
      expect(history.items[0]).toMatchObject({ reasonCode: 'animation', comment: 'Logo caught mid-fade' });
    }
  });

  test('under an agent review policy a token rejecting without a code gets 422 reason_code_required', async () => {
    await t.request('PATCH', '/api/v1/projects/web', { as: await t.userAs('admin'), json: { agentReview: 'suggest' } });
    const single = await t.request('POST', `/api/v1/checks/${checkIds[0]}/reject`, {
      as: agent,
      json: { reason: 'Not done loading' },
    });
    expect((await problemOf(single)).code).toBe('reason_code_required');
    const check = (await (await t.request('GET', `/api/v1/checks/${checkIds[0]}`, { as: ci })).json()) as {
      groupId: string;
    };
    const group = await t.request('POST', `/api/v1/builds/${buildId}/groups/${check.groupId}/reject`, {
      as: agent,
      json: { reason: 'Not done loading' },
    });
    expect((await problemOf(group)).code).toBe('reason_code_required');
    const suggested = await t.request('POST', `/api/v1/checks/${checkIds[0]}/reject`, {
      as: agent,
      json: { reason: 'Not done loading', reasonCode: 'not_loaded' },
    });
    expect(await suggested.json()).toMatchObject({
      outcome: 'suggested',
      suggestion: { action: 'reject', reason: 'Not done loading', reasonCode: 'not_loaded' },
    });
  });

  test('rejection patterns per project and per build', async () => {
    await t.request('POST', `/api/v1/checks/${checkIds[0]}/reject`, {
      as: reviewer,
      json: { reasonCode: 'not_loaded', reason: 'Spinner' },
    });
    const project = await t.request('GET', '/api/v1/projects/web/rejections?branch=main', { as: ci });
    expect(project.status).toBe(200);
    const patterns = (await project.json()) as {
      total: number;
      categories: unknown[];
      screens: Array<{ name: string; hint: string; recent: unknown[] }>;
    };
    expect(patterns).toMatchObject({
      total: 1,
      categories: [{ code: 'not_loaded', count: 1, screens: 1 }],
      screens: [{ name: 'page-0', count: 1, top: 'not_loaded', tooEarly: 1 }],
    });
    expect(patterns.screens[0]?.recent[0]).toMatchObject({
      reasonCode: 'not_loaded',
      reason: 'Spinner',
      by: { kind: 'user', id: reviewer.id },
    });
    expect(patterns.screens[0]?.hint).toStartWith('Rejected 1× as not_loaded: likely captured before');

    const build = await t.request('GET', `/api/v1/builds/${buildId}/rejections`, { as: ci });
    expect(await build.json()).toMatchObject({ total: 1, screens: [{ name: 'page-0', checkId: checkIds[0] }] });
    const other = await t.request('GET', '/api/v1/projects/web/rejections?branch=feature', { as: ci });
    expect(((await other.json()) as { total: number }).total).toBe(0);
  });
});
