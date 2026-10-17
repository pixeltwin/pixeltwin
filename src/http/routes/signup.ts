import { type OpenAPIHono, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { linkUrl } from '../../domain/auth/links';
import {
  type AccessRequestView,
  approveAccessRequest,
  approveSchema,
  getSignupSettings,
  listAccessRequests,
  rejectAccessRequest,
  rejectSchema,
  requestAccess,
  SIGNUP_MODES,
  signupSchema,
  signupSettingsSchema,
  updateSignupSettings,
  verifySignup,
} from '../../domain/signup';
import { AppError } from '../../errors';
import { decisionMail, existingAccountMail, newRequestsMail, verifyMail } from '../../mail/messages';
import { deliver } from '../../mail/smtp';
import { principalOf } from '../auth';
import { clientIp } from '../client-ip';
import { API, type AppEnv, type Services } from '../env';
import { defineRoute } from '../route';
import { json, problems } from '../schemas';

const AccessRequestSchema = z
  .object({
    id: z.string(),
    userId: z.string(),
    email: z.string(),
    name: z.string().nullable(),
    note: z.string().nullable(),
    verified: z.boolean().openapi({ description: 'The email was confirmed by a link (only with SMTP)' }),
    status: z.enum(['pending', 'approved', 'rejected']),
    createdAt: z.number().int(),
    decidedBy: z.string().nullable().openapi({ description: 'Email of the admin who decided' }),
    decidedAt: z.number().int().nullable(),
    reason: z.string().nullable(),
  })
  .openapi('AccessRequest');

const SignupSettingsSchema = z
  .object({ mode: z.enum(SIGNUP_MODES), domains: z.array(z.string()) })
  .openapi('SignupSettings');

/** Admins hear of new requests at most once per such window (the Users page has the count anyway). */
const NOTIFY_EVERY_MS = 15 * 60 * 1000;
const lastNotified = new WeakMap<Services, number>();

/**
 * Mails every admin that requests wait; without SMTP nothing. At most one mail per admin per
 * 15-minute window, on every replica together: the outbox keeps one mail per key. The process also
 * skips the queries when it mailed less than 15 minutes ago.
 */
export async function notifyAdmins(s: Services): Promise<void> {
  if (!s.mailer) return;
  const now = Date.now();
  if (now - (lastNotified.get(s) ?? 0) < NOTIFY_EVERY_MS) return;
  lastNotified.set(s, now);
  const count = (await listAccessRequests(s.deps, { verifiedOnly: true })).length;
  if (count === 0) return;
  const admins = await s.deps.db
    .selectFrom('users')
    .select(['id', 'email'])
    .where('role', '=', 'admin')
    .where('status', '=', 'active')
    .execute();
  const url = `${s.config.publicUrl}/ui/admin/users#requests-title`;
  const window = Math.floor(now / NOTIFY_EVERY_MS);
  for (const { id, email } of admins) {
    void deliver(s.mailer, newRequestsMail(email, count, url), s.logger.warn, 'access request', {
      key: `access-requests:${id}:${window}`,
    });
  }
}

/** Mails the person the decision (with SMTP). */
export function mailDecision(s: Services, request: AccessRequestView): void {
  const login = `${s.config.publicUrl}/ui/login`;
  void deliver(
    s.mailer,
    decisionMail(request.email, request.status === 'approved', login, request.reason),
    s.logger.warn,
    'access decision',
  );
}

/**
 * Takes a sign-up and mails what follows: a link to confirm the email, or (an email with an
 * account) a note to log in instead. The caller's answer is the same either way.
 */
export async function takeSignup(s: Services, c: Context<AppEnv>, input: Record<string, unknown>): Promise<void> {
  const email = typeof input.email === 'string' ? input.email : '';
  if (!s.loginLimiter.hit(clientIp(c), email)) {
    throw new AppError('rate_limited', 429, 'Too many attempts; wait a minute and try again.');
  }
  const outcome = await requestAccess(s.deps, input, { verify: !!s.mailer });
  const token = outcome.kind === 'requested' ? outcome.verifyToken : outcome.pendingVerifyToken;
  if (token) {
    const link = linkUrl(s.config.publicUrl, 'verify_email', token);
    void deliver(s.mailer, verifyMail(outcome.email, link), s.logger.warn, 'email check');
  } else if (outcome.kind === 'existing') {
    const login = `${s.config.publicUrl}/ui/login`;
    void deliver(s.mailer, existingAccountMail(outcome.email, login), s.logger.warn, 'existing account');
  }
  // Without SMTP nothing is confirmed: admins see the request at once, on the Users page.
}

export function registerSignupRoutes(app: OpenAPIHono<AppEnv>, s: Services): void {
  const verifiedOnly = () => ({ verifiedOnly: !!s.mailer });

  const signup = defineRoute('public', {
    method: 'post',
    path: `${API}/signup`,
    tags: ['signup'],
    summary: 'Ask for access (when an admin turned sign-up on); an admin approves it',
    description:
      'Always 202 with the same body, also for an email that has an account (which gets a mail saying so, with ' +
      'SMTP), so the answer does not tell whether an email exists. With SMTP the person first confirms the email ' +
      'by a link. Limited like logins. 404 signup_closed when sign-up is off; 422 signup_refused for an email ' +
      'domain the server does not take.',
    request: { body: { required: true, content: { 'application/json': { schema: signupSchema } } } },
    responses: {
      202: json(
        z.object({
          status: z.literal('received'),
          verifyEmail: z.boolean().openapi({ description: 'A link to confirm the email was mailed' }),
        }),
        'Request received',
      ),
      ...problems(404, 422, 429),
    },
  });
  app.openapi(signup, async (c) => {
    await takeSignup(s, c, c.req.valid('json'));
    return c.json({ status: 'received' as const, verifyEmail: !!s.mailer }, 202);
  });

  const verify = defineRoute('public', {
    method: 'post',
    path: `${API}/signup/verify/{token}`,
    tags: ['signup'],
    summary: 'Confirm the email of a sign-up with the link from the mail; admins then see the request',
    request: { params: z.object({ token: z.string() }) },
    responses: { 200: json(z.object({ verified: z.literal(true) }), 'Confirmed'), ...problems(404, 410, 429) },
  });
  app.openapi(verify, async (c) => {
    if (!s.loginLimiter.hit(clientIp(c), 'one-time-link')) {
      throw new AppError('rate_limited', 429, 'Too many attempts; wait a minute and try again.');
    }
    await verifySignup(s.deps, c.req.valid('param').token);
    void notifyAdmins(s);
    return c.json({ verified: true as const }, 200);
  });

  const list = defineRoute('user.admin', {
    method: 'get',
    path: `${API}/access-requests`,
    tags: ['signup'],
    summary: 'Access requests waiting for an admin, oldest first (with SMTP: confirmed emails only)',
    responses: { 200: json(z.object({ items: z.array(AccessRequestSchema) }), 'Requests'), ...problems(401, 403) },
  });
  app.openapi(list, async (c) => c.json({ items: await listAccessRequests(s.deps, verifiedOnly()) }, 200));

  const idParam = z.object({ id: z.string() });
  const approve = defineRoute('user.admin', {
    method: 'post',
    path: `${API}/access-requests/{id}/approve`,
    tags: ['signup'],
    summary: 'Let the person in, with a global role and project memberships',
    description:
      'Body optional: `{"role":"viewer","projects":[{"slug":"web","role":"reviewer"}]}`; by default viewer, no project.',
    request: {
      params: idParam,
      body: { required: false, content: { 'application/json': { schema: approveSchema } } },
    },
    responses: { 200: json(AccessRequestSchema, 'The approved request'), ...problems(401, 403, 404, 409, 422) },
  });
  app.openapi(approve, async (c) => {
    const body = c.req.header('content-type')?.startsWith('application/json') ? c.req.valid('json') : {};
    const request = await approveAccessRequest(
      s.deps,
      c.req.valid('param').id,
      body,
      principalOf(c).id,
      verifiedOnly(),
    );
    mailDecision(s, request);
    return c.json(request, 200);
  });

  const reject = defineRoute('user.admin', {
    method: 'post',
    path: `${API}/access-requests/{id}/reject`,
    tags: ['signup'],
    summary: 'Turn the request down, with an optional reason the person sees',
    request: {
      params: idParam,
      body: { required: false, content: { 'application/json': { schema: rejectSchema } } },
    },
    responses: { 200: json(AccessRequestSchema, 'The rejected request'), ...problems(401, 403, 404, 409, 422) },
  });
  app.openapi(reject, async (c) => {
    const body = c.req.header('content-type')?.startsWith('application/json') ? c.req.valid('json') : {};
    const request = await rejectAccessRequest(s.deps, c.req.valid('param').id, body, principalOf(c).id, verifiedOnly());
    mailDecision(s, request);
    return c.json(request, 200);
  });

  const settings = defineRoute('user.admin', {
    method: 'get',
    path: `${API}/settings/signup`,
    tags: ['signup'],
    summary: 'Whether people may ask for access, and from which email domains',
    responses: { 200: json(SignupSettingsSchema, 'Sign-up settings'), ...problems(401, 403) },
  });
  app.openapi(settings, async (c) => c.json(await getSignupSettings(s.deps), 200));

  const putSettings = defineRoute('user.admin', {
    method: 'put',
    path: `${API}/settings/signup`,
    tags: ['signup'],
    summary: 'Turn sign-up on (approval) or off; domains limit it, e.g. ["company.com"] (empty: any)',
    request: { body: { required: true, content: { 'application/json': { schema: signupSettingsSchema } } } },
    responses: { 200: json(SignupSettingsSchema, 'Sign-up settings'), ...problems(401, 403, 422) },
  });
  app.openapi(putSettings, async (c) => c.json(await updateSignupSettings(s.deps, c.req.valid('json')), 200));
}
