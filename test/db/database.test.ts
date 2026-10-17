import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type DatabaseHandle, isUniqueViolation, migrateToLatest, openDatabase } from '../../src/db/database';
import { createTestDb } from '../helpers/db';

const now = 1_760_000_000_000;

const project = (id: string, slug: string) => ({
  id,
  slug,
  name: slug,
  mainBranch: 'main',
  colorThreshold: 0.1,
  tolerancePercent: 0,
  retentionDays: 90,
  createdAt: now,
  updatedAt: now,
});

// `bld_3` gets number 3: numbers are unique per project.
const build = (id: string, projectId: string, externalId: string | null = null) => ({
  id,
  projectId,
  number: Number(id.slice('bld_'.length)),
  branch: 'main',
  baseBranch: 'main',
  externalId,
  commitSha: null,
  state: 'open' as const,
  createdAt: now,
  finalizedAt: null,
});

describe('database', () => {
  let handle: DatabaseHandle;

  beforeEach(async () => {
    handle = await createTestDb();
  });

  afterEach(async () => {
    await handle.close();
  });

  test('migrating again applies nothing', async () => {
    expect(await migrateToLatest(handle.db)).toEqual([]);
  });

  test('round-trips camelCase columns, numbers and epoch-ms timestamps', async () => {
    await handle.db.insertInto('projects').values(project('prj_1', 'web')).execute();
    const row = await handle.db.selectFrom('projects').selectAll().executeTakeFirstOrThrow();
    expect(row).toEqual({
      ...project('prj_1', 'web'),
      buildSeq: 0,
      autoApproveNew: 0,
      agentReview: 'off',
      agentMaxDiffPercent: 1,
    });
    expect(typeof row.createdAt).toBe('number');
  });

  test('detects unique violations', async () => {
    await handle.db.insertInto('projects').values(project('prj_1', 'web')).execute();
    const err = await handle.db
      .insertInto('projects')
      .values(project('prj_2', 'web'))
      .execute()
      .catch((e: unknown) => e);
    expect(isUniqueViolation(err)).toBe(true);
    expect(isUniqueViolation(new Error('other'))).toBe(false);
  });

  test('allows many builds without externalId but only one per externalId', async () => {
    await handle.db.insertInto('projects').values(project('prj_1', 'web')).execute();
    await handle.db.insertInto('builds').values(build('bld_1', 'prj_1')).execute();
    await handle.db.insertInto('builds').values(build('bld_2', 'prj_1')).execute();
    await handle.db
      .insertInto('builds')
      .values(build('bld_3', 'prj_1', 'ci-1'))
      .execute();
    const err = await handle.db
      .insertInto('builds')
      .values(build('bld_4', 'prj_1', 'ci-1'))
      .execute()
      .catch((e: unknown) => e);
    expect(isUniqueViolation(err)).toBe(true);
  });

  test('rejects values outside check constraints', async () => {
    await handle.db.insertInto('projects').values(project('prj_1', 'web')).execute();
    const bad = { ...build('bld_1', 'prj_1'), state: 'running' as 'open' };
    await expect(handle.db.insertInto('builds').values(bad).execute()).rejects.toThrow();
  });

  test('deleting a project cascades to builds', async () => {
    await handle.db.insertInto('projects').values(project('prj_1', 'web')).execute();
    await handle.db.insertInto('builds').values(build('bld_1', 'prj_1')).execute();
    await handle.db.deleteFrom('projects').execute();
    expect(await handle.db.selectFrom('builds').selectAll().execute()).toEqual([]);
  });
});

describe('openDatabase', () => {
  test('rejects unsupported URLs', () => {
    expect(() => openDatabase('mysql://localhost/db')).toThrow('Unsupported database URL');
  });

  test('creates the directory for a SQLite file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pixeltwin-'));
    try {
      const handle = openDatabase(`sqlite:${join(dir, 'nested', 'pixeltwin.db')}`);
      expect(await migrateToLatest(handle.db)).toEqual([
        '0001_init',
        '0002_retention_indexes',
        '0003_build_numbers',
        '0004_review_events',
        '0005_snapshot_areas',
        '0006_outdated_checks',
        '0007_stored_objects',
        '0008_parallel_builds',
        '0009_auto_approve_new',
        '0010_timings',
        '0011_integrations',
        '0012_agent_review',
        '0013_change_groups',
      ]);
      await handle.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
