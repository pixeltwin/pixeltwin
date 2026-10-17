import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { sql } from 'kysely';
import { Migrator } from 'kysely/migration';
import { migrateToLatest } from '../../src/db/database';
import { migrationProvider } from '../../src/db/migrations';
import { createBuild } from '../../src/domain/builds';
import { createProject, getProjectBySlug } from '../../src/domain/projects';
import { createTestDeps, type TestDeps } from '../helpers/deps';

describe('build numbers', () => {
  let deps: TestDeps;

  beforeEach(async () => {
    deps = await createTestDeps();
    await createProject(deps, { slug: 'web', name: 'Web' });
    await createProject(deps, { slug: 'app', name: 'App' });
  });

  afterEach(async () => {
    await deps.handle.close();
  });

  const open = async (slug: string, input: Record<string, unknown> = {}) =>
    (await createBuild(deps, slug, input)).build.number;

  test('each project numbers its builds 1, 2, 3, … on its own', async () => {
    expect([await open('web'), await open('web'), await open('app'), await open('web')]).toEqual([1, 2, 1, 3]);
  });

  test('a retry with the same externalId returns the same number and uses none up', async () => {
    expect(await open('web', { externalId: 'ci-1' })).toBe(1);
    expect(await open('web', { externalId: 'ci-1' })).toBe(1);
    expect(await open('web')).toBe(2);
  });

  test('concurrent builds never share a number', async () => {
    const numbers = await Promise.all(Array.from({ length: 20 }, () => open('web')));
    expect([...numbers].sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });

  test('concurrent retries of one externalId create one build and leave no gap', async () => {
    const numbers = await Promise.all(Array.from({ length: 10 }, () => open('web', { externalId: 'ci-9' })));
    expect(new Set(numbers)).toEqual(new Set([1]));
    expect(await open('web')).toBe(2);
  });

  test('the project API object does not expose the counter', async () => {
    await open('web');
    expect(Object.keys(await getProjectBySlug(deps, 'web'))).not.toContain('buildSeq');
  });

  test('the migration numbers existing builds by creation time and continues after them', async () => {
    // Read before going down: the domain's project columns come from later migrations.
    const web = await getProjectBySlug(deps, 'web');
    const app = await getProjectBySlug(deps, 'app');
    const migrator = new Migrator({ db: deps.db, provider: migrationProvider });
    const down = await migrator.migrateTo('0002_retention_indexes');
    expect(down.error).toBeUndefined();
    try {
      // Ids out of creation order on purpose; equal times fall back to the id.
      const rows: Array<[id: string, projectId: string, createdAt: number]> = [
        ['bld_c', web.id, 1000],
        ['bld_a', web.id, 3000],
        ['bld_b', web.id, 2000],
        ['bld_e', web.id, 2000],
        ['bld_d', app.id, 5000],
      ];
      for (const [id, projectId, createdAt] of rows) {
        await sql`insert into builds (id, project_id, branch, base_branch, state, created_at)
                  values (${id}, ${projectId}, 'main', 'main', 'open', ${createdAt})`.execute(deps.db);
      }
    } finally {
      expect(await migrateToLatest(deps.db)).toEqual([
        '0003_build_numbers',
        '0004_review_events',
        '0005_snapshot_areas',
        '0006_outdated_checks',
        '0007_stored_objects',
        '0008_parallel_builds',
        '0009_auto_approve_new',
        '0010_timings',
        '0013_change_groups',
      ]);
    }
    const numbers = await deps.db.selectFrom('builds').select(['id', 'number']).orderBy('id').execute();
    expect(numbers).toEqual([
      { id: 'bld_a', number: 4 },
      { id: 'bld_b', number: 2 },
      { id: 'bld_c', number: 1 },
      { id: 'bld_d', number: 1 },
      { id: 'bld_e', number: 3 },
    ]);
    expect(await open('web')).toBe(5);
    expect(await open('app')).toBe(2);
  });
});
