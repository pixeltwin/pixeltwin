import type { Kysely } from 'kysely';

// Change groups and flaky screens. `change_key` is the set of a changed check's change
// fingerprints (diff/fingerprint.ts): checks of one build with the same key form a change group,
// reviewed at once. Older checks keep null (no backfill: they would need both images decoded
// again, and retention removes them within days). The snapshot index serves a screen's history
// (its last checks on a branch), from which flaky screens are found on read.

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('checks').addColumn('change_key', 'text').execute();
  await db.schema.createIndex('checks_build_change_idx').on('checks').columns(['build_id', 'change_key']).execute();
  await db.schema.createIndex('checks_snapshot_idx').on('checks').columns(['project_id', 'snapshot_key']).execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex('checks_snapshot_idx').execute();
  await db.schema.dropIndex('checks_build_change_idx').execute();
  await db.schema.alterTable('checks').dropColumn('change_key').execute();
}
