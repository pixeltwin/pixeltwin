import { type Kysely, sql } from 'kysely';

// UI spec §3.5: builds get a per-project number (#1, #2, …). `projects.build_seq` is the last
// number handed out; it only grows, so numbers are never reused after retention deletes builds.

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('projects')
    .addColumn('build_seq', 'integer', (c) => c.notNull().defaultTo(0))
    .execute();
  await db.schema
    .alterTable('builds')
    .addColumn('number', 'integer', (c) => c.notNull().defaultTo(0))
    .execute();
  // Existing builds: numbered by creation time within their project, ties broken by id.
  await sql`
    update builds set number = ranked.n
    from (
      select id, row_number() over (partition by project_id order by created_at, id) as n
      from builds
    ) as ranked
    where ranked.id = builds.id
  `.execute(db);
  await sql`
    update projects set build_seq = (
      select coalesce(max(builds.number), 0) from builds where builds.project_id = projects.id
    )
  `.execute(db);
  await db.schema
    .createIndex('builds_project_number_idx')
    .on('builds')
    .columns(['project_id', 'number'])
    .unique()
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex('builds_project_number_idx').execute();
  await db.schema.alterTable('builds').dropColumn('number').execute();
  await db.schema.alterTable('projects').dropColumn('build_seq').execute();
}
