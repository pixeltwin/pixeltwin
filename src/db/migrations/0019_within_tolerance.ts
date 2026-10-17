import { type Kysely, sql } from 'kysely';

// Checks that pass only because their diff is within the tolerance: some pixels differ, but no more
// than `tolerance_percent` of them. 0 or 1, portable across SQLite and Postgres.
// - checks.within_tolerance: the comparison found changed pixels and still called it unchanged.
// - checks.review_within_tolerance: whether such a check waits for a person, as the project or the
//   SDK said when the check was compared: then it starts pending, and undoing its review (or
//   comparing it again after an area changed) returns it there.
// - projects.review_within_tolerance: the project's setting, off by default.
// - insight_days.within_tolerance: of the day's auto_passed checks, those that passed this way.
// Numbered 0019: 0018 is taken by another branch. The backfill marks every day with such checks,
// so the next refresh fills in their insights.

const FLAGS: Array<[table: 'checks' | 'projects', column: string]> = [
  ['checks', 'within_tolerance'],
  ['checks', 'review_within_tolerance'],
  ['projects', 'review_within_tolerance'],
];

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const [table, column] of FLAGS) {
    await db.schema
      .alterTable(table)
      .addColumn(column, 'integer', (c) => c.notNull().defaultTo(0))
      .execute();
  }
  await db.schema
    .alterTable('insight_days')
    .addColumn('within_tolerance', 'bigint', (c) => c.notNull().defaultTo(0))
    .execute();
  // A diff image is stored exactly when the comparison found changed pixels.
  await sql`update checks set within_tolerance = 1 where result = 'unchanged' and diff_image_sha is not null`.execute(
    db,
  );
  await sql`insert into insight_marks (id, project_id, branch, day, created_at)
    select 'imk_0wt' || project_id || '_' || cast(day as text) || '_' || branch, project_id, branch, day, 0
    from (
      select distinct b.project_id, b.branch, b.created_at / 86400000 as day
      from builds b join checks c on c.build_id = b.id
      where c.within_tolerance = 1
    ) as days`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('insight_days').dropColumn('within_tolerance').execute();
  for (const [table, column] of [...FLAGS].reverse()) await db.schema.alterTable(table).dropColumn(column).execute();
}
