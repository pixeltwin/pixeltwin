import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Project } from '../../src/db/schema';
import { listBranchSummaries } from '../../src/domain/branches';
import { createTestDeps, type TestDeps } from '../helpers/deps';
import { appError } from '../helpers/errors';
import { makePng } from '../helpers/png';
import { openBuild, seedProject, submit } from '../helpers/scenario';

describe('branch summaries', () => {
  let deps: TestDeps;
  let project: Project;

  beforeEach(async () => {
    deps = await createTestDeps();
    project = await seedProject(deps, 'web');
  });

  afterEach(async () => {
    await deps.handle.close();
  });

  /** Opens a build on `branch` created at `createdAt` (ms), so ordering does not depend on timing. */
  async function buildAt(branch: string, createdAt: number): Promise<string> {
    const id = await openBuild(deps, 'web', { branch });
    await deps.db.updateTable('builds').set({ createdAt }).where('id', '=', id).execute();
    return id;
  }

  test('an empty project has no branches', async () => {
    expect(await listBranchSummaries(deps, 'web')).toEqual([]);
  });

  test('the main branch comes first, then branches by their latest build, newest first', async () => {
    await buildAt('feature/a', 1000);
    await buildAt('main', 2000);
    await buildAt('feature/b', 3000);
    await buildAt('feature/a', 4000);
    const summaries = await listBranchSummaries(deps, 'web');
    expect(summaries.map((s) => s.branch)).toEqual(['main', 'feature/a', 'feature/b']);
  });

  test('each branch has its latest build and its recent verdicts, newest first', async () => {
    const older = await buildAt('main', 1000);
    const newer = await buildAt('main', 2000);
    await submit(deps, newer, makePng(10, 10));
    const [main] = await listBranchSummaries(deps, 'web');
    expect(main?.latest).toMatchObject({ id: newer, number: 2, verdict: 'pending' });
    expect(main?.latest.counts.review.pending).toBe(1);
    expect(main?.recent).toEqual([
      { id: newer, number: 2, verdict: 'pending', createdAt: 2000 },
      { id: older, number: 1, verdict: 'empty', createdAt: 1000 },
    ]);
  });

  test('at most 10 recent builds per branch and 50 branches, main always included', async () => {
    for (let i = 0; i < 12; i++) await buildAt('main', 1000 + i);
    for (let i = 0; i < 55; i++) await buildAt(`feature/${String(i).padStart(2, '0')}`, 10_000 + i);
    const summaries = await listBranchSummaries(deps, 'web');
    expect(summaries).toHaveLength(50);
    expect(summaries[0]?.branch).toBe('main');
    expect(summaries[0]?.recent).toHaveLength(10);
    expect(summaries[0]?.recent[0]?.number).toBe(12);
    expect(summaries[1]?.branch).toBe('feature/54');
  });

  test('another project and a missing project are kept apart', async () => {
    await seedProject(deps, 'app');
    await openBuild(deps, 'app', { branch: 'main' });
    expect(await listBranchSummaries(deps, 'web')).toEqual([]);
    expect((await appError(listBranchSummaries(deps, 'nope'))).code).toBe('project_not_found');
    expect(project.slug).toBe('web');
  });
});
