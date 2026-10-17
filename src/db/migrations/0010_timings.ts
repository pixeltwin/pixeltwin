import type { Kysely } from 'kysely';

// How long pixeltwin took in a run. A check records its server time (compare and store); a build
// adds up what the SDK measured in its workers: screenshots, uploads and retakes.

const BUILD_COLUMNS = ['timing_checks', 'timing_screenshot_ms', 'timing_upload_ms', 'timing_retakes'];

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('checks').addColumn('compare_ms', 'integer').execute();
  for (const column of BUILD_COLUMNS) {
    await db.schema
      .alterTable('builds')
      .addColumn(column, 'bigint', (c) => c.notNull().defaultTo(0))
      .execute();
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const column of BUILD_COLUMNS) await db.schema.alterTable('builds').dropColumn(column).execute();
  await db.schema.alterTable('checks').dropColumn('compare_ms').execute();
}
