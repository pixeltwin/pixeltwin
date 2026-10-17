import { z } from 'zod';
import { PROJECT_ROLES, type RequestStatus, USER_ROLES } from '../db/schema';
import { AppError } from '../errors';
import { newId } from '../ids';
import { consumeLink, createLink, findLink } from './auth/links';
import { hashPassword } from './auth/password';
import { emailSchema, passwordSchema } from './auth/users';
import type { Deps } from './deps';
import { getProjectBySlug } from './projects';
import { parseInput } from './schemas';

type DbDeps = Pick<Deps, 'db' | 'events'>;

export const SIGNUP_MODES = ['off', 'approval'] as const;
export type SignupMode = (typeof SIGNUP_MODES)[number];

export interface SignupSettings {
  mode: SignupMode;
  /** Lowercase domains (`company.com`); empty: any domain. */
  domains: string[];
}

const domainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9.-]+\.[a-z0-9-]+$|^[a-z0-9-]+$/, 'Enter domains like company.com');

export const signupSettingsSchema = z.strictObject({
  mode: z.enum(SIGNUP_MODES),
  domains: z.preprocess(
    (value) => (typeof value === 'string' ? value.split(/[\s,]+/).filter(Boolean) : value),
    z.array(domainSchema).max(50),
  ),
});

export const signupSchema = z.strictObject({
  email: emailSchema,
  password: passwordSchema,
  name: z.string().trim().max(200).optional(),
  note: z.string().trim().max(1000).optional(),
});

export const approveSchema = z.strictObject({
  role: z.enum(USER_ROLES).default('viewer'),
  projects: z
    .array(z.strictObject({ slug: z.string().min(1), role: z.enum(PROJECT_ROLES).default('viewer') }))
    .max(100)
    .default([]),
});

export const rejectSchema = z.strictObject({ reason: z.string().trim().max(1000).optional() });

export async function getSignupSettings(deps: DbDeps): Promise<SignupSettings> {
  const rows = await deps.db.selectFrom('serverSettings').selectAll().where('key', 'like', 'signup.%').execute();
  const value = (key: string) => rows.find((r) => r.key === key)?.value;
  const mode = SIGNUP_MODES.find((m) => m === value('signup.mode')) ?? 'off';
  const domains = (value('signup.domains') ?? '').split(',').filter(Boolean);
  return { mode, domains };
}

export async function updateSignupSettings(deps: DbDeps, input: unknown): Promise<SignupSettings> {
  const { mode, domains } = parseInput(signupSettingsSchema, input);
  await deps.db.transaction().execute(async (tx) => {
    for (const [key, value] of [
      ['signup.mode', mode],
      ['signup.domains', domains.join(',')],
    ] as const) {
      await tx.deleteFrom('serverSettings').where('key', '=', key).execute();
      await tx.insertInto('serverSettings').values({ key, value }).execute();
    }
  });
  return { mode, domains };
}

/**
 * What a sign-up did. The caller answers the same whatever it was, so nobody learns whether an
 * email has an account; `existing` lets it mail the owner instead, `verifyToken` the new person.
 */
export type SignupOutcome =
  | { kind: 'requested'; requestId: string; email: string; verifyToken: string | null }
  | { kind: 'existing'; email: string; pendingVerifyToken: string | null };

/**
 * Asks for access: a pending user (who can log in, but sees only a waiting page) and an access
 * request for admins. With `verify` (SMTP is set) admins see it only once the email is confirmed.
 */
