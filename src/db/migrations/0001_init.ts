import { type Kysely, sql } from 'kysely';

// Portable across SQLite and Postgres: text, integer, bigint (epoch ms), double precision.
// Names are snake_case; the CamelCasePlugin maps them to camelCase in TypeScript.

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('projects')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('slug', 'text', (c) => c.notNull().unique())
    .addColumn('name', 'text', (c) => c.notNull())
    .addColumn('main_branch', 'text', (c) => c.notNull())
    .addColumn('color_threshold', 'double precision', (c) => c.notNull())
    .addColumn('tolerance_percent', 'double precision', (c) => c.notNull())
    .addColumn('retention_days', 'integer', (c) => c.notNull())
    .addColumn('created_at', 'bigint', (c) => c.notNull())
    .addColumn('updated_at', 'bigint', (c) => c.notNull())
    .execute();

  await db.schema
    .createTable('images')
    .addColumn('sha', 'text', (c) => c.primaryKey())
    .addColumn('width', 'integer', (c) => c.notNull())
    .addColumn('height', 'integer', (c) => c.notNull())
    .addColumn('bytes', 'integer', (c) => c.notNull())
    .addColumn('created_at', 'bigint', (c) => c.notNull())
    .execute();

  await db.schema
    .createTable('builds')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('project_id', 'text', (c) => c.notNull().references('projects.id').onDelete('cascade'))
    .addColumn('branch', 'text', (c) => c.notNull())
    .addColumn('base_branch', 'text', (c) => c.notNull())
    .addColumn('external_id', 'text')
    .addColumn('commit_sha', 'text')
    .addColumn('state', 'text', (c) => c.notNull())
    .addColumn('created_at', 'bigint', (c) => c.notNull())
    .addColumn('finalized_at', 'bigint')
    .addCheckConstraint('builds_state_check', sql`state in ('open', 'finalized')`)
    .addUniqueConstraint('builds_project_external_unique', ['project_id', 'external_id'])
    .execute();
  await db.schema.createIndex('builds_project_idx').on('builds').columns(['project_id', 'id']).execute();

  await db.schema
    .createTable('checks')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('build_id', 'text', (c) => c.notNull().references('builds.id').onDelete('cascade'))
    .addColumn('project_id', 'text', (c) => c.notNull().references('projects.id').onDelete('cascade'))
    .addColumn('name', 'text', (c) => c.notNull())
    .addColumn('variant', 'text', (c) => c.notNull())
    .addColumn('snapshot_key', 'text', (c) => c.notNull())
    .addColumn('image_sha', 'text', (c) => c.notNull())
    .addColumn('baseline_id', 'text')
    .addColumn('diff_image_sha', 'text')
    .addColumn('ignore_regions', 'text', (c) => c.notNull())
    .addColumn('color_threshold', 'double precision', (c) => c.notNull())
    .addColumn('tolerance_percent', 'double precision', (c) => c.notNull())
    .addColumn('result', 'text', (c) => c.notNull())
    .addColumn('review', 'text', (c) => c.notNull())
    .addColumn('diff', 'text')
    .addColumn('reviewed_by', 'text')
    .addColumn('reviewed_at', 'bigint')
    .addColumn('review_comment', 'text')
    .addColumn('created_at', 'bigint', (c) => c.notNull())
    .addColumn('updated_at', 'bigint', (c) => c.notNull())
    .addCheckConstraint('checks_result_check', sql`result in ('unchanged', 'changed', 'new', 'error')`)
    .addCheckConstraint('checks_review_check', sql`review in ('none', 'pending', 'approved', 'rejected')`)
    .addUniqueConstraint('checks_build_snapshot_unique', ['build_id', 'snapshot_key'])
    .execute();

  await db.schema
    .createTable('baselines')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('project_id', 'text', (c) => c.notNull().references('projects.id').onDelete('cascade'))
    .addColumn('snapshot_key', 'text', (c) => c.notNull())
    .addColumn('name', 'text', (c) => c.notNull())
    .addColumn('variant', 'text', (c) => c.notNull())
    .addColumn('branch', 'text', (c) => c.notNull())
    .addColumn('image_sha', 'text', (c) => c.notNull())
    .addColumn('source_check_id', 'text')
    .addColumn('approved_by', 'text', (c) => c.notNull())
    .addColumn('created_at', 'bigint', (c) => c.notNull())
    .execute();
  await db.schema
    .createIndex('baselines_lookup_idx')
    .on('baselines')
    .columns(['project_id', 'snapshot_key', 'branch', 'created_at'])
    .execute();

  await db.schema
    .createTable('users')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('email', 'text', (c) => c.notNull().unique())
    .addColumn('password_hash', 'text', (c) => c.notNull())
    .addColumn('role', 'text', (c) => c.notNull())
    .addColumn('created_at', 'bigint', (c) => c.notNull())
    .addCheckConstraint('users_role_check', sql`role in ('admin', 'reviewer', 'viewer')`)
    .execute();

  await db.schema
    .createTable('project_tokens')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('project_id', 'text', (c) => c.notNull().references('projects.id').onDelete('cascade'))
    .addColumn('name', 'text', (c) => c.notNull())
    .addColumn('scopes', 'text', (c) => c.notNull())
    .addColumn('prefix', 'text', (c) => c.notNull().unique())
    .addColumn('secret_hash', 'text', (c) => c.notNull())
    .addColumn('last_used_at', 'bigint')
    .addColumn('created_at', 'bigint', (c) => c.notNull())
    .execute();

  await db.schema
    .createTable('sessions')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('user_id', 'text', (c) => c.notNull().references('users.id').onDelete('cascade'))
    .addColumn('token_hash', 'text', (c) => c.notNull().unique())
    .addColumn('expires_at', 'bigint', (c) => c.notNull())
    .addColumn('created_at', 'bigint', (c) => c.notNull())
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const table of ['sessions', 'project_tokens', 'users', 'baselines', 'checks', 'builds', 'images', 'projects']) {
    await db.schema.dropTable(table).execute();
  }
}
