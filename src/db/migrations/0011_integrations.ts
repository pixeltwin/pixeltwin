import type { Kysely } from 'kysely';

// pixeltwin reaches the pull request. A build knows its repository and pull request (the commit was
// already there). A project may have one code host integration, GitHub or GitLab (commit status,
// one pull/merge request comment per build, auto-promote on merge), and outgoing webhooks. What has
// to be sent waits in tables, so it survives a restart and only one replica sends each item:
// `integration_syncs` (one row per build: post its current state, coalesced) and
// `webhook_deliveries` (one row per event and webhook, kept for the UI's history).
// `integration_merges` records each merged pull request handled, so a redelivery promotes once.

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('builds').addColumn('repository', 'text').execute();
  await db.schema.alterTable('builds').addColumn('pull_request', 'integer').execute();
  // The verdict last announced (finalize or build.verdict_changed): a change is announced once.
  await db.schema.alterTable('builds').addColumn('notified_verdict', 'text').execute();

  await db.schema
    .createTable('integrations')
    .addColumn('project_id', 'text', (c) => c.primaryKey().references('projects.id').onDelete('cascade'))
    // `github` or `gitlab`: one code host per project.
    .addColumn('provider', 'text', (c) => c.notNull())
    .addColumn('repository', 'text')
    // GitHub's API URL (https://api.github.com, or GHES' https://host/api/v3) or the GitLab instance URL.
    .addColumn('base_url', 'text', (c) => c.notNull())
    // Sealed (encrypted with SECRET_KEY when set); the last four characters are kept apart to show.
    .addColumn('token', 'text')
    .addColumn('token_last4', 'text')
    .addColumn('commit_status', 'integer', (c) => c.notNull().defaultTo(1))
    .addColumn('pr_comment', 'integer', (c) => c.notNull().defaultTo(1))
    .addColumn('auto_promote', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('webhook_secret', 'text')
    .addColumn('created_at', 'bigint', (c) => c.notNull())
    .addColumn('updated_at', 'bigint', (c) => c.notNull())
    .execute();
  await db.schema.createIndex('integrations_repository').on('integrations').column('repository').execute();

  await db.schema
    .createTable('integration_syncs')
    .addColumn('build_id', 'text', (c) => c.primaryKey().references('builds.id').onDelete('cascade'))
    .addColumn('project_id', 'text', (c) => c.notNull().references('projects.id').onDelete('cascade'))
    // Bumped by every change; the sync is due while `requested` is ahead of `done`.
    .addColumn('requested', 'integer', (c) => c.notNull())
    .addColumn('done', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('due_at', 'bigint', (c) => c.notNull())
    .addColumn('locked_until', 'bigint')
    .addColumn('attempts', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('comment_id', 'text')
    .addColumn('last_error', 'text')
    .addColumn('synced_at', 'bigint')
    .addColumn('updated_at', 'bigint', (c) => c.notNull())
    .execute();
  await db.schema.createIndex('integration_syncs_due').on('integration_syncs').column('due_at').execute();
  await db.schema
    .createIndex('integration_syncs_project')
    .on('integration_syncs')
    .columns(['project_id', 'updated_at'])
    .execute();

  await db.schema
    .createTable('integration_merges')
    .addColumn('project_id', 'text', (c) => c.notNull().references('projects.id').onDelete('cascade'))
    .addColumn('provider', 'text', (c) => c.notNull())
    .addColumn('repository', 'text', (c) => c.notNull())
    .addColumn('pull_request', 'integer', (c) => c.notNull())
    .addColumn('head_branch', 'text', (c) => c.notNull())
    .addColumn('base_branch', 'text', (c) => c.notNull())
    .addColumn('merge_sha', 'text')
    .addColumn('merged_by', 'text')
    .addColumn('delivery_id', 'text')
    .addColumn('promoted', 'integer')
    .addColumn('created_at', 'bigint', (c) => c.notNull())
    .addPrimaryKeyConstraint('integration_merges_pk', ['project_id', 'repository', 'pull_request'])
    .execute();

  await db.schema
    .createTable('webhooks')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('project_id', 'text', (c) => c.notNull().references('projects.id').onDelete('cascade'))
    .addColumn('url', 'text', (c) => c.notNull())
    .addColumn('secret', 'text', (c) => c.notNull())
    .addColumn('secret_last4', 'text', (c) => c.notNull())
    .addColumn('events', 'text', (c) => c.notNull())
    .addColumn('format', 'text', (c) => c.notNull())
    .addColumn('enabled', 'integer', (c) => c.notNull().defaultTo(1))
    .addColumn('created_at', 'bigint', (c) => c.notNull())
    .addColumn('updated_at', 'bigint', (c) => c.notNull())
    .execute();
  await db.schema.createIndex('webhooks_project').on('webhooks').column('project_id').execute();

  await db.schema
    .createTable('webhook_deliveries')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('webhook_id', 'text', (c) => c.notNull().references('webhooks.id').onDelete('cascade'))
    .addColumn('project_id', 'text', (c) => c.notNull())
    .addColumn('event', 'text', (c) => c.notNull())
    .addColumn('payload', 'text', (c) => c.notNull())
    .addColumn('state', 'text', (c) => c.notNull())
    .addColumn('attempts', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('due_at', 'bigint', (c) => c.notNull())
    .addColumn('locked_until', 'bigint')
    .addColumn('status_code', 'integer')
    .addColumn('error', 'text')
    .addColumn('duration_ms', 'integer')
    .addColumn('created_at', 'bigint', (c) => c.notNull())
    .addColumn('finished_at', 'bigint')
    .execute();
  await db.schema.createIndex('webhook_deliveries_due').on('webhook_deliveries').columns(['state', 'due_at']).execute();
  await db.schema
    .createIndex('webhook_deliveries_webhook')
    .on('webhook_deliveries')
    .columns(['webhook_id', 'id'])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('webhook_deliveries').execute();
  await db.schema.dropTable('webhooks').execute();
  await db.schema.dropTable('integration_merges').execute();
  await db.schema.dropTable('integration_syncs').execute();
  await db.schema.dropTable('integrations').execute();
  await db.schema.alterTable('builds').dropColumn('notified_verdict').execute();
  await db.schema.alterTable('builds').dropColumn('pull_request').execute();
  await db.schema.alterTable('builds').dropColumn('repository').execute();
}
