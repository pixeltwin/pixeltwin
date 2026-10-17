import type { Project } from '../../src/db/schema';
import { addTimings, finalizeBuild } from '../../src/domain/builds';
import { DAY_MS, dayOf, markBuilds } from '../../src/domain/insight-marks';
import { createProject } from '../../src/domain/projects';
import { approveCheck, rejectCheck } from '../../src/domain/reviews';
import type { TestApp } from './app';
import { BLACK, makePng, WHITE } from './png';
import { openBuild, seedBaseline, submit } from './scenario';

const white = makePng(60, 60);
const square = (x: number) => makePng(60, 60, WHITE, [{ x, y: 5, width: 10, height: 10, color: BLACK }]);
export const TODAY = dayOf(Date.now());
const MIN = 60_000;

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
