import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Project } from '../../src/db/schema';
import { addTimings, finalizeBuild } from '../../src/domain/builds';
import { DAY_MS, dayOf, markBuilds } from '../../src/domain/insight-marks';
import { createProject } from '../../src/domain/projects';
import { approveCheck, rejectCheck } from '../../src/domain/reviews';
import { createTestApp, problemOf, type TestApp } from '../helpers/app';
import { BLACK, makePng, WHITE } from '../helpers/png';
import { openBuild, seedBaseline, submit } from '../helpers/scenario';

const white = makePng(60, 60);
const square = (x: number) => makePng(60, 60, WHITE, [{ x, y: 5, width: 10, height: 10, color: BLACK }]);
const TODAY = dayOf(Date.now());
const MIN = 60_000;
const date = (day: number) => new Date(day * DAY_MS).toISOString().slice(0, 10);

/**
 * A seeded project: four builds on main over the last days. `home` stays the same, `about` is
 * rejected as not loaded twice and then as a real bug, `pricing` is approved; one build waits.
 */
export async function seedInsights(t: TestApp): Promise<Project> {
  const project = await createProject(t.deps, { slug: 'web', name: 'Web', retentionDays: 30 });
  for (const name of ['home', 'about', 'pricing']) await seedBaseline(t.deps, project, white, { name });
  const user = await t.deps.db
    .selectFrom('users')
    .select('id')
    .where('email', '=', 'rita@example.com')
    .executeTakeFirst();
  const reviewer = user?.id ?? 'usr_rita';
  const plan: Array<{ daysAgo: number; about?: 'not_loaded' | 'real_bug'; after: number }> = [
    { daysAgo: 6, about: 'not_loaded', after: 4 * MIN },
    { daysAgo: 4, about: 'not_loaded', after: 20 * MIN },
    { daysAgo: 2, about: 'real_bug', after: 90 * MIN },
    { daysAgo: 1, after: 0 },
  ];
  for (const [i, step] of plan.entries()) {
    const buildId = await openBuild(t.deps);
    await submit(t.deps, buildId, white, { name: 'home' });
    const about = (await submit(t.deps, buildId, square(5), { name: 'about' })).check.id;
    // A new price each run, approved each time.
    const pricing = (await submit(t.deps, buildId, square(20 + i * 6), { name: 'pricing' })).check.id;
    await addTimings(t.deps, buildId, { checks: 3, screenshotMs: 3000, uploadMs: 600, retakes: 1 });
    await finalizeBuild(t.deps, buildId);
    if (step.about) {
      await rejectCheck(t.deps, about, reviewer, { reasonCode: step.about });
      await approveCheck(t.deps, pricing, reviewer);
    }
    const createdAt = (TODAY - step.daysAgo) * DAY_MS + 9 * 3_600_000;
    await t.deps.db
      .updateTable('builds')
      .set({ createdAt, finalizedAt: createdAt + MIN })
      .where('id', '=', buildId)
      .execute();
    await t.deps.db.updateTable('checks').set({ createdAt }).where('buildId', '=', buildId).execute();
    await t.deps.db
      .updateTable('reviewEvents')
      .set({ createdAt: createdAt + MIN + step.after })
      .where('checkId', 'in', [about, pricing])
      .execute();
    await markBuilds(t.deps.db, [buildId]);
  }
  return project;
}

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
