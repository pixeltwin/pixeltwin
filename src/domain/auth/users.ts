import { z } from 'zod';
import type { Db } from '../../db/database';
import { isUniqueViolation } from '../../db/database';
import { USER_ROLES, type UserRole, type UserRow, type UserStatus } from '../../db/schema';
import { AppError } from '../../errors';
import { newId } from '../../ids';
import type { Deps } from '../deps';
import { parseInput } from '../schemas';
import { DUMMY_HASH, hashPassword, verifyPassword } from './password';
import { sha256 } from './random';

type DbDeps = Pick<Deps, 'db'>;

// pixeltwin sends no email, so an address only has to look like one: one @, something on both
// sides, no spaces. A self-hosted team may well use admin@localhost or name@intranet.
export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .regex(/^[^\s@]+@[^\s@]+$/, 'Enter an email address like name@example.com');
export const passwordSchema = z.string().min(10, 'Use at least 10 characters').max(1024);
export const roleSchema = z.enum(USER_ROLES);

export const createUserSchema = z.strictObject({
  email: emailSchema,
  password: passwordSchema,
  role: roleSchema.default('viewer'),
});

export const updateUserSchema = z.strictObject({ email: emailSchema, role: roleSchema }).partial();

export const changePasswordSchema = z.strictObject({
  currentPassword: z.string().min(1),
  newPassword: passwordSchema,
});

export interface UserView {
  id: string;
  email: string;
  role: UserRole;
  /** `pending`: signed up, waiting for an admin; `rejected`: turned down. */
  status: UserStatus;
  name: string | null;
  createdAt: number;
}

export function toUserView(user: UserRow): UserView {
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    status: user.status,
    name: user.name,
    createdAt: user.createdAt,
  };
}

function emailTaken(email: string): AppError {
  return new AppError('email_taken', 409, `A user with email ${email} already exists.`);
}

export async function countUsers(deps: DbDeps): Promise<number> {
  const row = await deps.db
    .selectFrom('users')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .executeTakeFirstOrThrow();
  return Number(row.n);
}

/** Inserts a user. Accepts a transaction, and a hash made beforehand (hashing is slow; not in a transaction). */
export async function insertUser(
  db: Db,
  input: z.output<typeof createUserSchema>,
  passwordHash?: string,
): Promise<UserView> {
  const user: UserRow = {
    id: newId('usr'),
    email: input.email,
    passwordHash: passwordHash ?? (await hashPassword(input.password)),
    role: input.role,
    status: 'active',
    name: null,
    createdAt: Date.now(),
  };
  try {
    await db.insertInto('users').values(user).execute();
  } catch (err) {
    if (isUniqueViolation(err)) throw emailTaken(input.email);
    throw err;
  }
  return toUserView(user);
}

export async function createUser(deps: DbDeps, input: unknown): Promise<UserView> {
  return insertUser(deps.db, parseInput(createUserSchema, input));
}

export async function getUserRow(deps: DbDeps, id: string): Promise<UserRow> {
  const user = await deps.db.selectFrom('users').selectAll().where('id', '=', id).executeTakeFirst();
  if (!user) throw new AppError('user_not_found', 404, `User ${id} not found.`);
  return user;
}

export async function listUsers(deps: DbDeps): Promise<UserView[]> {
  const users = await deps.db.selectFrom('users').selectAll().orderBy('email').execute();
  return users.map(toUserView);
}

/**
 * Runs `change` unless it would leave no admin. Admin rows are locked first (a no-op update) so
 * two concurrent demotions or deletions cannot both pass the check on Postgres.
 */
async function guardLastAdmin(deps: DbDeps, user: UserRow, change: (tx: Db) => Promise<void>): Promise<void> {
  await deps.db.transaction().execute(async (tx) => {
    await tx
      .updateTable('users')
      .set((eb) => ({ role: eb.ref('role') }))
      .where('role', '=', 'admin')
      .execute();
    if (user.role === 'admin') {
      const admins = await tx
        .selectFrom('users')
        .select((eb) => eb.fn.countAll<number>().as('n'))
        .where('role', '=', 'admin')
        .executeTakeFirstOrThrow();
      if (Number(admins.n) <= 1) {
        throw new AppError('last_admin', 409, 'This is the last admin; create or promote another admin first.');
      }
    }
    await change(tx);
  });
}

