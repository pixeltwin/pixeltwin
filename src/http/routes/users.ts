import { type OpenAPIHono, z } from '@hono/zod-openapi';
import {
  createUser,
  createUserSchema,
  deleteUser,
  listUsers,
  updateUser,
  updateUserSchema,
} from '../../domain/auth/users';
import { API, type AppEnv, type Services } from '../env';
import { defineRoute } from '../route';
import { json, pageOf, problems, UserSchema } from '../schemas';

const UserPageSchema = pageOf(UserSchema, 'UserPage');
const idParam = z.object({ id: z.string() });

export function registerUserRoutes(app: OpenAPIHono<AppEnv>, s: Services): void {
  const list = defineRoute('user.admin', {
    method: 'get',
    path: `${API}/users`,
    tags: ['users'],
    summary: 'List users',
    responses: { 200: json(UserPageSchema, 'All users'), ...problems(401, 403) },
  });
  app.openapi(list, async (c) => c.json({ items: await listUsers(s.deps), nextCursor: null }, 200));

  const create = defineRoute('user.admin', {
    method: 'post',
    path: `${API}/users`,
    tags: ['users'],
    summary: 'Create a user (there is no self-registration)',
    request: { body: { required: true, content: { 'application/json': { schema: createUserSchema } } } },
    responses: { 201: json(UserSchema, 'The new user'), ...problems(401, 403, 409, 422) },
  });
  app.openapi(create, async (c) => c.json(await createUser(s.deps, c.req.valid('json')), 201));

  const update = defineRoute('user.admin', {
    method: 'patch',
    path: `${API}/users/{id}`,
    tags: ['users'],
    summary: "Change a user's email or role",
    request: {
      params: idParam,
      body: { required: true, content: { 'application/json': { schema: updateUserSchema } } },
    },
    responses: { 200: json(UserSchema, 'The updated user'), ...problems(401, 403, 404, 409, 422) },
  });
  app.openapi(update, async (c) => c.json(await updateUser(s.deps, c.req.valid('param').id, c.req.valid('json')), 200));

  const remove = defineRoute('user.admin', {
    method: 'delete',
    path: `${API}/users/{id}`,
    tags: ['users'],
    summary: 'Delete a user (never the last admin)',
    request: { params: idParam },
    responses: { 204: { description: 'Deleted' }, ...problems(401, 403, 404, 409) },
  });
  app.openapi(remove, async (c) => {
    await deleteUser(s.deps, c.req.valid('param').id);
    return c.body(null, 204);
  });
}
