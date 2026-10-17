import type { UserRow } from '../../db/schema';
import { newId } from '../../ids';
import type { Deps } from '../deps';
import { randomToken, sha256 } from './random';

type DbDeps = Pick<Deps, 'db'>;

export const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;
/** Sliding expiry is refreshed at most this often, to avoid a write per request. */
const REFRESH_AFTER_MS = 60 * 60 * 1000;

/** Personal tokens: sessions sent as `Authorization: Bearer pu_…` instead of a cookie. */
export const USER_TOKEN_PREFIX = 'pu_';

/**
 * Creates a session and returns the raw cookie value (or, with `USER_TOKEN_PREFIX`, a personal
 * token). Only its sha256 is stored.
 */
export async function createSession(
  deps: DbDeps,
  userId: string,
  prefix = '',
): Promise<{ token: string; expiresAt: number }> {
  const token = prefix + randomToken();
  const now = Date.now();
  const expiresAt = now + SESSION_TTL_MS;
  await deps.db
    .insertInto('sessions')
    .values({ id: newId('ses'), userId, tokenHash: sha256(token), expiresAt, createdAt: now })
    .execute();
  return { token, expiresAt };
}

export interface ResolvedSession {
  user: UserRow;
  expiresAt: number;
  /** True when this call extended the session; the cookie must then be sent again with `expiresAt`. */
  refreshed: boolean;
}

/** The session and its user, or null when the token is unknown or expired. Extends the expiry on use. */
export async function resolveSession(deps: DbDeps, token: string): Promise<ResolvedSession | null> {
  const row = await deps.db
    .selectFrom('sessions')
    .innerJoin('users', 'users.id', 'sessions.userId')
    .select(['sessions.id as sessionId', 'sessions.expiresAt'])
    .selectAll('users')
    .where('sessions.tokenHash', '=', sha256(token))
    .executeTakeFirst();
  if (!row) return null;
  const { sessionId, expiresAt, ...user } = row;
  const now = Date.now();
  if (expiresAt <= now) {
    await deps.db.deleteFrom('sessions').where('id', '=', sessionId).execute();
    return null;
  }
  if (expiresAt - now < SESSION_TTL_MS - REFRESH_AFTER_MS) {
    const extended = now + SESSION_TTL_MS;
    await deps.db.updateTable('sessions').set({ expiresAt: extended }).where('id', '=', sessionId).execute();
    return { user, expiresAt: extended, refreshed: true };
  }
  return { user, expiresAt, refreshed: false };
}

export async function deleteSession(deps: DbDeps, token: string): Promise<void> {
  await deps.db.deleteFrom('sessions').where('tokenHash', '=', sha256(token)).execute();
}
