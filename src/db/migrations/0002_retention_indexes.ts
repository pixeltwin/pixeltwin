import type { Kysely } from 'kysely';

// Retention and image GC look rows up by image sha and by age; without these indexes every
// "is this image still referenced?" check scans the whole checks table.

const INDEXES: Array<[name: string, table: string, columns: string[]]> = [
  ['checks_image_sha_idx', 'checks', ['image_sha']],
  ['checks_diff_image_sha_idx', 'checks', ['diff_image_sha']],
  ['checks_project_idx', 'checks', ['project_id']],
  ['baselines_image_sha_idx', 'baselines', ['image_sha']],
  ['builds_project_created_idx', 'builds', ['project_id', 'created_at']],
  ['images_created_idx', 'images', ['created_at']],
];

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const [name, table, columns] of INDEXES) {
    await db.schema.createIndex(name).on(table).columns(columns).execute();
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const [name] of [...INDEXES].reverse()) {
    await db.schema.dropIndex(name).execute();
  }
}
