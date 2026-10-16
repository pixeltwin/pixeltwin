import { type OpenAPIHono, z } from '@hono/zod-openapi';
import { createSession, deleteSession, USER_TOKEN_PREFIX } from '../../domain/auth/sessions';
import { completeSetup, setupInputSchema } from '../../domain/auth/setup';
import { changePassword, authenticate as checkPassword, getUserRow, toUserView } from '../../domain/auth/users';
import { AppError } from '../../errors';
import { principalOf } from '../auth';
import { clientIp } from '../client-ip';
import { clearSessionCookie, setSessionCookie } from '../cookies';
import { API, type AppEnv, type Services } from '../env';
import { defineRoute } from '../route';
import { json, problems, UserSchema } from '../schemas';

const loginSchema = z.strictObject({ email: z.string().min(1).max(320), password: z.string().min(1).max(1024) });
const passwordSchema = z.strictObject({ currentPassword: z.string(), newPassword: z.string() });

export function registerAuthRoutes(app: OpenAPIHono<AppEnv>, s: Services): void {
  const setup = defineRoute('public', {
    method: 'post',
    path: `${API}/setup`,
    tags: ['auth'],
    summary: 'Create the first admin with the setup token printed in the server log',
    request: { body: { required: true, content: { 'application/json': { schema: setupInputSchema } } } },
    responses: { 201: json(UserSchema, 'The first admin'), ...problems(403, 409, 422) },
  });
  app.openapi(setup, async (c) => c.json(await completeSetup(s.deps, s.setup, c.req.valid('json')), 201));

  const login = defineRoute('public', {
    method: 'post',
    path: `${API}/auth/login`,
    tags: ['auth'],
    summary: 'Log in; sets the pt_session cookie',
    request: { body: { required: true, content: { 'application/json': { schema: loginSchema } } } },
    responses: { 200: json(UserSchema, 'The logged-in user'), ...problems(401, 422, 429) },
  });
  app.openapi(login, async (c) => {
    const { email, password } = c.req.valid('json');
    if (!s.loginLimiter.hit(clientIp(c), email)) {
      throw new AppError('rate_limited', 429, 'Too many login attempts; wait a minute and try again.');
    }
    const user = await checkPassword(s.deps, email, password);
    if (!user) throw new AppError('invalid_credentials', 401, 'The email or password is wrong.');
    setSessionCookie(c, s.config.publicUrl, await createSession(s.deps, user.id));
    return c.json(toUserView(user), 200);
  });

  const token = defineRoute('public', {
    method: 'post',
    path: `${API}/auth/token`,
    tags: ['auth'],
    summary: 'Get a personal token (Bearer pu_…) for a page served elsewhere, such as a test report',
    description:
      'Same credentials and limits as login, but no cookie: the token acts as the user (with their role) when sent ' +
      'as `Authorization: Bearer`, expires like a session, and ends when the password changes.',
    request: { body: { required: true, content: { 'application/json': { schema: loginSchema } } } },
    responses: {
      201: json(
        z.object({ token: z.string(), expiresAt: z.number().int(), user: UserSchema }),
        'The personal token and its user',
      ),
      ...problems(401, 422, 429),
    },
  });
  app.openapi(token, async (c) => {
    const { email, password } = c.req.valid('json');
    if (!s.loginLimiter.hit(clientIp(c), email)) {
      throw new AppError('rate_limited', 429, 'Too many login attempts; wait a minute and try again.');
    }
    const user = await checkPassword(s.deps, email, password);
    if (!user) throw new AppError('invalid_credentials', 401, 'The email or password is wrong.');
    const session = await createSession(s.deps, user.id, USER_TOKEN_PREFIX);
    return c.json({ token: session.token, expiresAt: session.expiresAt, user: toUserView(user) }, 201);
  });

  const logout = defineRoute('session', {
    method: 'post',
    path: `${API}/auth/logout`,
    tags: ['auth'],
    summary: 'Log out and end the session',
    responses: { 204: { description: 'Logged out' }, ...problems(401, 403) },
  });
  app.openapi(logout, async (c) => {
    const token = c.get('sessionToken');
    if (token) await deleteSession(s.deps, token);
    clearSessionCookie(c, s.config.publicUrl);
    return c.body(null, 204);
  });

  const me = defineRoute('session', {
    method: 'get',
    path: `${API}/me`,
    tags: ['auth'],
    summary: 'The logged-in user',
    responses: { 200: json(UserSchema, 'The logged-in user'), ...problems(401, 403) },
  });
  app.openapi(me, async (c) => c.json(toUserView(await getUserRow(s.deps, principalOf(c).id)), 200));

  const password = defineRoute('session', {
    method: 'put',
    path: `${API}/me/password`,
    tags: ['auth'],
    summary: 'Change your password',
    request: { body: { required: true, content: { 'application/json': { schema: passwordSchema } } } },
    responses: { 204: { description: 'Password changed' }, ...problems(401, 403, 422) },
  });
  app.openapi(password, async (c) => {
    await changePassword(s.deps, principalOf(c).id, c.req.valid('json'), c.get('sessionToken'));
    return c.body(null, 204);
  });
}
