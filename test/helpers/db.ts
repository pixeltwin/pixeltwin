import { sql } from 'kysely';
import { type DatabaseHandle, migrateToLatest, openDatabase } from '../../src/db/database';

/**
 * A migrated, empty database. Uses in-memory SQLite, or Postgres when TEST_DATABASE_URL is set
 * (all tables are truncated first, so never point it at a database you care about).
 */
export async function createTestDb(): Promise<DatabaseHandle> {
  const handle = openDatabase(process.env.TEST_DATABASE_URL ?? 'sqlite::memory:');
  await migrateToLatest(handle.db);
  if (handle.kind === 'postgres') {
    await sql`truncate table sessions, project_tokens, users, checks, baselines, builds, images, stored_objects, element_sets, server_settings, projects cascade`.execute(
      handle.db,
    );
  }
  return handle;
}
