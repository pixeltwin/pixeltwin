import { type OpenAPIHono, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { linkUrl } from '../../domain/auth/links';
import { hasPermission } from '../../domain/auth/policy';
import { acceptReset, createResetLink } from '../../domain/auth/resets';
import { createSession } from '../../domain/auth/sessions';
import { toUserView } from '../../domain/auth/users';
import {
  acceptInvite,
  acceptInviteSchema,
  describeLink,
  type InviteResult,
  type InviteView,
  inviteProjectId,
  inviteToProject,
  inviteToServer,
  listInvites,
  projectInviteSchema,
  resendInvite,
  revokeInvite,
  serverInviteSchema,
} from '../../domain/invites';
import { getProjectBySlug } from '../../domain/projects';
import { AppError } from '../../errors';
import { inviteMail, resetMail } from '../../mail/messages';
import { deliver } from '../../mail/smtp';
import { accessFiltered, allowProject } from '../access';
import { principalOf } from '../auth';
import { clientIp } from '../client-ip';
import { setSessionCookie } from '../cookies';
import { API, type AppEnv, type Services } from '../env';
import { defineRoute } from '../route';
import { InviteSchema, json, MemberSchema, problems, UserSchema } from '../schemas';

const slugParam = z.object({ slug: z.string() });
const idParam = z.object({ id: z.string() });
const tokenParam = z.object({ token: z.string() });

const InviteResultSchema = z
  .object({
    kind: z.enum(['invite', 'member']).openapi({
      description: '`member`: the email already had an account and became a member at once; no link',
    }),
    invite: InviteSchema.optional(),
    member: MemberSchema.optional(),
    link: z.string().optional().openapi({ description: 'The invite link. Shown only in this response.' }),
    mailed: z.boolean().openapi({ description: 'The link was also sent by mail (SMTP_URL is set)' }),
  })
  .openapi('InviteResult');

/** Mails the invite when SMTP is set (in the background; a mail error never fails the invite). */
export function sendInvite(s: Services, invite: InviteView, token: string): { link: string; mailed: boolean } {
  const link = linkUrl(s.config.publicUrl, 'invite', token);
  const projects = invite.project ? [invite.project.name] : [];
  void deliver(s.mailer, inviteMail(invite.email, link, invite.invitedBy, projects), s.logger.warn, 'invite');
  return { link, mailed: !!s.mailer };
}

function answer(s: Services, result: InviteResult) {
  if (result.kind === 'member') return { kind: 'member' as const, member: result.member, mailed: false };
  return { kind: 'invite' as const, invite: result.invite, ...sendInvite(s, result.invite, result.token) };
}

/** Invite routes name an invite, not its project: admins, or a manager of the invite's project. */
async function allowInvite(c: Context<AppEnv>, s: Services, id: string): Promise<void> {
  const hidden = new AppError('invite_not_found', 404, `Invite ${id} not found.`);
  const projectId = await inviteProjectId(s.deps, id).catch(() => {
    throw hidden;
  });
  if (projectId) await allowProject(c, s.deps, projectId, hidden, 'project.admin');
  else if (hasPermission(principalOf(c), 'user.admin')) accessFiltered(c);
  else throw hidden;
}

/** One-time links are public: limited per IP like logins, so nobody can try tokens fast. */
function limitLinks(c: Context<AppEnv>, s: Services): void {
  if (!s.loginLimiter.hit(clientIp(c), 'one-time-link')) {
    throw new AppError('rate_limited', 429, 'Too many attempts; wait a minute and try again.');
  }
}

export function registerInviteRoutes(app: OpenAPIHono<AppEnv>, s: Services): void {
  const invite = defineRoute('project.admin', {
    method: 'post',
    path: `${API}/projects/{slug}/invites`,
    tags: ['invites'],
    summary: 'Invite someone by email into the project (an account becomes a member at once)',
    description:
      'The link works once, for 7 days; inviting the same email again replaces it. With SMTP_URL set it is ' +
      'also mailed. Roles: viewer (default), reviewer, maintainer.',
    request: {
      params: slugParam,
      body: { required: true, content: { 'application/json': { schema: projectInviteSchema } } },
    },
    responses: {
      200: json(InviteResultSchema, 'The email had an account: now a member'),
      201: json(InviteResultSchema, 'The invite, with its link'),
      ...problems(401, 403, 404, 409, 422),
    },
  });
  app.openapi(invite, async (c) => {
    const result = answer(
      s,
      await inviteToProject(s.deps, c.req.valid('param').slug, c.req.valid('json'), principalOf(c).id),
    );
    return result.kind === 'member' ? c.json(result, 200) : c.json(result, 201);
  });

  const list = defineRoute('project.admin', {
    method: 'get',
    path: `${API}/projects/{slug}/invites`,
    tags: ['invites'],
    summary: "The project's pending invites (never their links)",
    request: { params: slugParam },
    responses: { 200: json(z.object({ items: z.array(InviteSchema) }), 'Pending invites'), ...problems(401, 403, 404) },
  });
  app.openapi(list, async (c) => {
    const project = await getProjectBySlug(s.deps, c.req.valid('param').slug);
    return c.json({ items: await listInvites(s.deps, project.id) }, 200);
  });

  const inviteServer = defineRoute('user.admin', {
    method: 'post',
    path: `${API}/invites`,
    tags: ['invites'],
    summary: 'Invite someone to the server with a global role, optionally into a project',
    request: { body: { required: true, content: { 'application/json': { schema: serverInviteSchema } } } },
    responses: {
      200: json(InviteResultSchema, 'The email had an account: now a member of the project'),
      201: json(InviteResultSchema, 'The invite, with its link'),
      ...problems(401, 403, 404, 409, 422),
    },
  });
  app.openapi(inviteServer, async (c) => {
    const result = answer(s, await inviteToServer(s.deps, c.req.valid('json'), principalOf(c).id));
    return result.kind === 'member' ? c.json(result, 200) : c.json(result, 201);
  });

  const listAll = defineRoute('user.admin', {
    method: 'get',
    path: `${API}/invites`,
    tags: ['invites'],
    summary: 'Every pending invite on the server',
    responses: { 200: json(z.object({ items: z.array(InviteSchema) }), 'Pending invites'), ...problems(401, 403) },
  });
  app.openapi(listAll, async (c) => c.json({ items: await listInvites(s.deps, null) }, 200));

  const revoke = defineRoute('project.admin', {
    method: 'delete',
    path: `${API}/invites/{id}`,
    tags: ['invites'],
    summary: 'Revoke a pending invite: its link stops working',
    request: { params: idParam },
    responses: { 204: { description: 'Revoked' }, ...problems(401, 403, 404) },
  });
  app.openapi(revoke, async (c) => {
    const { id } = c.req.valid('param');
    await allowInvite(c, s, id);
    await revokeInvite(s.deps, id);
    return c.body(null, 204);
  });

  const resend = defineRoute('project.admin', {
    method: 'post',
    path: `${API}/invites/{id}/resend`,
    tags: ['invites'],
    summary: 'A new link for a pending invite (the old one stops working), mailed again with SMTP',
    request: { params: idParam },
    responses: { 201: json(InviteResultSchema, 'The invite, with its new link'), ...problems(401, 403, 404) },
  });
  app.openapi(resend, async (c) => {
    const { id } = c.req.valid('param');
    await allowInvite(c, s, id);
    const { invite: view, token } = await resendInvite(s.deps, id);
    return c.json({ kind: 'invite' as const, invite: view, ...sendInvite(s, view, token) }, 201);
  });

  const resetLink = defineRoute('user.admin', {
    method: 'post',
    path: `${API}/users/{id}/reset-link`,
    tags: ['users'],
    summary: 'A one-time link (1 hour) for the user to set a new password; mailed with SMTP',
    request: { params: idParam },
    responses: {
      201: json(
        z.object({ link: z.string(), expiresAt: z.number().int(), mailed: z.boolean() }),
        'The link, shown once',
      ),
      ...problems(401, 403, 404),
    },
  });
  app.openapi(resetLink, async (c) => {
    const { token, expiresAt, email } = await createResetLink(s.deps, c.req.valid('param').id, principalOf(c).id);
    const link = linkUrl(s.config.publicUrl, 'password_reset', token);
    void deliver(s.mailer, resetMail(email, link), s.logger.warn, 'password reset');
    return c.json({ link, expiresAt, mailed: !!s.mailer }, 201);
  });

  const describe = defineRoute('public', {
    method: 'get',
    path: `${API}/links/{token}`,
    tags: ['invites'],
    summary: 'What a one-time link (invite, password reset, email check) is for, while it works',
    description: '404 link_invalid, 410 link_used or link_expired otherwise. Limited per IP like logins.',
    request: { params: tokenParam },
    responses: {
      200: json(
        z.object({
          purpose: z.enum(['invite', 'password_reset', 'verify_email']),
          email: z.string(),
          expiresAt: z.number().int(),
          projects: z.array(z.string()),
        }),
        'The link',
      ),
      ...problems(404, 410, 429),
    },
  });
  app.openapi(describe, async (c) => {
    limitLinks(c, s);
    return c.json(await describeLink(s.deps, c.req.valid('param').token), 200);
  });

  const accept = defineRoute('public', {
    method: 'post',
    path: `${API}/links/{token}`,
    tags: ['invites'],
    summary: 'Use an invite or reset link: set the password and get logged in (sets the pt_session cookie)',
    request: {
      params: tokenParam,
      body: { required: true, content: { 'application/json': { schema: acceptInviteSchema } } },
    },
    responses: { 201: json(UserSchema, 'The user, logged in'), ...problems(404, 409, 410, 422, 429) },
  });
  app.openapi(accept, async (c) => {
    limitLinks(c, s);
    const { token } = c.req.valid('param');
    const { purpose } = await describeLink(s.deps, token);
    const body = c.req.valid('json');
    const user =
      purpose === 'invite'
        ? await acceptInvite(s.deps, token, body)
        : purpose === 'password_reset'
          ? await acceptReset(s.deps, token, body)
          : (() => {
              throw new AppError('link_invalid', 404, 'This link does not set a password.');
            })();
    setSessionCookie(c, s.config.publicUrl, await createSession(s.deps, user.id));
    return c.json(toUserView(user), 201);
  });
}
