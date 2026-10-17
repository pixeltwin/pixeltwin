import type { Kysely } from 'kysely';

// Mail goes through the database like webhooks do (0011): an invite, a reset link or a sign-up
// mail is a row, sent in the background with retries, and with several replicas only the one
// holding the row's lease sends it. The message (recipient, subject, body: it may hold a one-time
// link) is sealed with SECRET_KEY when set and cleared once sent or given up. `dedupe_key` makes
// a mail that must go out once per period (the admins' "requests wait" note) unique across replicas.

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('mail_outbox')
    .addColumn('id', 'text', (c) => c.primaryKey())
    // What it is, for logs: invite, password reset, email check, …
    .addColumn('kind', 'text', (c) => c.notNull())
    .addColumn('message', 'text', (c) => c.notNull())
    .addColumn('dedupe_key', 'text', (c) => c.unique())
    .addColumn('state', 'text', (c) => c.notNull())
    .addColumn('attempts', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('due_at', 'bigint', (c) => c.notNull())
    .addColumn('locked_until', 'bigint')
    .addColumn('last_error', 'text')
    .addColumn('created_at', 'bigint', (c) => c.notNull())
    .addColumn('finished_at', 'bigint')
    .execute();
  await db.schema.createIndex('mail_outbox_due').on('mail_outbox').columns(['state', 'due_at']).execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('mail_outbox').execute();
}
