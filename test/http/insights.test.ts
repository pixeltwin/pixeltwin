import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { DAY_MS } from '../../src/domain/insight-marks';
import { createTestApp, problemOf, type TestApp } from '../helpers/app';
import { seedInsights, TODAY } from '../helpers/insights';

const MIN = 60_000;
const date = (day: number) => new Date(day * DAY_MS).toISOString().slice(0, 10);

describe('GET /projects/{slug}/insights', () => {
  let t: TestApp;
  let member: { cookie: string; id: string };

  beforeEach(async () => {
    t = await createTestApp();
    member = await t.userAs('reviewer', 'rita@example.com', { projects: [] });
    await seedInsights(t);
    await t.deps.db
      .insertInto('projectMembers')
      .values({
        projectId: (await t.deps.db.selectFrom('projects').select('id').executeTakeFirstOrThrow()).id,
        userId: member.id,
        role: 'reviewer',
        createdAt: Date.now(),
      })
      .execute();
  });

  afterEach(async () => {
    await t.close();
  });

  test('answers the numbers of the seeded week', async () => {
    const res = await t.request('GET', `/api/v1/projects/web/insights?from=${date(TODAY - 6)}&to=${date(TODAY)}`, {
      as: member,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ branch: 'main', from: date(TODAY - 6), to: date(TODAY), days: 7, timeZone: 'UTC' });
    expect(body.totals).toMatchObject({
      builds: 4,
      checks: 12,
      autoPassed: 4,
      neededReview: 8,
      approved: 3,
      rejected: 3,
      pending: 2,
      rejections: { total: 3, noise: 2, realBug: 1, other: 0 },
      runTime: { screenshotMs: 12000, uploadMs: 2400, retakes: 4, timedChecks: 12 },
      timeToDecision: { decidedBuilds: 3 },
    });
    expect(body.totals.autoPassRate).toBeCloseTo(4 / 12);
    // 4, 20 and 90 minutes: the median is in the 15–30 minute bucket.
    expect(body.totals.timeToDecision.medianMs).toBeGreaterThanOrEqual(15 * MIN);
    expect(body.totals.timeToDecision.medianMs).toBeLessThanOrEqual(30 * MIN);
    expect(body.totals.timeToDecision.p90Ms).toBeGreaterThanOrEqual(60 * MIN);
    expect(body.daily).toHaveLength(7);
    expect(body.daily[0]).toMatchObject({ date: date(TODAY - 6), builds: 1, rejected: 1 });
    expect(body.daily[0].rejectedBy.not_loaded).toBe(1);
    expect(body.daily[1]).toMatchObject({ builds: 0, autoPassRate: null, medianMs: null });

    expect(body.noisyScreens[0]).toMatchObject({
      name: 'about',
      noiseRejections: 2,
      mainReason: 'not_loaded',
      byReason: { not_loaded: 2 },
    });
    expect(body.noisyScreens[0].action).toContain('Wait for the page');
    expect(body.slowScreens.map((x: { name: string }) => x.name).sort()).toEqual(['about', 'home', 'pricing']);
    expect(body.reviewers).toEqual([
      expect.objectContaining({ kind: 'user', name: 'rita@example.com', decisions: 6, approved: 3, rejected: 3 }),
    ]);
    expect(body.previous).toMatchObject({ builds: 0, autoPassRate: null });
  });

  test('a branch without builds answers zeros, not an error', async () => {
    const res = await t.request('GET', '/api/v1/projects/web/insights?branch=feature%2Fnone', { as: member });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ branch: 'feature/none', days: 30, totals: { builds: 0, autoPassRate: null } });
    expect(body.noisyScreens).toEqual([]);
  });

  test('a project token with read sees them; bad dates are 422', async () => {
    const { token } = await t.tokenAs('web', ['read']);
    expect((await t.request('GET', '/api/v1/projects/web/insights', { as: { token } })).status).toBe(200);
    const bad = await t.request('GET', '/api/v1/projects/web/insights?from=2026-13-01', { as: { token } });
    expect(bad.status).toBe(422);
    const backwards = await t.request('GET', '/api/v1/projects/web/insights?from=2026-10-10&to=2026-10-01', {
      as: { token },
    });
    expect((await problemOf(backwards)).errors?.[0]?.path).toBe('from');
    const long = await t.request('GET', '/api/v1/projects/web/insights?from=2024-01-01&to=2026-10-01', {
      as: { token },
    });
    expect(long.status).toBe(422);
  });

  test('a user outside the project gets 404', async () => {
    const outsider = await t.userAs('reviewer', 'out@example.com', { projects: [] });
    const res = await t.request('GET', '/api/v1/projects/web/insights', { as: outsider });
    expect(res.status).toBe(404);
    expect((await problemOf(res)).code).toBe('project_not_found');
  });
});

describe('the weekly digest setting', () => {
  let t: TestApp;

  beforeEach(async () => {
    t = await createTestApp();
    await seedInsights(t);
  });

  afterEach(async () => {
    await t.close();
  });

  test('maintainers read and set it, and send it now; reviewers may not', async () => {
    const maintainer = await t.userAs('reviewer', 'max@example.com', { projects: [] });
    const project = await t.deps.db.selectFrom('projects').select('id').executeTakeFirstOrThrow();
    await t.deps.db
      .insertInto('projectMembers')
      .values({ projectId: project.id, userId: maintainer.id, role: 'maintainer', createdAt: Date.now() })
      .execute();
    const off = await t.request('GET', '/api/v1/projects/web/insights/digest', { as: maintainer });
    expect(await off.json()).toMatchObject({ enabled: false, weekday: 1, hour: 9 });
    const on = await t.request('PUT', '/api/v1/projects/web/insights/digest', {
      as: maintainer,
      json: { enabled: true, weekday: 5, hour: 16 },
    });
    expect(on.status).toBe(200);
    const body = await on.json();
    expect(body).toMatchObject({ enabled: true, weekday: 5, hour: 16 });
    expect(body.timeZone).toContain('UTC');
    const bad = await t.request('PUT', '/api/v1/projects/web/insights/digest', { as: maintainer, json: { hour: 24 } });
    expect(bad.status).toBe(422);
    const sent = await t.request('POST', '/api/v1/projects/web/insights/digest/send', { as: maintainer });
    expect(await sent.json()).toEqual({ webhooks: 0, mails: 0 });

    const reviewer = await t.userAs('reviewer', 'rev@example.com');
    expect((await t.request('POST', '/api/v1/projects/web/insights/digest/send', { as: reviewer })).status).toBe(403);
    const outsider = await t.userAs('reviewer', 'out@example.com', { projects: [] });
    expect((await t.request('GET', '/api/v1/projects/web/insights/digest', { as: outsider })).status).toBe(404);
  });
});
