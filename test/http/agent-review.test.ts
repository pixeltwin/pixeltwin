import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createProject } from '../../src/domain/projects';
import { createTestApp, problemOf, type TestApp } from '../helpers/app';
import { makePng, WHITE } from '../helpers/png';

const BLUE = [0, 112, 243, 255] as [number, number, number, number];
const page = (y: number) => makePng(200, 100, WHITE, [{ x: 20, y, width: 60, height: 20, color: BLUE }]);
const b64 = (png: Uint8Array) => Buffer.from(png).toString('base64');
const button = (y: number) => ({ key: '[data-testid=submit]', tag: 'button', x: 20, y, width: 60, height: 20 });

describe('agent review routes', () => {
  let t: TestApp;
  let ci: { token: string };
  let agent: { token: string; id: string };
  let admin: { cookie: string; id: string };

  beforeEach(async () => {
    t = await createTestApp();
    await createProject(t.deps, { slug: 'web', name: 'Web' });
    ci = await t.tokenAs('web', ['read', 'write']);
    agent = await t.tokenAs('web', ['read', 'review']);
    admin = await t.userAs('admin');
  });

  afterEach(async () => {
    await t.close();
  });

  async function post(y: number, elements: unknown[] | undefined, buildId?: string) {
    const id =
      buildId ??
      ((await (await t.request('POST', '/api/v1/projects/web/builds', { as: ci, json: {} })).json()) as { id: string })
        .id;
    const res = await t.request('POST', `/api/v1/builds/${id}/checks`, {
      as: ci,
      json: { name: 'home', imageBase64: b64(page(y)), ...(elements ? { elements } : {}) },
    });
    expect(res.status).toBeLessThan(300);
    return { buildId: id, check: (await res.json()) as Record<string, unknown> & { id: string } };
  }

  async function changedCheck() {
    const first = await post(20, [button(20)]);
    await t.request('POST', `/api/v1/checks/${first.check.id}/approve`, { as: admin });
    return post(28, [button(28)]);
  }

  test('a check posted with elements gets element changes; GET /elements returns both sides', async () => {
    const { check } = await changedCheck();
    expect(check.elementCount).toBe(1);
    expect(check.diff).toMatchObject({
      summary: expect.stringMatching(/^`button\[data-testid=submit\]` moved 8 px down\./),
      changes: [{ kind: 'moved', key: '[data-testid=submit]', dx: 0, dy: 8 }],
      changesTruncated: false,
    });
    const res = await t.request('GET', `/api/v1/checks/${check.id}/elements`, { as: agent });
    expect(await res.json()).toEqual({ current: [button(28)], baseline: [button(20)] });
  });

  test('the project policy is a setting; approve says whether it applied or became a suggestion', async () => {
    const patched = await t.request('PATCH', '/api/v1/projects/web', {
      as: admin,
      json: { agentReview: 'suggest' },
    });
    expect(await patched.json()).toMatchObject({ agentReview: 'suggest', agentMaxDiffPercent: 1 });
    const { buildId, check } = await changedCheck();

    const noReason = await t.request('POST', `/api/v1/checks/${check.id}/approve`, { as: agent });
    expect(await problemOf(noReason)).toMatchObject({ status: 422, code: 'reason_required' });

    const res = await t.request('POST', `/api/v1/checks/${check.id}/approve`, {
      as: agent,
      json: { reason: 'Moved on purpose' },
    });
    expect(await res.json()).toMatchObject({
      outcome: 'suggested',
      review: 'pending',
      suggestion: { action: 'approve', reason: 'Moved on purpose', by: { kind: 'token', id: agent.id } },
    });
    const build = await (await t.request('GET', `/api/v1/builds/${buildId}`, { as: agent })).json();
    expect(build).toMatchObject({ verdict: 'pending', counts: { suggested: 1 } });

    // The token cannot accept its own suggestion; a person can.
    const self = await t.request('POST', `/api/v1/checks/${check.id}/suggestion/accept`, { as: agent });
    expect(await problemOf(self)).toMatchObject({ status: 403 });
    const accepted = await t.request('POST', `/api/v1/checks/${check.id}/suggestion/accept`, { as: admin });
    expect(await accepted.json()).toMatchObject({ review: 'approved', reviewComment: 'Moved on purpose' });

    const history = (await (await t.request('GET', `/api/v1/checks/${check.id}/reviews`, { as: agent })).json()) as {
      items: Array<Record<string, unknown>>;
    };
    expect(history.items.map((e) => [e.action, e.actorKind, e.actorName])).toEqual([
      ['approved', 'user', null],
      ['suggested_approval', 'token', 'test'],
    ]);
  });

  test('dismissing a suggestion keeps the check pending', async () => {
    await t.request('PATCH', '/api/v1/projects/web', { as: admin, json: { agentReview: 'suggest' } });
    const { check } = await changedCheck();
    await t.request('POST', `/api/v1/checks/${check.id}/reject`, {
      as: agent,
      json: { reason: 'Looks broken', reasonCode: 'real_bug' },
    });
    const res = await t.request('POST', `/api/v1/checks/${check.id}/suggestion/dismiss`, {
      as: admin,
      json: { reason: 'It is fine' },
    });
    expect(await res.json()).toMatchObject({ review: 'pending', suggestion: null });
    const again = await t.request('POST', `/api/v1/checks/${check.id}/suggestion/dismiss`, { as: admin });
    expect(await problemOf(again)).toMatchObject({ status: 409, code: 'no_suggestion' });
  });

  test('with policy off a token review applies (outcome applied); under a policy it cannot change areas', async () => {
    const { check } = await changedCheck();
    const area = { kind: 'ignore', x: 0, y: 0, width: 10, height: 10 };
    const allowed = await t.request('POST', `/api/v1/checks/${check.id}/areas`, { as: agent, json: area });
    expect(allowed.status).toBe(201);

    await t.request('PATCH', '/api/v1/projects/web', { as: admin, json: { agentReview: 'auto-below' } });
    const refused = await t.request('POST', `/api/v1/checks/${check.id}/areas`, { as: agent, json: area });
    expect(await problemOf(refused)).toMatchObject({ status: 403, code: 'agent_review_policy' });
    const all = await t.request('POST', `/api/v1/checks/${check.id}/areas/ignore-changes`, { as: agent });
    expect(await problemOf(all)).toMatchObject({ status: 403, code: 'agent_review_policy' });
    const byPerson = await t.request('POST', `/api/v1/checks/${check.id}/areas`, { as: admin, json: area });
    expect(byPerson.status).toBe(201);

    await t.request('PATCH', '/api/v1/projects/web', { as: admin, json: { agentReview: 'off' } });
    const res = await t.request('POST', `/api/v1/checks/${check.id}/approve`, { as: agent });
    expect(await res.json()).toMatchObject({ outcome: 'applied', review: 'approved' });
  });

  test('approving a build with a token under a policy needs a reason and reports suggestions', async () => {
    await t.request('PATCH', '/api/v1/projects/web', { as: admin, json: { agentReview: 'suggest' } });
    const { buildId } = await changedCheck();
    const bare = await t.request('POST', `/api/v1/builds/${buildId}/approve`, { as: agent });
    expect(await problemOf(bare)).toMatchObject({ status: 422, code: 'reason_required' });
    const res = await t.request('POST', `/api/v1/builds/${buildId}/approve`, {
      as: agent,
      json: { reason: 'All intended' },
    });
    expect(await res.json()).toEqual({ approved: 0, suggested: 1 });
  });

  test('a bad policy value is refused', async () => {
    const res = await t.request('PATCH', '/api/v1/projects/web', { as: admin, json: { agentReview: 'sometimes' } });
    expect(await problemOf(res)).toMatchObject({ status: 422, code: 'validation_failed' });
  });
});
