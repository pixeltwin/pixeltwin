import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Migrator } from 'kysely/migration';
import { type DatabaseHandle, migrateToLatest } from '../../src/db/database';
import { migrationProvider } from '../../src/db/migrations';
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

const user = (id: string, role: 'admin' | 'reviewer' | 'viewer') => ({
  id,
  email: `${id}@example.com`,
  passwordHash: 'x',
  role,
  createdAt: now,
});

describe('migration 0014_project_members', () => {
  let handle: DatabaseHandle;

  beforeEach(async () => {
    handle = await createTestDb();
  });

  afterEach(async () => {
    await handle.close();
  });

  test('gives every existing non-admin user their role in every existing project, and rolls back', async () => {
    const migrator = new Migrator({ db: handle.db, provider: migrationProvider });
    expect((await migrator.migrateTo('0013_change_groups')).error).toBeUndefined();
    // Typed for the latest schema; at 0013 these tables have exactly these columns.
    await handle.db
      .insertInto('projects')
      .values([project('prj_1', 'web'), project('prj_2', 'app')])
      .execute();
    await handle.db
      .insertInto('users')
      .values([user('usr_a', 'admin'), user('usr_r', 'reviewer'), user('usr_v', 'viewer')])
      .execute();

    expect(await migrateToLatest(handle.db)).toEqual([
      '0014_project_members',
      '0015_mail_outbox',
      '0016_reject_reasons',
      '0017_insights',
      '0019_within_tolerance',
    ]);
    const members = await handle.db
      .selectFrom('projectMembers')
      .select(['projectId', 'userId', 'role'])
      .orderBy('projectId')
      .orderBy('userId')
      .execute();
    expect(members).toEqual([
      { projectId: 'prj_1', userId: 'usr_r', role: 'reviewer' },
      { projectId: 'prj_1', userId: 'usr_v', role: 'viewer' },
      { projectId: 'prj_2', userId: 'usr_r', role: 'reviewer' },
      { projectId: 'prj_2', userId: 'usr_v', role: 'viewer' },
    ]);
    const projects = await handle.db.selectFrom('projects').select(['slug', 'visibleToAll']).orderBy('slug').execute();
    expect(projects).toEqual([
      { slug: 'app', visibleToAll: 0 },
      { slug: 'web', visibleToAll: 0 },
    ]);

    expect((await migrator.migrateTo('0013_change_groups')).error).toBeUndefined();
    expect(await handle.db.selectFrom('projects').select('slug').execute()).toHaveLength(2);
    expect(await migrateToLatest(handle.db)).toEqual([
      '0014_project_members',
      '0015_mail_outbox',
      '0016_reject_reasons',
      '0017_insights',
      '0019_within_tolerance',
    ]);
  });

  test('memberships go with their project and their user', async () => {
    await handle.db.insertInto('projects').values(project('prj_1', 'web')).execute();
    await handle.db
      .insertInto('users')
      .values([user('usr_r', 'reviewer'), user('usr_v', 'viewer')])
      .execute();
    await handle.db
      .insertInto('projectMembers')
      .values({ projectId: 'prj_1', userId: 'usr_r', role: 'maintainer', createdAt: now })
      .execute();
    // Admin is a global role only.
    await expect(
      handle.db
        .insertInto('projectMembers')
        .values({ projectId: 'prj_1', userId: 'usr_v', role: 'admin' as 'viewer', createdAt: now })
        .execute(),
    ).rejects.toThrow();
    await handle.db
      .insertInto('projectMembers')
      .values({ projectId: 'prj_1', userId: 'usr_v', role: 'viewer', createdAt: now })
      .execute();
    await handle.db.deleteFrom('users').where('id', '=', 'usr_v').execute();
    expect(await handle.db.selectFrom('projectMembers').select('userId').execute()).toEqual([{ userId: 'usr_r' }]);
    await handle.db.deleteFrom('projects').execute();
    expect(await handle.db.selectFrom('projectMembers').selectAll().execute()).toEqual([]);
  });
});
