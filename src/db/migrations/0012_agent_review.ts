import { type Kysely, SqliteAdapter, sql } from 'kysely';

// Agents that review visual changes.
// - element_sets: the page elements an SDK measured with a screenshot (key, role, box, text),
//   stored once per content hash. A check and the baseline made from it point at their set, so a
//   baseline keeps its elements after retention deletes the check, and a promotion copies the sha.
// - A project's agent review policy: off (tokens review as people do), suggest (a token's review
//   is a suggestion a person accepts or dismisses) or auto-below (token approvals of a diff up to
//   agent_max_diff_percent apply, larger ones become suggestions).
// - checks.suggestion*: the open suggestion of a check; review_events records who acted (a user,
//   a token with its name, or auto-approve) and the suggestion actions.

const BEFORE = `action in ('approved', 'rejected', 'reset')`;
const AFTER = `action in ('approved', 'rejected', 'reset', 'suggested_approval', 'suggested_rejection', 'suggestion_dismissed')`;

const CHECK_COLUMNS: Array<[string, 'text' | 'bigint']> = [
  ['elements_sha', 'text'],
  ['suggestion', 'text'],
  ['suggested_by', 'text'],
  ['suggested_by_name', 'text'],
  ['suggestion_reason', 'text'],
  ['suggested_at', 'bigint'],
];

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('element_sets')
    .addColumn('sha', 'text', (c) => c.primaryKey())
    .addColumn('data', 'text', (c) => c.notNull())
    .addColumn('count', 'integer', (c) => c.notNull())
    .addColumn('created_at', 'bigint', (c) => c.notNull())
    .execute();
  await db.schema.createIndex('element_sets_created_idx').on('element_sets').column('created_at').execute();

  for (const [column, type] of CHECK_COLUMNS) await db.schema.alterTable('checks').addColumn(column, type).execute();
  await db.schema.alterTable('baselines').addColumn('elements_sha', 'text').execute();
  // Element GC asks "is this set still referenced?" like image GC does for images.
  await db.schema.createIndex('checks_elements_sha_idx').on('checks').column('elements_sha').execute();
  await db.schema.createIndex('baselines_elements_sha_idx').on('baselines').column('elements_sha').execute();

  await db.schema
    .alterTable('projects')
    .addColumn('agent_review', 'text', (c) => c.notNull().defaultTo('off'))
    .execute();
  await db.schema
    .alterTable('projects')
    .addColumn('agent_max_diff_percent', 'double precision', (c) => c.notNull().defaultTo(1))
    .execute();

  await db.schema
    .alterTable('review_events')
    .addColumn('actor_kind', 'text', (c) => c.notNull().defaultTo('user'))
    .execute();
  await db.schema.alterTable('review_events').addColumn('actor_name', 'text').execute();
  await setActions(db, BEFORE, AFTER);
  // Who acted in the reviews made so far: auto-approve, a project token (with its name), else a user.
  await sql`update review_events set actor_kind = 'auto' where actor = 'auto'`.execute(db);
  await sql`
    update review_events set actor_kind = 'token',
      actor_name = (select t.name from project_tokens t where t.id = review_events.actor)
    where exists (select 1 from project_tokens t where t.id = review_events.actor)
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`delete from review_events where action not in ('approved', 'rejected', 'reset')`.execute(db);
  await setActions(db, AFTER, BEFORE);
  await db.schema.alterTable('review_events').dropColumn('actor_name').execute();
  await db.schema.alterTable('review_events').dropColumn('actor_kind').execute();
  await db.schema.alterTable('projects').dropColumn('agent_max_diff_percent').execute();
  await db.schema.alterTable('projects').dropColumn('agent_review').execute();
  await db.schema.dropIndex('baselines_elements_sha_idx').execute();
  await db.schema.dropIndex('checks_elements_sha_idx').execute();
  await db.schema.alterTable('baselines').dropColumn('elements_sha').execute();
  for (const [column] of [...CHECK_COLUMNS].reverse())
    await db.schema.alterTable('checks').dropColumn(column).execute();
  await db.schema.dropTable('element_sets').execute();
}

/**
 * Replaces the `review_events.action` check constraint. Postgres alters it in place; SQLite
 * rebuilds the table as migration 0006 does for checks (nothing references review_events).
 */
async function setActions(db: Kysely<unknown>, from: string, to: string): Promise<void> {
  if (!(db.getExecutor().adapter instanceof SqliteAdapter)) {
    await sql`alter table review_events drop constraint review_events_action_check`.execute(db);
    await sql`alter table review_events add constraint review_events_action_check check (${sql.raw(to)})`.execute(db);
    return;
  }
  const table = await sql<{
    sql: string;
  }>`select sql from sqlite_master where type = 'table' and name = 'review_events'`.execute(db);
  const create = table.rows[0]?.sql ?? '';
  if (!create.includes(from)) throw new Error(`review_events has no constraint "${from}"`);
  const indexes = await sql<{ sql: string }>`
    select sql from sqlite_master where tbl_name = 'review_events' and type in ('index', 'trigger') and sql is not null
  `.execute(db);
  await sql`pragma foreign_keys = off`.execute(db);
  try {
    await db.transaction().execute(async (tx) => {
      const rebuilt = create
        .replace(from, to)
        .replace(/^CREATE TABLE\s+"?review_events"?/i, 'CREATE TABLE "review_events_rebuilt"');
      await sql.raw(rebuilt).execute(tx);
      await sql`insert into review_events_rebuilt select * from review_events`.execute(tx);
      await sql`drop table review_events`.execute(tx);
      await sql`alter table review_events_rebuilt rename to review_events`.execute(tx);
      for (const index of indexes.rows) await sql.raw(index.sql).execute(tx);
      const broken = await sql`pragma foreign_key_check`.execute(tx);
      if (broken.rows.length > 0) throw new Error('rebuilding review_events broke foreign keys');
    });
  } finally {
    await sql`pragma foreign_keys = on`.execute(db);
  }
}
