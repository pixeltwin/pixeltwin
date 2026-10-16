import { type Kysely, sql } from 'kysely';

// Plan 6: ignore and compare areas drawn on a snapshot in the UI. They belong to the snapshot
// (project + snapshot key, all branches) and go with their project.

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('snapshot_areas')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('project_id', 'text', (c) => c.notNull().references('projects.id').onDelete('cascade'))
    .addColumn('snapshot_key', 'text', (c) => c.notNull())
    .addColumn('kind', 'text', (c) => c.notNull())
    .addColumn('x', 'integer', (c) => c.notNull())
    .addColumn('y', 'integer', (c) => c.notNull())
    .addColumn('width', 'integer', (c) => c.notNull())
    .addColumn('height', 'integer', (c) => c.notNull())
    .addColumn('created_by', 'text', (c) => c.notNull())
    .addColumn('created_at', 'bigint', (c) => c.notNull())
    .addCheckConstraint('snapshot_areas_kind_check', sql`kind in ('ignore', 'compare')`)
    .execute();
  await db.schema
    .createIndex('snapshot_areas_snapshot_idx')
    .on('snapshot_areas')
    .columns(['project_id', 'snapshot_key'])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('snapshot_areas').execute();
}
