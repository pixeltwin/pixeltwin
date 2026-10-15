import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { CheckResult, CheckReview } from '../../src/db/schema';
import { createBuild, finalizeBuild, getBuild, listBuilds } from '../../src/domain/builds';
import { createProject } from '../../src/domain/projects';
import { newId } from '../../src/ids';
import { createTestDeps, type TestDeps } from '../helpers/deps';
import { appError } from '../helpers/errors';

describe('builds', () => {
  let deps: TestDeps;

  beforeEach(async () => {
    deps = await createTestDeps();
    await createProject(deps, { slug: 'web', name: 'Web', mainBranch: 'main' });
  });

  afterEach(async () => {
    await deps.handle.close();
  });

  async function insertCheck(buildId: string, result: CheckResult, review: CheckReview) {
    const build = await getBuild(deps, buildId);
    const now = Date.now();
    await deps.db
      .insertInto('checks')
      .values({
        id: newId('chk'),
        buildId,
        projectId: build.projectId,
        name: newId('chk'),
        variant: '{}',
        snapshotKey: newId('chk'),
        imageSha: 'a'.repeat(64),
        baselineId: null,
        diffImageSha: null,
        ignoreRegions: '[]',
        colorThreshold: 0.1,
        tolerancePercent: 0,
        result,
        review,
        diff: null,
        reviewedBy: null,
        reviewedAt: null,
        reviewComment: null,
        createdAt: now,
        updatedAt: now,
      })
      .execute();
  }

  test('defaults branch and baseBranch to the main branch', async () => {
    const { build, created } = await createBuild(deps, 'web', {});
    expect(created).toBe(true);
    expect(build).toMatchObject({ branch: 'main', baseBranch: 'main', state: 'open', verdict: 'empty' });
    expect(build.id).toStartWith('bld_');
  });

  test('is idempotent on externalId', async () => {
    const first = await createBuild(deps, 'web', { externalId: 'ci-42', branch: 'feature/a' });
    const second = await createBuild(deps, 'web', { externalId: 'ci-42', branch: 'feature/a' });
    expect(second.created).toBe(false);
    expect(second.build.id).toBe(first.build.id);
  });

  test('concurrent creates with one externalId return one build', async () => {
    const results = await Promise.all([1, 2, 3].map(() => createBuild(deps, 'web', { externalId: 'ci-7' })));
    expect(new Set(results.map((r) => r.build.id)).size).toBe(1);
  });

  test('derives counts and verdict from checks', async () => {
    const { build } = await createBuild(deps, 'web', {});
    await insertCheck(build.id, 'unchanged', 'none');
    await insertCheck(build.id, 'changed', 'pending');
    const view = await getBuild(deps, build.id);
    expect(view.verdict).toBe('pending');
    expect(view.counts.total).toBe(2);
    expect(view.counts.result).toMatchObject({ unchanged: 1, changed: 1 });
    expect(view.counts.review).toMatchObject({ none: 1, pending: 1 });
  });

  test('finalize is idempotent', async () => {
    const { build } = await createBuild(deps, 'web', {});
    const first = await finalizeBuild(deps, build.id);
    expect(first.state).toBe('finalized');
    expect(first.finalizedAt).toBeNumber();
    const second = await finalizeBuild(deps, build.id);
    expect(second.finalizedAt).toBe(first.finalizedAt);
  });

  test('lists newest first with branch filter and cursor', async () => {
    const a = await createBuild(deps, 'web', { branch: 'main' });
    const b = await createBuild(deps, 'web', { branch: 'feature/x' });
    const c = await createBuild(deps, 'web', { branch: 'main' });
    const page1 = await listBuilds(deps, 'web', { limit: 2 });
    expect(page1.items.map((x) => x.id)).toEqual([c.build.id, b.build.id]);
    const page2 = await listBuilds(deps, 'web', { limit: 2, cursor: page1.nextCursor ?? undefined });
    expect(page2.items.map((x) => x.id)).toEqual([a.build.id]);
    expect(page2.nextCursor).toBeNull();
    const mainOnly = await listBuilds(deps, 'web', { branch: 'main' });
    expect(mainOnly.items.map((x) => x.id)).toEqual([c.build.id, a.build.id]);
  });

  test('unknown project or build is a 404', async () => {
    expect((await appError(createBuild(deps, 'nope', {}))).code).toBe('project_not_found');
    expect((await appError(getBuild(deps, 'bld_missing'))).code).toBe('build_not_found');
  });
});
