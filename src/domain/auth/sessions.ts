import type { UsersTable } from '../../db/schema';
import { newId } from '../../ids';
import type { Deps } from '../deps';
import { randomToken, sha256 } from './random';

type DbDeps = Pick<Deps, 'db'>;

export const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;
/** Sliding expiry is refreshed at most this often, to avoid a write per request. */
const REFRESH_AFTER_MS = 60 * 60 * 1000;

/** Creates a session and returns the raw cookie value. Only its sha256 is stored. */
export async function createSession(deps: DbDeps, userId: string): Promise<{ token: string; expiresAt: number }> {
  const token = randomToken();
  const now = Date.now();
  const expiresAt = now + SESSION_TTL_MS;
  await deps.db
    .insertInto('sessions')
    .values({ id: newId('ses'), userId, tokenHash: sha256(token), expiresAt, createdAt: now })
    .execute();
  return { token, expiresAt };
}

/** The session's user, or null when the token is unknown or expired. Extends the expiry on use. */
export async function resolveSession(deps: DbDeps, token: string): Promise<UsersTable | null> {
  const row = await deps.db
    .selectFrom('sessions')
    .innerJoin('users', 'users.id', 'sessions.userId')
    .select(['sessions.id as sessionId', 'sessions.expiresAt'])
    .selectAll('users')
    .where('sessions.tokenHash', '=', sha256(token))
    .executeTakeFirst();
  if (!row) return null;
  const now = Date.now();
  if (row.expiresAt <= now) {
    await deps.db.deleteFrom('sessions').where('id', '=', row.sessionId).execute();
    return null;
  }
  if (row.expiresAt - now < SESSION_TTL_MS - REFRESH_AFTER_MS) {
    await deps.db
      .updateTable('sessions')
      .set({ expiresAt: now + SESSION_TTL_MS })
      .where('id', '=', row.sessionId)
      .execute();
  }
  const { sessionId: _sessionId, expiresAt: _expiresAt, ...user } = row;
  return user;
}

export async function deleteSession(deps: DbDeps, token: string): Promise<void> {
  await deps.db.deleteFrom('sessions').where('tokenHash', '=', sha256(token)).execute();
}