export async function requestAccess(
  deps: DbDeps,
  input: unknown,
  options: { verify: boolean },
): Promise<SignupOutcome> {
  const settings = await getSignupSettings(deps);
  if (settings.mode === 'off') throw new AppError('signup_closed', 404, 'This server does not take sign-ups.');
  const data = parseInput(signupSchema, input);
  const domain = data.email.split('@')[1] ?? '';
  if (settings.domains.length > 0 && !settings.domains.includes(domain)) {
    throw new AppError('signup_refused', 422, 'Sign-ups are not accepted for this email address.');
  }
  // Hash first, also for an email that exists: both answers take the same time.
  const passwordHash = await hashPassword(data.password);
  const existing = await deps.db
    .selectFrom('users')
    .leftJoin('accessRequests', 'accessRequests.userId', 'users.id')
    .select(['users.id', 'users.status', 'accessRequests.verifiedAt'])
    .where('users.email', '=', data.email)
    .executeTakeFirst();
  if (existing) {
    // Someone who asked before and never confirmed gets a new link; nobody else changes.
    const unconfirmed = options.verify && existing.status === 'pending' && existing.verifiedAt === null;
    const pendingVerifyToken = unconfirmed
      ? (await createLink(deps.db, { purpose: 'verify_email', email: data.email, userId: existing.id })).token
      : null;
    return { kind: 'existing', email: data.email, pendingVerifyToken };
  }
  const now = Date.now();
  const userId = newId('usr');
  const requestId = newId('acr');
  const verifyToken = await deps.db.transaction().execute(async (tx) => {
    await tx
      .insertInto('users')
      .values({
        id: userId,
        email: data.email,
        passwordHash,
        role: 'viewer',
        status: 'pending',
        name: data.name || null,
        createdAt: now,
      })
      .execute();
    await tx
      .insertInto('accessRequests')
      .values({ id: requestId, userId, note: data.note || null, verifiedAt: null, status: 'pending', createdAt: now })
      .execute();
    return options.verify ? (await createLink(tx, { purpose: 'verify_email', email: data.email, userId })).token : null;
  });
  return { kind: 'requested', requestId, email: data.email, verifyToken };
}

/** Confirms the email of a sign-up; admins see the request from now on. */
export async function verifySignup(deps: DbDeps, token: string): Promise<{ email: string }> {
  const link = await findLink(deps.db, token, 'verify_email');
  await deps.db.transaction().execute(async (tx) => {
    if (!(await consumeLink(tx, link.id))) throw new AppError('link_used', 410, 'This link was already used.');
    await tx
      .updateTable('accessRequests')
      .set({ verifiedAt: Date.now() })
      .where('userId', '=', link.userId ?? '')
      .execute();
  });
  return { email: link.email };
}

export interface AccessRequestView {
  id: string;
  userId: string;
  email: string;
  name: string | null;
  note: string | null;
  verified: boolean;
  status: RequestStatus;
  createdAt: number;
  decidedBy: string | null;
  decidedAt: number | null;
  reason: string | null;
}

function requests(deps: DbDeps) {
  return deps.db
    .selectFrom('accessRequests')
    .innerJoin('users', 'users.id', 'accessRequests.userId')
    .leftJoin('users as deciders', 'deciders.id', 'accessRequests.decidedBy')
    .select([
      'accessRequests.id',
      'accessRequests.userId',
      'users.email',
      'users.name',
      'accessRequests.note',
      'accessRequests.verifiedAt',
      'accessRequests.status',
      'accessRequests.createdAt',
      'deciders.email as decidedBy',
      'accessRequests.decidedAt',
      'accessRequests.reason',
    ]);
}

type RequestRow = Awaited<ReturnType<ReturnType<typeof requests>['execute']>>[number];

function toView(row: RequestRow): AccessRequestView {
  const { verifiedAt, ...rest } = row;
  return { ...rest, verified: verifiedAt !== null };
}

/**
 * Pending requests admins should look at, oldest first. With `verifiedOnly` (SMTP is set) only
 * those whose email was confirmed; without SMTP every one, marked "not verified".
 */
export async function listAccessRequests(
  deps: DbDeps,
  options: { verifiedOnly: boolean },
): Promise<AccessRequestView[]> {
  let query = requests(deps).where('accessRequests.status', '=', 'pending').orderBy('accessRequests.createdAt');
  if (options.verifiedOnly) query = query.where('accessRequests.verifiedAt', 'is not', null);
  return (await query.execute()).map(toView);
}

export async function getAccessRequest(deps: DbDeps, id: string): Promise<AccessRequestView> {
  const row = await requests(deps).where('accessRequests.id', '=', id).executeTakeFirst();
  if (!row) throw new AppError('access_request_not_found', 404, `Access request ${id} not found.`);
  return toView(row);
}

