import { type Kysely, sql } from 'kysely';

// Insights: how healthy a project's visual tests are, over weeks, after retention deleted the builds.
//
// `insight_days` holds one row per project, branch, UTC day (days since the epoch) and part. Every
// number is about the finalized builds created that day: their checks, their reviews (whenever they
// were made) and their run time. Part `live` is recomputed from the builds that still exist, so it
// is idempotent and any replica may do it; part `kept` adds up what retention took away: the
// retention pass adds a batch's numbers to it in the transaction that deletes the batch, so a build
// counts in `live` or in `kept`, never both, never neither. The review latency (finalize to the last
// decision of the build) is a sum, a count and a coarse histogram (JSON), so medians and p90s come
// from the histograms; reviewers (people and tokens) are JSON too: both are merged in code.
//
// `insight_marks` are the (project, branch, day) whose live row is out of date: a review, a
// finalize, timings, an area change or a deleted build appends one in the same transaction (an
// insert with no conflicts, so no lock is shared between reviews), and the next refresh recomputes
// those days and deletes the marks it read. The migration marks every day that has builds: the
// first refresh backfills the history that is still there.
//
// The weekly digest: a project's setting (off by default), the members who want it by mail, and one
// row per digest sent, whose primary key makes "once per week" hold across replicas.

const COUNT_COLUMNS = [
  'builds',
  'checks',
  'auto_passed',
  'needed_review',
  'approved',
  'rejected',
  'rejected_not_loaded',
  'rejected_late_asset',
  'rejected_animation',
  'rejected_dynamic_data',
  'rejected_environment',
  'rejected_real_bug',
  'rejected_other',
  'rejected_uncategorized',
  'outdated',
  'pending',
  'errors',
  'suggestions',
  'suggestions_accepted',
  'suggestions_dismissed',
  'decided_builds',
  'latency_sum_ms',
  'screenshot_ms',
  'upload_ms',
  'compare_ms',
  'retakes',
  'timed_checks',
  'flaky_screens',
];

export async function up(db: Kysely<unknown>): Promise<void> {
  let days = db.schema
    .createTable('insight_days')
    .addColumn('project_id', 'text', (c) => c.notNull().references('projects.id').onDelete('cascade'))
    .addColumn('branch', 'text', (c) => c.notNull())
    .addColumn('day', 'integer', (c) => c.notNull())
    .addColumn('part', 'text', (c) => c.notNull());
  for (const column of COUNT_COLUMNS) days = days.addColumn(column, 'bigint', (c) => c.notNull().defaultTo(0));
  await days
    .addColumn('latency_hist', 'text', (c) => c.notNull().defaultTo('[]'))
    .addColumn('reviewers', 'text', (c) => c.notNull().defaultTo('{}'))
    .addColumn('computed_at', 'bigint', (c) => c.notNull().defaultTo(0))
    .addPrimaryKeyConstraint('insight_days_pk', ['project_id', 'branch', 'day', 'part'])
    .addCheckConstraint('insight_days_part_check', sql`part in ('live', 'kept')`)
    .execute();

  await db.schema
    .createTable('insight_marks')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('project_id', 'text', (c) => c.notNull().references('projects.id').onDelete('cascade'))
    .addColumn('branch', 'text', (c) => c.notNull())
    .addColumn('day', 'integer', (c) => c.notNull())
    .addColumn('created_at', 'bigint', (c) => c.notNull())
    .execute();
  await db.schema.createIndex('insight_marks_project_idx').on('insight_marks').column('project_id').execute();
  // Backfill: one mark per day that has builds; ids sort before any made later (ULIDs).
  await sql`insert into insight_marks (id, project_id, branch, day, created_at)
    select 'imk_0' || project_id || '_' || cast(day as text) || '_' || branch, project_id, branch, day, 0
    from (select distinct project_id, branch, created_at / 86400000 as day from builds) as days`.execute(db);

  await db.schema
    .createTable('insight_digest_settings')
    .addColumn('project_id', 'text', (c) => c.primaryKey().references('projects.id').onDelete('cascade'))
    .addColumn('enabled', 'integer', (c) => c.notNull().defaultTo(0))
    // 0 Sunday … 6 Saturday, and the hour, in the server's time zone (TZ).
    .addColumn('weekday', 'integer', (c) => c.notNull().defaultTo(1))
    .addColumn('hour', 'integer', (c) => c.notNull().defaultTo(9))
    .addColumn('updated_at', 'bigint', (c) => c.notNull())
    .execute();
  await db.schema
    .createTable('insight_digest_subscribers')
    .addColumn('project_id', 'text', (c) => c.notNull().references('projects.id').onDelete('cascade'))
    .addColumn('user_id', 'text', (c) => c.notNull().references('users.id').onDelete('cascade'))
    .addColumn('created_at', 'bigint', (c) => c.notNull())
    .addPrimaryKeyConstraint('insight_digest_subscribers_pk', ['project_id', 'user_id'])
    .execute();
  await db.schema
    .createTable('insight_digests')
    .addColumn('project_id', 'text', (c) => c.notNull().references('projects.id').onDelete('cascade'))
    // The scheduled slot (`2026-10-19T09` in server time) or `manual:<id>` for Send now.
    .addColumn('slot', 'text', (c) => c.notNull())
    .addColumn('kind', 'text', (c) => c.notNull())
    .addColumn('webhooks', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('mails', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('sent_at', 'bigint', (c) => c.notNull())
    .addPrimaryKeyConstraint('insight_digests_pk', ['project_id', 'slot'])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const table of [
    'insight_digests',
    'insight_digest_subscribers',
    'insight_digest_settings',
    'insight_marks',
    'insight_days',
  ]) {
    await db.schema.dropTable(table).execute();
  }
}
