import type { Kysely } from 'kysely';

// A parallel build is opened by several CI jobs (`parallel_total` of them, same externalId); each
// finalizes its part, and the build is finalized when the last part is. `build_parts` holds the
// finished parts: its key makes a part counted once, also when two jobs finish at the same time.

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('builds').addColumn('parallel_total', 'integer').execute();
  await db.schema
    .createTable('build_parts')
    .addColumn('build_id', 'text', (c) => c.notNull().references('builds.id').onDelete('cascade'))
    .addColumn('part', 'text', (c) => c.notNull())
    .addColumn('finished_at', 'bigint', (c) => c.notNull())
    .addPrimaryKeyConstraint('build_parts_pk', ['build_id', 'part'])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('build_parts').execute();
  await db.schema.alterTable('builds').dropColumn('parallel_total').execute();
}
