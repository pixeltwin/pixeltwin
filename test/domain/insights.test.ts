import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Migrator } from 'kysely/migration';
import { migrateToLatest, openDatabase } from '../../src/db/database';
import { migrationProvider } from '../../src/db/migrations';
import type { Project } from '../../src/db/schema';
import { deleteBuilds, finalizeBuild } from '../../src/domain/builds';
import { submitCheck } from '../../src/domain/checks';
import { DAY_MS, dayOf, markBuilds } from '../../src/domain/insight-marks';
import { bucketOf, quantileMs, readDays, refreshInsights } from '../../src/domain/insights';
import { createProject, updateProject } from '../../src/domain/projects';
import { runRetention } from '../../src/domain/retention';
import {
  acceptSuggestion,
  approveCheck,
  dismissSuggestion,
  type ReviewActor,
  rejectCheck,
  reviewCheck,
} from '../../src/domain/reviews';
import { MemoryStorage } from '../../src/storage/memory';
import { createTestDeps, type TestDeps } from '../helpers/deps';
import { BLACK, makePng, WHITE } from '../helpers/png';
import { openBuild, seedBaseline, submit } from '../helpers/scenario';

const white = makePng(60, 60);
const square = (x: number) => makePng(60, 60, WHITE, [{ x, y: 5, width: 10, height: 10, color: BLACK }]);
const agent: ReviewActor = { kind: 'token', id: 'tok_agent', name: 'claude' };
const TODAY = dayOf(Date.now());
const MIN = 60_000;

