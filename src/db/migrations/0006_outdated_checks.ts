import { type Kysely, SqliteAdapter, sql } from 'kysely';

// A check becomes `outdated` when a newer build of its branch approved the same screen: approving
// it then would put an older screenshot over the newer baseline. `superseded_by` names the check
// whose approval did it, so undoing that approval can bring the older checks back to review.

const BEFORE = `review in ('none', 'pending', 'approved', 'rejected')`;
const AFTER = `review in ('none', 'pending', 'approved', 'rejected', 'outdated')`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await setReviewStates(db, BEFORE, AFTER);
  await db.schema.alterTable('checks').addColumn('superseded_by', 'text').execute();
  // Existing pending checks that a newer build of their branch already approved.
  await sql`
    update checks set review = 'outdated', superseded_by = (
      select b.source_check_id from baselines b
      join checks sc on sc.id = b.source_check_id
      join builds sb on sb.id = sc.build_id
      join builds cb on cb.id = checks.build_id
      where b.project_id = checks.project_id and b.snapshot_key = checks.snapshot_key
        and b.branch = cb.branch and sb.number > cb.number
      order by sb.number desc limit 1)
    where review = 'pending' and exists (
      select 1 from baselines b
      join checks sc on sc.id = b.source_check_id
      join builds sb on sb.id = sc.build_id
      join builds cb on cb.id = checks.build_id
      where b.project_id = checks.project_id and b.snapshot_key = checks.snapshot_key
        and b.branch = cb.branch and sb.number > cb.number)
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`update checks set review = 'pending' where review = 'outdated'`.execute(db);
  await db.schema.alterTable('checks').dropColumn('superseded_by').execute();
  await setReviewStates(db, AFTER, BEFORE);
}

/**
 * Replaces the `checks.review` check constraint. Postgres alters it in place. SQLite cannot, and
 * Bun's SQLite refuses edits to its schema table, so the table is rebuilt the way SQLite
 * documents it (§7 of “ALTER TABLE”): foreign keys off, new table, copy, drop, rename, indexes.
 */
async function setReviewStates(db: Kysely<unknown>, from: string, to: string): Promise<void> {
  if (!(db.getExecutor().adapter instanceof SqliteAdapter)) {
    await sql`alter table checks drop constraint checks_review_check`.execute(db);
    await sql`alter table checks add constraint checks_review_check check (${sql.raw(to)})`.execute(db);
    return;
  }
  const table = await sql<{
    sql: string;
  }>`select sql from sqlite_master where type = 'table' and name = 'checks'`.execute(db);
  const create = table.rows[0]?.sql ?? '';
  if (!create.includes(from)) throw new Error(`checks has no constraint "${from}"`);
  const indexes = await sql<{ sql: string }>`
    select sql from sqlite_master where tbl_name = 'checks' and type in ('index', 'trigger') and sql is not null
  `.execute(db);
  // Outside the transaction: SQLite ignores this pragma inside one.
  await sql`pragma foreign_keys = off`.execute(db);
  try {
    await db.transaction().execute(async (tx) => {
      const rebuilt = create.replace(from, to).replace(/^CREATE TABLE\s+"?checks"?/i, 'CREATE TABLE "checks_rebuilt"');
      await sql.raw(rebuilt).execute(tx);
      await sql`insert into checks_rebuilt select * from checks`.execute(tx);
      await sql`drop table checks`.execute(tx);
      await sql`alter table checks_rebuilt rename to checks`.execute(tx);
      for (const index of indexes.rows) await sql.raw(index.sql).execute(tx);
      const broken = await sql`pragma foreign_key_check`.execute(tx);
      if (broken.rows.length > 0) throw new Error('rebuilding checks broke foreign keys');
    });
  } finally {
    await sql`pragma foreign_keys = on`.execute(db);
  }
}
