import { type Kysely, sql } from 'kysely';

// UI spec §5.2: who approved, rejected or undid a review, kept after an undo clears the check's
// own review columns. Events go with their check (and so with their build and project).

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('review_events')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('check_id', 'text', (c) => c.notNull().references('checks.id').onDelete('cascade'))
    .addColumn('project_id', 'text', (c) => c.notNull().references('projects.id').onDelete('cascade'))
    .addColumn('action', 'text', (c) => c.notNull())
    .addColumn('actor', 'text', (c) => c.notNull())
    .addColumn('comment', 'text')
    .addColumn('created_at', 'bigint', (c) => c.notNull())
    .addCheckConstraint('review_events_action_check', sql`action in ('approved', 'rejected', 'reset')`)
    .execute();
  await db.schema.createIndex('review_events_check_idx').on('review_events').columns(['check_id', 'id']).execute();
  // Reviews made before this migration: one event each, named after its check (`chk_X` → `rev_X`).
  await sql`
    insert into review_events (id, check_id, project_id, action, actor, comment, created_at)
    select 'rev_' || substr(id, 5), id, project_id, review, reviewed_by, review_comment, reviewed_at
    from checks
    where review in ('approved', 'rejected') and reviewed_by is not null and reviewed_at is not null
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('review_events').execute();
}
