import type { Kysely } from 'kysely';

// A project setting: a new screenshot (no baseline yet) is approved as soon as it arrives. 0 or 1,
// portable across SQLite and Postgres; the domain turns it into a boolean.

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('projects')
    .addColumn('auto_approve_new', 'integer', (c) => c.notNull().defaultTo(0))
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('projects').dropColumn('auto_approve_new').execute();
}
