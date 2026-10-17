import { sql } from 'kysely';
import { z } from 'zod';
import { isUniqueViolation } from '../db/database';
import { PROJECT_ROLES, type ProjectRole, type UserRole } from '../db/schema';
import { AppError } from '../errors';
import { emailSchema } from './auth/users';
import type { Deps, MemberAdded } from './deps';
import { getProjectBySlug } from './projects';
import { parseInput } from './schemas';

type DbDeps = Pick<Deps, 'db' | 'events'>;

export const projectRoleSchema = z.enum(PROJECT_ROLES);

/** Without a role, the user's global role (viewer or reviewer) is used. */
export const addMemberSchema = z.strictObject({ email: emailSchema, role: projectRoleSchema.optional() });
export const updateMemberSchema = z.strictObject({ role: projectRoleSchema });

/** What a search for users to add needs: at least 2 characters, so it never lists everyone. */
export const candidateQuerySchema = z.string().trim().min(2, 'Type at least 2 characters').max(254);
export const CANDIDATE_LIMIT = 10;

export interface CandidateView {
  id: string;
  email: string;
  /** The global role: the default when added without one. */
  role: UserRole;
}

export interface MemberView {
  userId: string;
  email: string;
  role: ProjectRole;
  createdAt: number;
}

function memberNotFound(userId: string, slug: string): AppError {
  return new AppError('member_not_found', 404, `User ${userId} is not a member of project "${slug}".`);
}

/** Nobody changes their own access: a maintainer could otherwise lock themselves out by accident. */
function refuseOwn(userId: string, actorId: string): void {
  if (userId === actorId) {
    throw new AppError(
      'own_membership',
      409,
      'You cannot change your own membership; ask an admin or another maintainer.',
    );
  }
}

export async function listMembers(deps: DbDeps, slug: string): Promise<MemberView[]> {
  const project = await getProjectBySlug(deps, slug);
  return deps.db
    .selectFrom('projectMembers')
    .innerJoin('users', 'users.id', 'projectMembers.userId')
    .select(['projectMembers.userId', 'users.email', 'projectMembers.role', 'projectMembers.createdAt'])
    .where('projectMembers.projectId', '=', project.id)
    .orderBy('users.email')
    .execute();
}

/**
 * Gives an existing user access to the project. Admins already have access to every project.
 * `by` (who adds them) and `via` go to the `member.added` webhook.
 */
export async function addMember(
  deps: DbDeps,
  slug: string,
  input: unknown,
  added: { by?: string | null; via?: MemberAdded['via'] } = {},
): Promise<MemberView> {
  const { email, role } = parseInput(addMemberSchema, input);
  const project = await getProjectBySlug(deps, slug);
  const user = await deps.db
    .selectFrom('users')
    .select(['id', 'email', 'role', 'status'])
    .where('email', '=', email)
    .executeTakeFirst();
  if (!user) throw new AppError('user_not_found', 404, `No user has the email ${email}. Invite them instead.`);
  if (user.role === 'admin') {
    throw new AppError('user_is_admin', 409, `${email} is an admin and already has access to every project.`);
  }
  if (user.status !== 'active') {
    throw new AppError('account_pending', 409, `${email} has asked for access; an admin approves it under Users.`);
  }
  const member: MemberView = { userId: user.id, email: user.email, role: role ?? user.role, createdAt: Date.now() };
  try {
    await deps.db
      .insertInto('projectMembers')
      .values({ projectId: project.id, userId: user.id, role: member.role, createdAt: member.createdAt })
      .execute();
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new AppError('already_member', 409, `${email} is already a member; change their role instead.`);
    }
    throw err;
  }
  await deps.events?.memberAdded?.({
    projectId: project.id,
    userId: user.id,
    role: member.role,
    via: added.via ?? 'member',
    by: added.by ?? null,
  });
  return member;
}

export async function updateMember(
  deps: DbDeps,
  slug: string,
  userId: string,
  input: unknown,
  actorId: string,
): Promise<MemberView> {
  const { role } = parseInput(updateMemberSchema, input);
  const project = await getProjectBySlug(deps, slug);
  const member = (await listMembers(deps, slug)).find((m) => m.userId === userId);
  if (!member) throw memberNotFound(userId, slug);
  refuseOwn(userId, actorId);
  await deps.db
    .updateTable('projectMembers')
    .set({ role })
    .where('projectId', '=', project.id)
    .where('userId', '=', userId)
    .execute();
  return { ...member, role };
}

export async function removeMember(deps: DbDeps, slug: string, userId: string, actorId: string): Promise<void> {
  const project = await getProjectBySlug(deps, slug);
  const member = await deps.db
    .selectFrom('projectMembers')
    .select('userId')
    .where('projectId', '=', project.id)
    .where('userId', '=', userId)
    .executeTakeFirst();
  if (!member) throw memberNotFound(userId, slug);
  refuseOwn(userId, actorId);
  await deps.db.deleteFrom('projectMembers').where('projectId', '=', project.id).where('userId', '=', userId).execute();
}

/** Each user's memberships (of one user with `userId`), by project slug. */
export async function membershipsOf(
  deps: DbDeps,
  userId?: string,
): Promise<Map<string, Array<{ slug: string; name: string; role: ProjectRole }>>> {
  let query = deps.db
    .selectFrom('projectMembers')
    .innerJoin('projects', 'projects.id', 'projectMembers.projectId')
    .select(['projectMembers.userId', 'projects.slug', 'projects.name', 'projectMembers.role'])
    .orderBy('projects.slug');
  if (userId) query = query.where('projectMembers.userId', '=', userId);
  const out = new Map<string, Array<{ slug: string; name: string; role: ProjectRole }>>();
  for (const { userId: id, ...membership } of await query.execute()) {
    out.set(id, [...(out.get(id) ?? []), membership]);
  }
  return out;
}

/**
 * Users who could be added to the project: email contains `q` (case-insensitive; `%` and `_` are
 * literal), not a member yet, not an admin (admins have every project). At most 10, by email.
 */
export async function memberCandidates(deps: DbDeps, slug: string, q: unknown): Promise<CandidateView[]> {
  const query = parseInput(candidateQuerySchema, q).toLowerCase();
  const project = await getProjectBySlug(deps, slug);
  const pattern = `%${query.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
  return deps.db
    .selectFrom('users')
    .select(['id', 'email', 'role'])
    .where('role', '!=', 'admin')
    .where('status', '=', 'active')
    .where(sql<boolean>`lower(email) like ${pattern} escape '\\'`)
    .where((eb) =>
      eb.not(
        eb.exists(
          eb
            .selectFrom('projectMembers')
            .select('userId')
            .whereRef('projectMembers.userId', '=', 'users.id')
            .where('projectMembers.projectId', '=', project.id),
        ),
      ),
    )
    .orderBy('email')
    .limit(CANDIDATE_LIMIT)
    .execute();
}
