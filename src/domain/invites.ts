import { z } from 'zod';
import { PROJECT_ROLES, type ProjectRole, USER_ROLES, type UserRole, type UserRow } from '../db/schema';
import { AppError } from '../errors';
import { consumeLink, createLink, findLink, type LinkRow } from './auth/links';
import { hashPassword } from './auth/password';
import { emailSchema, insertUser, passwordSchema } from './auth/users';
import type { Deps } from './deps';
import { addMember, type MemberView } from './members';
import { getProjectBySlug } from './projects';
import { parseInput } from './schemas';

type DbDeps = Pick<Deps, 'db'>;

/** A maintainer (or admin) invites into one project, with a project role (viewer by default). */
export const projectInviteSchema = z.strictObject({
  email: emailSchema,
  role: z.enum(PROJECT_ROLES).default('viewer'),
});

/** An admin invites to the server: a global role, and optionally a project with a role. */
export const serverInviteSchema = z.strictObject({
  email: emailSchema,
  role: z.enum(USER_ROLES).default('viewer'),
  project: z.string().min(1).optional(),
  projectRole: z.enum(PROJECT_ROLES).optional(),
});

export const acceptInviteSchema = z.strictObject({ password: passwordSchema });

export interface InviteView {
  id: string;
  email: string;
  project: { slug: string; name: string } | null;
  projectRole: ProjectRole | null;
  /** The new user's global role; null: viewer. */
  role: UserRole | null;
  invitedBy: string | null;
  createdAt: number;
  expiresAt: number;
}

/** An email with an account gets a membership at once; anyone else an invite link. */
export type InviteResult =
  | { kind: 'member'; member: MemberView }
  | { kind: 'invite'; invite: InviteView; token: string };

function inviteNotFound(id: string): AppError {
  return new AppError('invite_not_found', 404, `Invite ${id} not found.`);
}

async function hasAccount(deps: DbDeps, email: string): Promise<boolean> {
  return !!(await deps.db.selectFrom('users').select('id').where('email', '=', email).executeTakeFirst());
}

function pending(deps: DbDeps) {
  return deps.db
    .selectFrom('authLinks')
    .leftJoin('projects', 'projects.id', 'authLinks.projectId')
    .leftJoin('users', 'users.id', 'authLinks.createdBy')
    .select([
      'authLinks.id',
      'authLinks.email',
      'authLinks.projectId',
      'authLinks.projectRole',
      'authLinks.globalRole',
      'authLinks.createdAt',
      'authLinks.expiresAt',
      'projects.slug',
      'projects.name',
      'users.email as invitedBy',
    ])
    .where('authLinks.purpose', '=', 'invite')
    .where('authLinks.usedAt', 'is', null)
    .where('authLinks.expiresAt', '>', Date.now());
}

type PendingRow = Awaited<ReturnType<ReturnType<typeof pending>['execute']>>[number];

function toView(row: PendingRow): InviteView {
  return {
    id: row.id,
    email: row.email,
    project: row.slug && row.name ? { slug: row.slug, name: row.name } : null,
    projectRole: row.projectRole,
    role: row.globalRole,
    invitedBy: row.invitedBy,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
  };
}

/** A pending invite (not used, not expired), with its project and who sent it. */
export async function getInvite(deps: DbDeps, id: string): Promise<InviteView> {
  const row = await pending(deps).where('authLinks.id', '=', id).executeTakeFirst();
  if (!row) throw inviteNotFound(id);
  return toView(row);
}

/** Pending invites, newest first: of one project, or (null) all of them. */
export async function listInvites(deps: DbDeps, projectId: string | null): Promise<InviteView[]> {
  let query = pending(deps).orderBy('authLinks.createdAt', 'desc');
  if (projectId) query = query.where('authLinks.projectId', '=', projectId);
  return (await query.execute()).map(toView);
}

/** Invites an email into a project. Re-inviting the same email there replaces the older link. */
export async function inviteToProject(
  deps: DbDeps,
  slug: string,
  input: unknown,
  actorId: string,
): Promise<InviteResult> {
  const { email, role } = parseInput(projectInviteSchema, input);
  const project = await getProjectBySlug(deps, slug);
  if (await hasAccount(deps, email)) return { kind: 'member', member: await addMember(deps, slug, { email, role }) };
  const { id, token } = await createLink(deps.db, {
    purpose: 'invite',
    email,
    projectId: project.id,
    projectRole: role,
    createdBy: actorId,
  });
  return { kind: 'invite', invite: await getInvite(deps, id), token };
}

