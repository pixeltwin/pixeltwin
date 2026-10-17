import { z } from 'zod';
import type { ProjectTokensTable } from '../../db/schema';
import { AppError } from '../../errors';
import { newId } from '../../ids';
import type { Deps } from '../deps';
import { getProjectBySlug } from '../projects';
import { parseInput } from '../schemas';
import { equalHex, randomBase62, sha256 } from './random';

type DbDeps = Pick<Deps, 'db'>;

export const TOKEN_SCOPES = ['read', 'write', 'review'] as const;
export type TokenScope = (typeof TOKEN_SCOPES)[number];

const TOKEN_PATTERN = /^pt_([0-9A-Za-z]{8})_([0-9A-Za-z]{32})$/;
/** `lastUsedAt` is written at most this often. */
const LAST_USED_RESOLUTION_MS = 60_000;

export const createTokenSchema = z.strictObject({
  name: z.string().trim().min(1).max(100),
  scopes: z
    .array(z.enum(TOKEN_SCOPES))
    .min(1)
    .transform((scopes) => [...new Set(scopes)].sort()),
});

export interface TokenView {
  id: string;
  projectId: string;
  name: string;
  scopes: TokenScope[];
  /** First characters of the token, for recognising it in lists: `pt_AbCd1234_…`. */
  prefix: string;
  lastUsedAt: number | null;
  createdAt: number;
}

export interface ResolvedToken {
  id: string;
  projectId: string;
  /** Recorded with its reviews: an agent is named after its token. */
  name: string;
  scopes: TokenScope[];
}

function toTokenView(row: ProjectTokensTable): TokenView {
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    scopes: JSON.parse(row.scopes) as TokenScope[],
    prefix: `pt_${row.prefix}_`,
    lastUsedAt: row.lastUsedAt,
    createdAt: row.createdAt,
  };
}

/** Creates a token. `token` is the only time the full secret is available. */
export async function createProjectToken(
  deps: DbDeps,
  projectSlug: string,
  input: unknown,
): Promise<{ token: string; view: TokenView }> {
  const data = parseInput(createTokenSchema, input);
  const project = await getProjectBySlug(deps, projectSlug);
  const prefix = randomBase62(8);
  const secret = randomBase62(32);
  const row: ProjectTokensTable = {
    id: newId('tok'),
    projectId: project.id,
    name: data.name,
    scopes: JSON.stringify(data.scopes),
    prefix,
    secretHash: sha256(secret),
    lastUsedAt: null,
    createdAt: Date.now(),
  };
  await deps.db.insertInto('projectTokens').values(row).execute();
  return { token: `pt_${prefix}_${secret}`, view: toTokenView(row) };
}

export async function listProjectTokens(deps: DbDeps, projectSlug: string): Promise<TokenView[]> {
  const project = await getProjectBySlug(deps, projectSlug);
  const rows = await deps.db
    .selectFrom('projectTokens')
    .selectAll()
    .where('projectId', '=', project.id)
    .orderBy('createdAt')
    .execute();
  return rows.map(toTokenView);
}

export async function deleteProjectToken(deps: DbDeps, projectSlug: string, tokenId: string): Promise<void> {
  const project = await getProjectBySlug(deps, projectSlug);
  const result = await deps.db
    .deleteFrom('projectTokens')
    .where('id', '=', tokenId)
    .where('projectId', '=', project.id)
    .executeTakeFirst();
  if (Number(result.numDeletedRows) === 0) {
    throw new AppError('token_not_found', 404, `Token ${tokenId} not found in project "${projectSlug}".`);
  }
}

/** Looks a raw `pt_…` token up; null when malformed, unknown or wrong. */
export async function resolveProjectToken(deps: DbDeps, raw: string): Promise<ResolvedToken | null> {
  const match = TOKEN_PATTERN.exec(raw);
  if (!match) return null;
  const [, prefix = '', secret = ''] = match;
  const row = await deps.db.selectFrom('projectTokens').selectAll().where('prefix', '=', prefix).executeTakeFirst();
  if (!row || !equalHex(sha256(secret), row.secretHash)) return null;
  const now = Date.now();
  if (row.lastUsedAt === null || now - row.lastUsedAt >= LAST_USED_RESOLUTION_MS) {
    await deps.db.updateTable('projectTokens').set({ lastUsedAt: now }).where('id', '=', row.id).execute();
  }
  return { id: row.id, projectId: row.projectId, name: row.name, scopes: JSON.parse(row.scopes) as TokenScope[] };
}
