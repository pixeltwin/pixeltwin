import { z } from 'zod';
import type { UserRow } from '../../db/schema';
import { AppError } from '../../errors';
import type { Deps } from '../deps';
import { parseInput } from '../schemas';
import { consumeLink, createLink, findLink } from './links';
import { hashPassword } from './password';
import { getUserRow, passwordSchema } from './users';

type DbDeps = Pick<Deps, 'db'>;

export const resetPasswordSchema = z.strictObject({ password: passwordSchema });

/** A one-time link (1 hour) to set a new password; a newer link replaces it. */
export async function createResetLink(
  deps: DbDeps,
  userId: string,
  actorId: string | null,
): Promise<{ token: string; expiresAt: number; email: string }> {
  const user = await getUserRow(deps, userId);
  const { token, expiresAt } = await createLink(deps.db, {
    purpose: 'password_reset',
    email: user.email,
    userId: user.id,
    createdBy: actorId,
  });
  return { token, expiresAt, email: user.email };
}

/** Sets the password from a reset link and ends every session of the user. Returns the user, to log in. */
export async function acceptReset(deps: DbDeps, token: string, input: unknown): Promise<UserRow> {
  const { password } = parseInput(resetPasswordSchema, input);
  const link = await findLink(deps.db, token, 'password_reset');
  const passwordHash = await hashPassword(password);
  const userId = link.userId ?? '';
  await deps.db.transaction().execute(async (tx) => {
    if (!(await consumeLink(tx, link.id))) throw new AppError('link_used', 410, 'This link was already used.');
    await tx.updateTable('users').set({ passwordHash }).where('id', '=', userId).execute();
    await tx.deleteFrom('sessions').where('userId', '=', userId).execute();
  });
  return getUserRow(deps, userId);
}
