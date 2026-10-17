import type { Kysely } from 'kysely';

// Why a check was rejected, as a category agents can act on (not_loaded, late_asset, animation,
// dynamic_data, environment, real_bug, other) beside the free comment. On the review event, so the
// screen's rejections can be read back and learned from; on the check (its current review) and on
// its open suggestion, so a build card and an accepted suggestion keep it. Plain text, checked by
// the API: a new category needs no table rebuild. The index serves a project's rejections, newest
// first (rejection patterns).

const CHECK_COLUMNS = ['review_reason_code', 'suggestion_reason_code'];

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('review_events').addColumn('reason_code', 'text').execute();
  for (const column of CHECK_COLUMNS) await db.schema.alterTable('checks').addColumn(column, 'text').execute();
  await db.schema
    .createIndex('review_events_project_action_idx')
    .on('review_events')
    .columns(['project_id', 'action', 'id'])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex('review_events_project_action_idx').execute();
  for (const column of [...CHECK_COLUMNS].reverse()) await db.schema.alterTable('checks').dropColumn(column).execute();
  await db.schema.alterTable('review_events').dropColumn('reason_code').execute();
}
