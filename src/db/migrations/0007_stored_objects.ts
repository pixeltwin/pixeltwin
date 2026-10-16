import { type Kysely, SqliteAdapter, sql } from 'kysely';

// STORAGE=postgres keeps image bytes in the database, so replicas need no shared disk. The table
// exists on every database (it costs nothing unused); only Postgres deployments use it.

export async function up(db: Kysely<unknown>): Promise<void> {
  const bytes = db.getExecutor().adapter instanceof SqliteAdapter ? sql`blob` : sql`bytea`;
  await db.schema
    .createTable('stored_objects')
    .addColumn('key', 'text', (c) => c.primaryKey())
    .addColumn('data', bytes, (c) => c.notNull())
    .addColumn('created_at', 'bigint', (c) => c.notNull())
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('stored_objects').execute();
}
