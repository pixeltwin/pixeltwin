import { type OpenAPIHono, z } from '@hono/zod-openapi';
import { createProjectToken, createTokenSchema, deleteProjectToken, listProjectTokens } from '../../domain/auth/tokens';
import {
  createProject,
  deleteProject,
  getProjectById,
  getProjectBySlug,
  listProjects,
  updateProject,
} from '../../domain/projects';
import { createProjectSchema, updateProjectSchema } from '../../domain/schemas';
import { allowProject, principalOf } from '../auth';
import { API, type AppEnv, type Services } from '../env';
import { defineRoute } from '../route';
import { CreatedTokenSchema, json, ProjectSchema, pageOf, problems, TokenSchema } from '../schemas';

const slugParam = z.object({ slug: z.string() });
const ProjectPageSchema = pageOf(ProjectSchema, 'ProjectPage');
const TokenPageSchema = pageOf(TokenSchema, 'TokenPage');

export function registerProjectRoutes(app: OpenAPIHono<AppEnv>, s: Services): void {
  const list = defineRoute('project.read', {
    method: 'get',
    path: `${API}/projects`,
    tags: ['projects'],
    summary: 'List projects (a token sees only its own)',
    responses: { 200: json(ProjectPageSchema, 'Projects'), ...problems(401, 403) },
  });
  app.openapi(list, async (c) => {
    const principal = principalOf(c);
    const items =
      principal.kind === 'token' ? [await getProjectById(s.deps, principal.projectId)] : await listProjects(s.deps);
    return c.json({ items, nextCursor: null }, 200);
  });

  const create = defineRoute('project.admin', {
    method: 'post',
    path: `${API}/projects`,
    tags: ['projects'],
    summary: 'Create a project',
    request: { body: { required: true, content: { 'application/json': { schema: createProjectSchema } } } },
    responses: { 201: json(ProjectSchema, 'The new project'), ...problems(401, 403, 409, 422) },
  });
  app.openapi(create, async (c) => c.json(await createProject(s.deps, c.req.valid('json')), 201));

  const get = defineRoute('project.read', {
    method: 'get',
    path: `${API}/projects/{slug}`,
    tags: ['projects'],
    summary: 'Get a project',
    request: { params: slugParam },
    responses: { 200: json(ProjectSchema, 'The project'), ...problems(401, 403, 404) },
  });
  app.openapi(get, async (c) => {
    const project = await getProjectBySlug(s.deps, c.req.valid('param').slug);
    allowProject(c, project.id);
    return c.json(project, 200);
  });

  const update = defineRoute('project.admin', {
    method: 'patch',
    path: `${API}/projects/{slug}`,
    tags: ['projects'],
    summary: 'Change project settings',
    request: {
      params: slugParam,
      body: { required: true, content: { 'application/json': { schema: updateProjectSchema } } },
    },
    responses: { 200: json(ProjectSchema, 'The updated project'), ...problems(401, 403, 404, 422) },
  });
  app.openapi(update, async (c) =>
    c.json(await updateProject(s.deps, c.req.valid('param').slug, c.req.valid('json')), 200),
  );

  const remove = defineRoute('project.admin', {
    method: 'delete',
    path: `${API}/projects/{slug}`,
    tags: ['projects'],
    summary: 'Delete a project with its builds, baselines and tokens',
    request: { params: slugParam },
    responses: { 204: { description: 'Deleted' }, ...problems(401, 403, 404) },
  });
  app.openapi(remove, async (c) => {
    await deleteProject(s.deps, c.req.valid('param').slug);
    return c.body(null, 204);
  });

  const listTokens = defineRoute('project.admin', {
    method: 'get',
    path: `${API}/projects/{slug}/tokens`,
    tags: ['tokens'],
    summary: "List a project's tokens (never their secrets)",
    request: { params: slugParam },
    responses: { 200: json(TokenPageSchema, 'Tokens'), ...problems(401, 403, 404) },
  });
  app.openapi(listTokens, async (c) =>
    c.json({ items: await listProjectTokens(s.deps, c.req.valid('param').slug), nextCursor: null }, 200),
  );

  const createToken = defineRoute('project.admin', {
    method: 'post',
    path: `${API}/projects/{slug}/tokens`,
    tags: ['tokens'],
    summary: 'Create a project token for CI or an agent',
    request: {
      params: slugParam,
      body: { required: true, content: { 'application/json': { schema: createTokenSchema } } },
    },
    responses: { 201: json(CreatedTokenSchema, 'The token, shown once'), ...problems(401, 403, 404, 422) },
  });
  app.openapi(createToken, async (c) => {
    const { token, view } = await createProjectToken(s.deps, c.req.valid('param').slug, c.req.valid('json'));
    return c.json({ ...view, token }, 201);
  });

  const deleteToken = defineRoute('project.admin', {
    method: 'delete',
    path: `${API}/projects/{slug}/tokens/{id}`,
    tags: ['tokens'],
    summary: 'Revoke a project token',
    request: { params: z.object({ slug: z.string(), id: z.string() }) },
    responses: { 204: { description: 'Revoked' }, ...problems(401, 403, 404) },
  });
  app.openapi(deleteToken, async (c) => {
    const { slug, id } = c.req.valid('param');
    await deleteProjectToken(s.deps, slug, id);
    return c.body(null, 204);
  });
}
