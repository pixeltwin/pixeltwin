import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Project } from '../../src/db/schema';
import {
  appendBaseline,
  baselineHistory,
  findCurrentBaseline,
  promoteBranch,
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
});
