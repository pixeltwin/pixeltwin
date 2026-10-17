import type { Selectable } from 'kysely';
import type { Db } from '../../db/database';
import type { AuthLinksTable, LinkPurpose, ProjectRole, UserRole } from '../../db/schema';
import { AppError } from '../../errors';
import { newId } from '../../ids';
import { randomToken, sha256 } from './random';

export type LinkRow = Selectable<AuthLinksTable>;

const DAY_MS = 24 * 60 * 60 * 1000;

/** How long each kind of one-time link works. */
export const LINK_TTL_MS: Record<LinkPurpose, number> = {
  invite: 7 * DAY_MS,
  password_reset: 60 * 60 * 1000,
  verify_email: 7 * DAY_MS,
};

/** Where each kind of link opens, under PUBLIC_URL. The token is the last path segment. */
export const LINK_PATHS: Record<LinkPurpose, string> = {
  invite: '/ui/invite/',
  password_reset: '/ui/reset/',
  verify_email: '/ui/verify/',
};

export function linkUrl(publicUrl: string, purpose: LinkPurpose, token: string): string {
  return `${publicUrl}${LINK_PATHS[purpose]}${token}`;
}

export interface NewLink {
  purpose: LinkPurpose;
  email: string;
  userId?: string | null;
  projectId?: string | null;
  projectRole?: ProjectRole | null;
  globalRole?: UserRole | null;
  createdBy?: string | null;
}

/**
 * Creates a one-time link and returns its token, which is shown or mailed once: only its sha256
 * is stored. An older unused link for the same thing (an invite of this email to this project, a
 * reset for this user, a check of this email) is replaced, so only the newest works. Accepts a transaction.
 */
export async function createLink(db: Db, link: NewLink): Promise<{ id: string; token: string; expiresAt: number }> {
  let older = db.deleteFrom('authLinks').where('purpose', '=', link.purpose).where('usedAt', 'is', null);
  if (link.purpose === 'invite') {
    older = older.where('email', '=', link.email);
    older = link.projectId ? older.where('projectId', '=', link.projectId) : older.where('projectId', 'is', null);
  } else if (link.purpose === 'password_reset') older = older.where('userId', '=', link.userId ?? '');
  else older = older.where('email', '=', link.email);
  await older.execute();

  const token = randomToken();
  const now = Date.now();
  const row = {
    id: newId('lnk'),
    purpose: link.purpose,
    tokenHash: sha256(token),
    email: link.email,
    userId: link.userId ?? null,
    projectId: link.projectId ?? null,
    projectRole: link.projectRole ?? null,
    globalRole: link.globalRole ?? null,
    createdBy: link.createdBy ?? null,
    createdAt: now,
    expiresAt: now + LINK_TTL_MS[link.purpose],
    usedAt: null,
  };
  await db.insertInto('authLinks').values(row).execute();
  return { id: row.id, token, expiresAt: row.expiresAt };
}

/** The link behind a token, or why it does not work: 404 link_invalid, 410 link_used or link_expired. */
export async function findLink(db: Db, token: string, purpose?: LinkPurpose): Promise<LinkRow> {
  const row = await db.selectFrom('authLinks').selectAll().where('tokenHash', '=', sha256(token)).executeTakeFirst();
  if (!row || (purpose && row.purpose !== purpose)) {
    throw new AppError(
      'link_invalid',
      404,
      'This link is not valid. It may have been replaced by a newer one or revoked.',
    );
  }
  if (row.usedAt !== null) throw new AppError('link_used', 410, 'This link was already used.');
  if (row.expiresAt <= Date.now()) throw new AppError('link_expired', 410, 'This link has expired. Ask for a new one.');
  return row;
}

/** Marks the link used; false when someone else used it first (two tabs, a replay). */
export async function consumeLink(db: Db, id: string): Promise<boolean> {
  const result = await db
    .updateTable('authLinks')
    .set({ usedAt: Date.now() })
    .where('id', '=', id)
    .where('usedAt', 'is', null)
    .executeTakeFirst();
  return Number(result.numUpdatedRows) === 1;
}
