import { type Kysely, sql } from 'kysely';

// Per-project access for users. A membership gives a non-admin user a role in one project; a
// project visible to everyone lets every user in with their global role. Nobody may lose access
// on upgrade: every existing non-admin user becomes a member of every existing project with the
// role they had everywhere until now.
//
// Getting people in without passing passwords around (all on this branch, so one migration):
// one-time links (invites, password resets, email checks; only their sha256 is stored), a user's
// status (pending while an admin has not approved their sign-up), access requests, and server
// settings (whether people may sign up).

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('project_members')
    .addColumn('project_id', 'text', (c) => c.notNull().references('projects.id').onDelete('cascade'))
    .addColumn('user_id', 'text', (c) => c.notNull().references('users.id').onDelete('cascade'))
    .addColumn('role', 'text', (c) => c.notNull())
    .addColumn('created_at', 'bigint', (c) => c.notNull())
    .addPrimaryKeyConstraint('project_members_pk', ['project_id', 'user_id'])
    .addCheckConstraint('project_members_role_check', sql`role in ('viewer', 'reviewer', 'maintainer')`)
    .execute();
  await db.schema.createIndex('project_members_user_idx').on('project_members').column('user_id').execute();
  await db.schema
    .alterTable('projects')
    .addColumn('visible_to_all', 'integer', (c) => c.notNull().defaultTo(0))
    .execute();
  await db.schema
    .createTable('auth_links')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('purpose', 'text', (c) => c.notNull())
    .addColumn('token_hash', 'text', (c) => c.notNull().unique())
    .addColumn('email', 'text', (c) => c.notNull())
    .addColumn('user_id', 'text', (c) => c.references('users.id').onDelete('cascade'))
    .addColumn('project_id', 'text', (c) => c.references('projects.id').onDelete('cascade'))
    .addColumn('project_role', 'text')
    .addColumn('global_role', 'text')
    .addColumn('created_by', 'text')
    .addColumn('created_at', 'bigint', (c) => c.notNull())
    .addColumn('expires_at', 'bigint', (c) => c.notNull())
    .addColumn('used_at', 'bigint')
    .addCheckConstraint('auth_links_purpose_check', sql`purpose in ('invite', 'password_reset', 'verify_email')`)
    .execute();
  await db.schema.createIndex('auth_links_email_idx').on('auth_links').column('email').execute();
  await db.schema
    .alterTable('users')
    .addColumn('status', 'text', (c) =>
      c.notNull().defaultTo('active').check(sql`status in ('active', 'pending', 'rejected')`),
    )
    .execute();
  await db.schema.alterTable('users').addColumn('name', 'text').execute();
  await db.schema
    .createTable('access_requests')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('user_id', 'text', (c) => c.notNull().unique().references('users.id').onDelete('cascade'))
    .addColumn('note', 'text')
    .addColumn('verified_at', 'bigint')
    .addColumn('status', 'text', (c) => c.notNull())
    .addColumn('decided_by', 'text')
    .addColumn('decided_at', 'bigint')
    .addColumn('reason', 'text')
    .addColumn('created_at', 'bigint', (c) => c.notNull())
    .addCheckConstraint('access_requests_status_check', sql`status in ('pending', 'approved', 'rejected')`)
    .execute();
  await db.schema
    .createTable('server_settings')
    .addColumn('key', 'text', (c) => c.primaryKey())
    .addColumn('value', 'text', (c) => c.notNull())
    .execute();
  await sql`
    insert into project_members (project_id, user_id, role, created_at)
    select p.id, u.id, u.role, ${Date.now()} from projects p cross join users u where u.role <> 'admin'
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('server_settings').execute();
  await db.schema.dropTable('access_requests').execute();
  await db.schema.alterTable('users').dropColumn('name').execute();
  await db.schema.alterTable('users').dropColumn('status').execute();
  await db.schema.dropTable('auth_links').execute();
  await db.schema.alterTable('projects').dropColumn('visible_to_all').execute();
  await db.schema.dropTable('project_members').execute();
}