async function pendingRequest(deps: DbDeps, id: string, verifiedOnly: boolean): Promise<AccessRequestView> {
  const request = await getAccessRequest(deps, id);
  if (request.status !== 'pending') {
    throw new AppError('access_request_decided', 409, `This request was already ${request.status}.`);
  }
  if (verifiedOnly && !request.verified) {
    throw new AppError('access_request_not_found', 404, `Access request ${id} not found.`);
  }
  return request;
}

/** Lets the person in: a global role, and memberships (none for an admin). Recorded who and when. */
export async function approveAccessRequest(
  deps: DbDeps,
  id: string,
  input: unknown,
  actorId: string,
  options: { verifiedOnly: boolean },
): Promise<AccessRequestView> {
  const { role, projects } = parseInput(approveSchema, input);
  const request = await pendingRequest(deps, id, options.verifiedOnly);
  const resolved = await Promise.all(
    projects.map(async (p) => ({ id: (await getProjectBySlug(deps, p.slug)).id, role: p.role })),
  );
  const now = Date.now();
  await deps.db.transaction().execute(async (tx) => {
    await tx.updateTable('users').set({ status: 'active', role }).where('id', '=', request.userId).execute();
    if (role !== 'admin') {
      for (const p of new Map(resolved.map((x) => [x.id, x.role]))) {
        await tx
          .insertInto('projectMembers')
          .values({ projectId: p[0], userId: request.userId, role: p[1], createdAt: now })
          .execute();
      }
    }
    await tx
      .updateTable('accessRequests')
      .set({ status: 'approved', decidedBy: actorId, decidedAt: now })
      .where('id', '=', id)
      .execute();
  });
  if (role !== 'admin') {
    for (const [projectId, projectRole] of new Map(resolved.map((x) => [x.id, x.role]))) {
      await deps.events?.memberAdded?.({
        projectId,
        userId: request.userId,
        role: projectRole,
        via: 'access_request',
        by: actorId,
      });
    }
  }
  return getAccessRequest(deps, id);
}

/** Turns the request down; the person can log in only to read that. Removed after 30 days. */
export async function rejectAccessRequest(
  deps: DbDeps,
  id: string,
  input: unknown,
  actorId: string,
  options: { verifiedOnly: boolean },
): Promise<AccessRequestView> {
  const { reason } = parseInput(rejectSchema, input);
  const request = await pendingRequest(deps, id, options.verifiedOnly);
  const now = Date.now();
  await deps.db.transaction().execute(async (tx) => {
    await tx.updateTable('users').set({ status: 'rejected' }).where('id', '=', request.userId).execute();
    await tx
      .updateTable('accessRequests')
      .set({ status: 'rejected', decidedBy: actorId, decidedAt: now, reason: reason || null })
      .where('id', '=', id)
      .execute();
  });
  return getAccessRequest(deps, id);
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The hourly clean-up: turned-down requests after 30 days, and sign-ups whose email was never
 * confirmed within 7 days of their link (only with SMTP: without it nobody confirms). Their pending
 * user goes with them. Old one-time links are deleted 30 days after they expired.
 */
export async function cleanUpSignups(deps: DbDeps, now = Date.now()): Promise<number> {
  const rejected = await deps.db
    .selectFrom('accessRequests')
    .select('userId')
    .where('status', '=', 'rejected')
    .where('decidedAt', '<', now - 30 * DAY_MS)
    .execute();
  const unconfirmed = await deps.db
    .selectFrom('accessRequests')
    .innerJoin('users', 'users.id', 'accessRequests.userId')
    .select('accessRequests.userId')
    .where('accessRequests.status', '=', 'pending')
    .where('accessRequests.verifiedAt', 'is', null)
    .where('accessRequests.createdAt', '<', now - 7 * DAY_MS)
    .where((eb) =>
      eb.exists(
        eb
          .selectFrom('authLinks')
          .select('authLinks.id')
          .whereRef('authLinks.userId', '=', 'accessRequests.userId')
          .where('authLinks.purpose', '=', 'verify_email'),
      ),
    )
    .execute();
  const ids = [...rejected, ...unconfirmed].map((r) => r.userId);
  if (ids.length > 0) {
    await deps.db.deleteFrom('users').where('id', 'in', ids).where('status', '!=', 'active').execute();
  }
  await deps.db
    .deleteFrom('authLinks')
    .where('expiresAt', '<', now - 30 * DAY_MS)
    .execute();
  return ids.length;
}