describe('insight rollups', () => {
  let deps: TestDeps;
  let project: Project;

  beforeEach(async () => {
    deps = await createTestDeps();
    project = await createProject(deps, { slug: 'web', name: 'Web', retentionDays: 30 });
    for (const name of ['home', 'about', 'pricing']) await seedBaseline(deps, project, white, { name });
  });

  afterEach(async () => {
    await deps.handle.close();
  });

  /**
   * Moves a build (and its reviews) back in time: created `daysAgo` days ago at 10:00 UTC,
   * finalized a minute later, each review `reviewAfter` ms after the finalize. Marks its day again.
   */
  async function place(buildId: string, daysAgo: number, reviewAfter = 10 * MIN) {
    const createdAt = (TODAY - daysAgo) * DAY_MS + 10 * 3_600_000;
    const finalizedAt = createdAt + MIN;
    await deps.db.updateTable('builds').set({ createdAt, finalizedAt }).where('id', '=', buildId).execute();
    await deps.db.updateTable('checks').set({ createdAt }).where('buildId', '=', buildId).execute();
    const checks = deps.db.selectFrom('checks').select('id').where('buildId', '=', buildId);
    await deps.db
      .updateTable('reviewEvents')
      .set({ createdAt: finalizedAt + reviewAfter })
      .where('checkId', 'in', checks)
      .execute();
    await markBuilds(deps.db, [buildId]);
  }

  /** A finalized build: home unchanged, about changed, pricing changed. */
  async function run(daysAgo: number, review?: (ids: Record<string, string>) => Promise<void>, reviewAfter?: number) {
    const buildId = await openBuild(deps);
    const ids: Record<string, string> = {};
    ids.home = (await submit(deps, buildId, white, { name: 'home' })).check.id;
    ids.about = (await submit(deps, buildId, square(5), { name: 'about' })).check.id;
    ids.pricing = (await submit(deps, buildId, square(30), { name: 'pricing' })).check.id;
    await finalizeBuild(deps, buildId);
    await review?.(ids);
    await place(buildId, daysAgo, reviewAfter);
    return { buildId, ids };
  }

  const days = async () => {
    await refreshInsights(deps);
    return readDays(deps, project.id, 'main', TODAY - 100, TODAY);
  };

  test('a day counts its builds, auto-passed and reviewed checks, rejections by reason and run time', async () => {
    await run(2, async ({ about, pricing }) => {
      await approveCheck(deps, about as string, 'usr_ann');
      await rejectCheck(deps, pricing as string, 'usr_ann', { reasonCode: 'not_loaded', reason: 'spinner' });
    });
    const [day] = await days();
    expect(day?.day).toBe(TODAY - 2);
    expect(day?.totals).toMatchObject({
      builds: 1,
      checks: 3,
      autoPassed: 1,
      neededReview: 2,
      approved: 1,
      rejected: 1,
      pending: 0,
      decidedBuilds: 1,
      latencySumMs: 10 * MIN,
    });
    expect(day?.totals.rejectedBy.not_loaded).toBe(1);
    expect(day?.totals.latencyHist[bucketOf(10 * MIN)]).toBe(1);
    expect(day?.totals.compareMs).toBeGreaterThanOrEqual(0);
    expect(day?.totals.reviewers['user:usr_ann']).toMatchObject({
      kind: 'user',
      decisions: 2,
      approved: 1,
      rejected: 1,
    });
  });

  test('a new screenshot approved by the project setting counts as auto-passed, not as a decision', async () => {
    await updateProject(deps, 'web', { autoApproveNew: true });
    const buildId = await openBuild(deps);
    await submitCheck(deps, buildId, { image: white, meta: { name: 'brand-new' } });
    await finalizeBuild(deps, buildId);
    await place(buildId, 1);
    const [day] = await days();
    expect(day?.totals).toMatchObject({ checks: 1, autoPassed: 1, neededReview: 0, approved: 0, decidedBuilds: 0 });
    expect(day?.totals.reviewers).toEqual({});
  });

  test('timings the SDK reports after the finalize land on the build’s day', async () => {
    const { buildId } = await run(3);
    await deps.db
      .updateTable('builds')
      .set({ timingChecks: 3, timingScreenshotMs: 4200, timingUploadMs: 900, timingRetakes: 2 })
      .where('id', '=', buildId)
      .execute();
    await markBuilds(deps.db, [buildId]);
    const [day] = await days();
    expect(day?.totals).toMatchObject({ screenshotMs: 4200, uploadMs: 900, retakes: 2, timedChecks: 3 });
  });

  test('agent suggestions: made, accepted and dismissed, for the agent and for the person', async () => {
    await updateProject(deps, 'web', { agentReview: 'suggest' });
    await run(1, async ({ about, pricing }) => {
      await reviewCheck(deps, about as string, 'approve', agent, { reason: 'the button moved on purpose' });
      await reviewCheck(deps, pricing as string, 'reject', agent, { reason: 'not loaded', reasonCode: 'not_loaded' });
      await acceptSuggestion(deps, about as string, 'usr_ann');
      await dismissSuggestion(deps, pricing as string, 'usr_ann');
    });
    const [day] = await days();
    expect(day?.totals).toMatchObject({ suggestions: 2, suggestionsAccepted: 1, suggestionsDismissed: 1 });
    expect(day?.totals.reviewers['token:tok_agent']).toMatchObject({
      name: 'claude',
      suggested: 2,
      accepted: 1,
      dismissed: 1,
      decisions: 0,
    });
    expect(day?.totals.reviewers['user:usr_ann']).toMatchObject({ decisions: 1, accepted: 1, dismissed: 1 });
  });

  test('recomputing is idempotent: the same numbers however often, and nothing to do without marks', async () => {
    await run(4, async ({ about }) => approveCheck(deps, about as string, 'usr_ann').then(() => undefined));
    const first = await days();
    await markBuilds(
      deps.db,
      (await deps.db.selectFrom('builds').select('id').execute()).map((b) => b.id),
    );
    // Two replicas at once.
    await Promise.all([refreshInsights(deps), refreshInsights(deps)]);
    expect(await days()).toEqual(first);
    expect(await refreshInsights(deps)).toBe(0);
    expect(await deps.db.selectFrom('insightMarks').selectAll().execute()).toEqual([]);
  });

  test('a review long after the build changes the build’s day, not today', async () => {
    const { ids } = await run(5);
    expect((await days())[0]?.totals.pending).toBe(2);
    await approveCheck(deps, ids.about as string, 'usr_ann');
    const [day] = await days();
    expect(day?.day).toBe(TODAY - 5);
    expect(day?.totals).toMatchObject({ pending: 1, approved: 1 });
  });

  test('retention deletes the builds, the numbers stay, and a second pass counts nothing twice', async () => {
    await run(40, async ({ about, pricing }) => {
      await approveCheck(deps, about as string, 'usr_ann');
      await rejectCheck(deps, pricing as string, 'usr_ann', { reasonCode: 'animation' });
    });
    await run(2);
    const before = await days();
    expect(before.map((d) => d.day)).toEqual([TODAY - 40, TODAY - 2]);

    const result = await runRetention(deps);
    expect(result.buildsDeleted).toBe(1);
    expect(await deps.db.selectFrom('builds').select('id').execute()).toHaveLength(1);
    expect(await days()).toEqual(before);
    const parts = await deps.db
      .selectFrom('insightDays')
      .select(['day', 'part'])
      .where('day', '=', TODAY - 40)
      .execute();
    expect(parts).toEqual([{ day: TODAY - 40, part: 'kept' }]);

    await runRetention(deps);
    expect(await days()).toEqual(before);
  });

  test('builds deleted by hand leave their day', async () => {
    const { buildId } = await run(3);
    await run(3);
    expect((await days())[0]?.totals.builds).toBe(2);
    await deleteBuilds(deps, project.id, [buildId]);
    expect((await days())[0]?.totals.builds).toBe(1);
  });

  test('open builds do not count until they are finalized', async () => {
    const buildId = await openBuild(deps);
    await submit(deps, buildId, square(5), { name: 'about' });
    await markBuilds(deps.db, [buildId]);
    expect(await days()).toEqual([]);
    await finalizeBuild(deps, buildId);
    expect((await days())[0]?.totals.builds).toBe(1);
  });

  test('a screen that keeps flipping counts as flaky on the days it changed', async () => {
    for (let i = 0; i < 5; i++) {
      const buildId = await openBuild(deps);
      await submit(deps, buildId, i % 2 === 0 ? square(5) : white, { name: 'about' });
      await finalizeBuild(deps, buildId);
      await place(buildId, 6 - i);
    }
    const flaky = (await days()).map((d) => d.totals.flakyScreens);
    // Flips need history: the first change is no flip yet, later changes are.
    expect(flaky[0]).toBe(0);
    expect(flaky.at(-1)).toBe(1);
  });

  test('medians and p90s come from the histogram', () => {
    const hist = new Array(13).fill(0);
    hist[bucketOf(3 * MIN)] = 5;
    hist[bucketOf(45 * MIN)] = 5;
    expect(quantileMs(hist, 0.5)).toBe(5 * MIN);
    const p90 = quantileMs(hist, 0.9) as number;
    expect(p90).toBeGreaterThan(30 * MIN);
    expect(p90).toBeLessThanOrEqual(60 * MIN);
    expect(quantileMs(new Array(13).fill(0), 0.5)).toBeNull();
  });
});