export async function updateUser(deps: DbDeps, id: string, input: unknown): Promise<UserView> {
  const changes = parseInput(updateUserSchema, input);
  const user = await getUserRow(deps, id);
  if (Object.keys(changes).length === 0) return toUserView(user);
  const apply = async (db: Db) => {
    try {
      await db.updateTable('users').set(changes).where('id', '=', id).execute();
    } catch (err) {
      if (isUniqueViolation(err) && changes.email) throw emailTaken(changes.email);
      throw err;
    }
  };
  if (changes.role && changes.role !== 'admin' && user.role === 'admin') await guardLastAdmin(deps, user, apply);
  else if (changes.role === 'admin' && user.role !== 'admin') {
    // Admins have access to every project; memberships would only come back if they were demoted.
    await deps.db.transaction().execute(async (tx) => {
      await apply(tx);
      await tx.deleteFrom('projectMembers').where('userId', '=', id).execute();
    });
  } else await apply(deps.db);
  return toUserView({ ...user, ...changes });
}

/** Deletes the user and their sessions. Refuses to delete the last admin. */
export async function deleteUser(deps: DbDeps, id: string): Promise<void> {
  const user = await getUserRow(deps, id);
  await guardLastAdmin(deps, user, async (tx) => {
    await tx.deleteFrom('users').where('id', '=', id).execute();
  });
}

/** Returns the user when the password matches, else null. Takes the same time for unknown emails. */
export async function authenticate(deps: DbDeps, email: string, password: string): Promise<UserRow | null> {
  const normalized = email.trim().toLowerCase();
  const user = await deps.db.selectFrom('users').selectAll().where('email', '=', normalized).executeTakeFirst();
  const ok = await verifyPassword(password, user?.passwordHash ?? DUMMY_HASH);
  return user && ok ? user : null;
}

/**
 * Changes the password and ends the user's other sessions, so a stolen cookie stops working.
 * `keepSessionToken` is the caller's own session cookie, which stays valid.
 */
export async function changePassword(
  deps: DbDeps,
  userId: string,
  input: unknown,
  keepSessionToken?: string | null,
): Promise<void> {
  const { currentPassword, newPassword } = parseInput(changePasswordSchema, input);
  const user = await getUserRow(deps, userId);
  if (!(await verifyPassword(currentPassword, user.passwordHash))) {
    throw new AppError('invalid_current_password', 403, 'The current password is wrong.');
  }
  const passwordHash = await hashPassword(newPassword);
  await deps.db.transaction().execute(async (tx) => {
    await tx.updateTable('users').set({ passwordHash }).where('id', '=', userId).execute();
    let others = tx.deleteFrom('sessions').where('userId', '=', userId);
    if (keepSessionToken) others = others.where('tokenHash', '!=', sha256(keepSessionToken));
    await others.execute();
  });
}

/** For the `admin reset-password` command: a recovery tool, so it also ends all of the user's sessions. */
export async function setPasswordByEmail(deps: DbDeps, email: string, password: string): Promise<void> {
  const parsed = parseInput(z.strictObject({ email: emailSchema, password: passwordSchema }), { email, password });
  const passwordHash = await hashPassword(parsed.password);
  await deps.db.transaction().execute(async (tx) => {
    const user = await tx.selectFrom('users').select('id').where('email', '=', parsed.email).executeTakeFirst();
    if (!user) throw new AppError('user_not_found', 404, `User ${parsed.email} not found.`);
    await tx.updateTable('users').set({ passwordHash }).where('id', '=', user.id).execute();
    await tx.deleteFrom('sessions').where('userId', '=', user.id).execute();
  });
}
