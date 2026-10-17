import { type Kysely, sql } from 'kysely';

// Per-project access for users. A membership gives a non-admin user a role in one project; a
// project visible to everyone lets every user in with their global role. Nobody may lose access
// on upgrade: every existing non-admin user becomes a member of every existing project with the
// role they had everywhere until now.

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
  await sql`
    insert into project_members (project_id, user_id, role, created_at)
    select p.id, u.id, u.role, ${Date.now()} from projects p cross join users u where u.role <> 'admin'
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('projects').dropColumn('visible_to_all').execute();
  await db.schema.dropTable('project_members').execute();
}
