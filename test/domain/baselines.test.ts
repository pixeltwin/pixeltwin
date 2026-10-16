import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Project } from '../../src/db/schema';
import {
  appendBaseline,
  baselineHistory,
  findCurrentBaseline,
  promoteBranch,
  promotionCandidates,
  resolveBaseline,
} from '../../src/domain/baselines';
import { createProject } from '../../src/domain/projects';
import { createTestDeps, type TestDeps } from '../helpers/deps';
import { appError } from '../helpers/errors';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const SHA_C = 'c'.repeat(64);

describe('baselines', () => {
  let deps: TestDeps;
  let project: Project;

  beforeEach(async () => {
    deps = await createTestDeps();
    project = await createProject(deps, { slug: 'web', name: 'Web', mainBranch: 'main' });
  });

  afterEach(async () => {
    await deps.handle.close();
  });

  const add = (key: string, branch: string, imageSha: string) =>
    appendBaseline(deps.db, {
      projectId: project.id,
      snapshotKey: key,
      name: key,
      variant: '{}',
      branch,
      imageSha,
      sourceCheckId: null,
      approvedBy: 'usr_1',
    });

  test('the newest baseline is current', async () => {
    await add('k1', 'main', SHA_A);
    const newer = await add('k1', 'main', SHA_B);
    expect((await findCurrentBaseline(deps.db, project.id, 'k1', 'main'))?.id).toBe(newer.id);
  });

  test('prefers the build branch, falls back to the base branch', async () => {
    await add('k1', 'main', SHA_A);
    expect(await resolveBaseline(deps.db, project.id, 'k1', 'feature/x', 'main')).toMatchObject({
      fallback: true,
      baseline: { branch: 'main', imageSha: SHA_A },
    });
    await add('k1', 'feature/x', SHA_B);
    expect(await resolveBaseline(deps.db, project.id, 'k1', 'feature/x', 'main')).toMatchObject({
      fallback: false,
      baseline: { branch: 'feature/x', imageSha: SHA_B },
    });
    expect(await resolveBaseline(deps.db, project.id, 'k2', 'feature/x', 'main')).toBeNull();
  });

  test('promotion copies the latest branch baselines to main, once', async () => {
    await add('k1', 'main', SHA_A);
    await add('k1', 'feature/login', SHA_B);
    await add('k2', 'feature/login', SHA_A);
    await add('k2', 'feature/login', SHA_C);
    await add('k3', 'feature/login', SHA_A);
    await add('k3', 'main', SHA_A);

    expect(await promoteBranch(deps, 'web', 'feature/login', 'usr_2')).toEqual({ promoted: 2 });
    expect((await findCurrentBaseline(deps.db, project.id, 'k1', 'main'))?.imageSha).toBe(SHA_B);
    expect((await findCurrentBaseline(deps.db, project.id, 'k2', 'main'))?.imageSha).toBe(SHA_C);
    expect((await findCurrentBaseline(deps.db, project.id, 'k2', 'main'))?.approvedBy).toBe('usr_2');
    expect(await promoteBranch(deps, 'web', 'feature/login', 'usr_2')).toEqual({ promoted: 0 });
  });

  test('the promotion candidates are the branch screens that differ from main', async () => {
    await add('k1', 'main', SHA_A);
    await add('k1', 'feature/login', SHA_B);
    await add('k2', 'feature/login', SHA_C);
    await add('k3', 'feature/login', SHA_A);
    await add('k3', 'main', SHA_A);
    const candidates = await promotionCandidates(deps, 'web', 'feature/login');
    expect(candidates.map((c) => [c.snapshotKey, c.branchImageSha, c.mainImageSha])).toEqual([
      ['k1', SHA_B, SHA_A],
      ['k2', SHA_C, null],
    ]);
    expect((await appError(promotionCandidates(deps, 'web', 'main'))).code).toBe('invalid_promotion');
  });

  test('a promotion can take only some screens', async () => {
    await add('k1', 'main', SHA_A);
    await add('k1', 'feature/login', SHA_B);
    await add('k2', 'feature/login', SHA_C);
    expect(await promoteBranch(deps, 'web', 'feature/login', 'usr_2', { snapshotKeys: ['k2'] })).toEqual({
      promoted: 1,
    });
    expect((await findCurrentBaseline(deps.db, project.id, 'k1', 'main'))?.imageSha).toBe(SHA_A);
    expect((await findCurrentBaseline(deps.db, project.id, 'k2', 'main'))?.imageSha).toBe(SHA_C);
    // The rest can follow later.
    expect((await promotionCandidates(deps, 'web', 'feature/login')).map((c) => c.snapshotKey)).toEqual(['k1']);
    const unknown = await appError(promoteBranch(deps, 'web', 'feature/login', 'usr_2', { snapshotKeys: ['nope'] }));
    expect(unknown).toMatchObject({ status: 422, code: 'snapshot_not_on_branch' });
    // An empty choice promotes nothing (it does not mean "everything").
    expect(await promoteBranch(deps, 'web', 'feature/login', 'usr_2', { snapshotKeys: [] })).toEqual({ promoted: 0 });
  });

  test('promoting the main branch is rejected', async () => {
    const err = await appError(promoteBranch(deps, 'web', 'main', 'usr_1'));
    expect(err.code).toBe('invalid_promotion');
    expect(err.status).toBe(400);
  });

  test('history is newest first and paginates', async () => {
    const first = await add('k1', 'main', SHA_A);
    const second = await add('k1', 'feature/x', SHA_B);
    const third = await add('k1', 'main', SHA_C);
    const page1 = await baselineHistory(deps, 'web', 'k1', { limit: 2 });
    expect(page1.items.map((b) => b.id)).toEqual([third.id, second.id]);
    expect(page1.items[0]?.variant).toEqual({});
    const page2 = await baselineHistory(deps, 'web', 'k1', { limit: 2, cursor: page1.nextCursor ?? undefined });
    expect(page2.items.map((b) => b.id)).toEqual([first.id]);
    const mainOnly = await baselineHistory(deps, 'web', 'k1', { branch: 'main' });
    expect(mainOnly.items.map((b) => b.id)).toEqual([third.id, first.id]);
  });

  test('concurrent promotions promote each snapshot once', async () => {
    for (let i = 0; i < 10; i++) await add(`k${i}`, 'feature/x', SHA_B);
    const results = await Promise.all([1, 2, 3, 4].map(() => promoteBranch(deps, 'web', 'feature/x', 'usr_1')));
    expect(results.reduce((n, r) => n + r.promoted, 0)).toBe(10);
    const onMain = await deps.db.selectFrom('baselines').selectAll().where('branch', '=', 'main').execute();
    expect(onMain).toHaveLength(10);
  });
});
