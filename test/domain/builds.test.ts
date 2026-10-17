import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { CheckResult, CheckReview } from '../../src/db/schema';
import { createBuild, finalizeBuild, getBuild, listBuilds, removeBuilds } from '../../src/domain/builds';
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

  test('keeps the commit, repository and pull request; a reused build fills in those it lacks', async () => {
    const { build } = await createBuild(deps, 'web', {
      branch: 'feature/login',
      externalId: 'ci-7',
      repository: 'acme/shop',
      pullRequest: 42,
    });
    expect(build).toMatchObject({ commitSha: null, repository: 'acme/shop', pullRequest: 42 });
    expect(build).not.toHaveProperty('notifiedVerdict');
    const again = await createBuild(deps, 'web', {
      externalId: 'ci-7',
      commitSha: 'a1b2c3d',
      repository: 'other/repo',
      pullRequest: 7,
    });
    // Missing values are filled in; values the build has stay (the first part of a run named them).
    expect(again.build).toMatchObject({ id: build.id, commitSha: 'a1b2c3d', repository: 'acme/shop', pullRequest: 42 });
  });

  test('refuses a repository that is not owner/name and a pull request that is not a positive number', async () => {
    expect((await appError(createBuild(deps, 'web', { repository: 'no-slash' }))).code).toBe('validation_failed');
    expect((await appError(createBuild(deps, 'web', { pullRequest: 0 }))).code).toBe('validation_failed');
    // GitLab paths may have nested groups.
    expect((await createBuild(deps, 'web', { repository: 'group/sub/project' })).build.repository).toBe(
      'group/sub/project',
    );
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

  test('a parallel build stays open until each of its parts has finalized it', async () => {
    const { build } = await createBuild(deps, 'web', { externalId: 'ci-9', parallelTotal: 2 });
    expect(build).toMatchObject({ parallelTotal: 2, partsFinished: 0 });

    const one = await finalizeBuild(deps, build.id, { part: 'job-1' });
    expect(one).toMatchObject({ state: 'open', partsFinished: 1, finalizedAt: null });
    // The same part again (a retried request) counts once.
    expect(await finalizeBuild(deps, build.id, { part: 'job-1' })).toMatchObject({ state: 'open', partsFinished: 1 });

    const two = await finalizeBuild(deps, build.id, { part: 'job-2' });
    expect(two).toMatchObject({ state: 'finalized', partsFinished: 2 });
    expect(two.finalizedAt).toBeNumber();
  });

  test('a retried part reopens its finalized parallel build and finalizes it again when it ends', async () => {
    const open = () => createBuild(deps, 'web', { externalId: 'gitlab-1', parallelTotal: 2 });
    const { build } = await open();
    await finalizeBuild(deps, build.id, { part: 'job-1' });
    await finalizeBuild(deps, build.id, { part: 'job-2' });

    const again = await open();
    expect(again).toMatchObject({ created: false, build: { id: build.id, state: 'open', finalizedAt: null } });
    const done = await finalizeBuild(deps, build.id, { part: 'job-3' });
    expect(done).toMatchObject({ state: 'finalized', partsFinished: 3 });
    expect(done.finalizedAt).toBeNumber();

    // An ordinary build stays finalized: its CI run reused an id by mistake.
    const plain = await createBuild(deps, 'web', { externalId: 'ci-1' });
    await finalizeBuild(deps, plain.build.id);
    expect((await createBuild(deps, 'web', { externalId: 'ci-1' })).build.state).toBe('finalized');
  });

  test('parts finishing at once finalize the build once', async () => {
    const { build } = await createBuild(deps, 'web', { parallelTotal: 3 });
    await Promise.all(['a', 'b', 'c'].map((part) => finalizeBuild(deps, build.id, { part })));
    expect(await getBuild(deps, build.id)).toMatchObject({ state: 'finalized', partsFinished: 3 });
  });

  test('finalize without a part closes a parallel build at once (a part never ran)', async () => {
    const { build } = await createBuild(deps, 'web', { parallelTotal: 2 });
    await finalizeBuild(deps, build.id, { part: 'job-1' });
    expect(await finalizeBuild(deps, build.id)).toMatchObject({ state: 'finalized', partsFinished: 1 });
  });

  test('a part finalizes a build that is not parallel at once', async () => {
    const { build } = await createBuild(deps, 'web', {});
    expect(build).toMatchObject({ parallelTotal: null, partsFinished: 0 });
    expect((await finalizeBuild(deps, build.id, { part: 'job-1' })).state).toBe('finalized');
  });

  test('the first open that names a part count sets it; later opens keep it', async () => {
    const first = await createBuild(deps, 'web', { externalId: 'ci-10' });
    const second = await createBuild(deps, 'web', { externalId: 'ci-10', parallelTotal: 2 });
    expect(second.build.parallelTotal).toBe(2);
    const third = await createBuild(deps, 'web', { externalId: 'ci-10', parallelTotal: 5 });
    expect(third.build).toMatchObject({ id: first.build.id, parallelTotal: 2 });
    expect((await appError(createBuild(deps, 'web', { parallelTotal: 0 }))).code).toBe('validation_failed');
  });

  test('deleting a parallel build deletes its finished parts', async () => {
    const { build } = await createBuild(deps, 'web', { parallelTotal: 2 });
    await finalizeBuild(deps, build.id, { part: 'job-1' });
    await removeBuilds(deps.db, [build.id]);
    expect(await deps.db.selectFrom('buildParts').selectAll().execute()).toEqual([]);
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