/** An admin's invite: a global role, optionally into a project. An account gets the membership. */
export async function inviteToServer(deps: DbDeps, input: unknown, actorId: string): Promise<InviteResult> {
  const { email, role, project: slug, projectRole } = parseInput(serverInviteSchema, input);
  const project = slug ? await getProjectBySlug(deps, slug) : null;
  if (await hasAccount(deps, email)) {
    if (!project) throw new AppError('email_taken', 409, `${email} already has an account.`);
    return {
      kind: 'member',
      member: await addMember(deps, project.slug, { email, ...(projectRole ? { role: projectRole } : {}) }),
    };
  }
  const { id, token } = await createLink(deps.db, {
    purpose: 'invite',
    email,
    // Admins have every project: a project in their invite means nothing.
    projectId: role === 'admin' ? null : (project?.id ?? null),
    projectRole: project && role !== 'admin' ? (projectRole ?? (role === 'reviewer' ? 'reviewer' : 'viewer')) : null,
    globalRole: role,
    createdBy: actorId,
  });
  return { kind: 'invite', invite: await getInvite(deps, id), token };
}

/** A new link for a pending invite; the old one stops working. */
export async function resendInvite(deps: DbDeps, id: string): Promise<{ invite: InviteView; token: string }> {
  const row = await deps.db
    .selectFrom('authLinks')
    .selectAll()
    .where('id', '=', id)
    .where('purpose', '=', 'invite')
    .where('usedAt', 'is', null)
    .executeTakeFirst();
  if (!row) throw inviteNotFound(id);
  const { id: fresh, token } = await createLink(deps.db, row);
  return { invite: await getInvite(deps, fresh), token };
}

export async function revokeInvite(deps: DbDeps, id: string): Promise<void> {
  const result = await deps.db
    .deleteFrom('authLinks')
    .where('id', '=', id)
    .where('purpose', '=', 'invite')
    .where('usedAt', 'is', null)
    .executeTakeFirst();
  if (Number(result.numDeletedRows) === 0) throw inviteNotFound(id);
}

/** The project an invite (by id, used or not) belongs to; null for a server invite. For access checks. */
export async function inviteProjectId(deps: DbDeps, id: string): Promise<string | null> {
  const row = await deps.db
    .selectFrom('authLinks')
    .select('projectId')
    .where('id', '=', id)
    .where('purpose', '=', 'invite')
    .executeTakeFirst();
  if (!row) throw inviteNotFound(id);
  return row.projectId;
}

const ROLE_ORDER: UserRole[] = ['viewer', 'reviewer', 'admin'];

/**
 * Accepts an invite: creates the user with the password they chose (global role: the highest any
 * pending invite of this email gives, else viewer), applies every pending invite of the email as
 * a membership and uses them all up. Returns the new user, to log in.
 */
export async function acceptInvite(deps: DbDeps, token: string, input: unknown): Promise<UserRow> {
  const { password } = parseInput(acceptInviteSchema, input);
  const link = await findLink(deps.db, token, 'invite');
  // Hash before the transaction: argon2id takes a while and must not hold a write lock.
  const passwordHash = await hashPassword(password);
  return deps.db.transaction().execute(async (tx) => {
    if (!(await consumeLink(tx, link.id))) throw new AppError('link_used', 410, 'This link was already used.');
    const invites: LinkRow[] = await tx
      .selectFrom('authLinks')
      .selectAll()
      .where('purpose', '=', 'invite')
      .where('email', '=', link.email)
      .where('usedAt', 'is', null)
      .where('expiresAt', '>', Date.now())
      .execute();
    const all = [link, ...invites];
    const role = all
      .map((i) => i.globalRole ?? 'viewer')
      .reduce((a, b) => (ROLE_ORDER.indexOf(b) > ROLE_ORDER.indexOf(a) ? b : a), 'viewer' as UserRole);
    const user = await insertUser(tx, { email: link.email, password, role }, passwordHash).catch((err: unknown) => {
      if (err instanceof AppError && err.code === 'email_taken') {
        throw new AppError('email_taken', 409, `${link.email} already has an account; log in instead.`);
      }
      throw err;
    });
    if (role !== 'admin') {
      const memberships = new Map<string, ProjectRole>();
      for (const i of all) if (i.projectId && i.projectRole) memberships.set(i.projectId, i.projectRole);
      for (const [projectId, projectRole] of memberships) {
        await tx
          .insertInto('projectMembers')
          .values({ projectId, userId: user.id, role: projectRole, createdAt: Date.now() })
          .execute();
      }
    }
    for (const i of invites) await consumeLink(tx, i.id);
    return tx.selectFrom('users').selectAll().where('id', '=', user.id).executeTakeFirstOrThrow();
  });
}

/** What the public invite or reset page shows about its link. */
export async function describeLink(
  deps: DbDeps,
  token: string,
): Promise<{ purpose: LinkRow['purpose']; email: string; expiresAt: number; projects: string[] }> {
  const link = await findLink(deps.db, token);
  const projects =
    link.purpose === 'invite'
      ? (
          await deps.db
            .selectFrom('authLinks')
            .innerJoin('projects', 'projects.id', 'authLinks.projectId')
            .select('projects.name')
            .where('authLinks.purpose', '=', 'invite')
            .where('authLinks.email', '=', link.email)
            .where('authLinks.usedAt', 'is', null)
            .where('authLinks.expiresAt', '>', Date.now())
            .orderBy('projects.name')
            .execute()
        ).map((p) => p.name)
      : [];
  return { purpose: link.purpose, email: link.email, expiresAt: link.expiresAt, projects };
}