describe('insights backfill', () => {
  test('the migration marks the days already there, and the first refresh fills them', async () => {
    const handle = openDatabase('sqlite::memory:');
    try {
      const migrator = new Migrator({ db: handle.db, provider: migrationProvider });
      // Seeded with today's code, then taken back to before insights (later migrations undone).
      await migrateToLatest(handle.db);
      const deps = {
        db: handle.db,
        storage: new MemoryStorage(),
        limits: { maxImageBytes: 10 * 1024 * 1024, maxImagePixels: 40_000_000 },
        runDiff: (await createTestDeps()).runDiff,
      };
      const project = await createProject(deps, { slug: 'web', name: 'Web' });
      await seedBaseline(deps as TestDeps, project, white, { name: 'about' });
      const buildId = await openBuild(deps as TestDeps);
      await submit(deps as TestDeps, buildId, square(5), { name: 'about' });
      const { error } = await migrator.migrateTo('0016_reject_reasons');
      expect(error).toBeUndefined();
      // Finalized before insights existed (finalizeBuild would mark it in a table not there yet).
      await handle.db
        .updateTable('builds')
        .set({ state: 'finalized', finalizedAt: Date.now(), createdAt: Date.now() - 3 * DAY_MS })
        .execute();

      await migrateToLatest(handle.db);
      expect(await refreshInsights(deps)).toBe(1);
      const [day] = await readDays(deps, project.id, 'main', TODAY - 10, TODAY);
      expect(day?.day).toBe(dayOf(Date.now() - 3 * DAY_MS));
      expect(day?.totals).toMatchObject({ builds: 1, checks: 1, neededReview: 1, pending: 1 });
    } finally {
      await handle.close();
    }
  });
});
