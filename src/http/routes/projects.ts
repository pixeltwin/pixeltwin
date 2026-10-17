import { type OpenAPIHono, z } from '@hono/zod-openapi';
import { visibleProjects } from '../../domain/auth/access';
import { createProjectToken, createTokenSchema, deleteProjectToken, listProjectTokens } from '../../domain/auth/tokens';
import {
  addMember,
  addMemberSchema,
  listMembers,
  removeMember,
  updateMember,
  updateMemberSchema,
} from '../../domain/members';
import { createProject, deleteProject, getProjectById, getProjectBySlug, updateProject } from '../../domain/projects';
import { createProjectSchema, updateProjectSchema } from '../../domain/schemas';
import { accessFiltered } from '../access';
import { principalOf } from '../auth';
import { API, type AppEnv, type Services } from '../env';
import { defineRoute } from '../route';
import { CreatedTokenSchema, json, MemberSchema, ProjectSchema, pageOf, problems, TokenSchema } from '../schemas';

const slugParam = z.object({ slug: z.string() });
const ProjectPageSchema = pageOf(ProjectSchema, 'ProjectPage');
const TokenPageSchema = pageOf(TokenSchema, 'TokenPage');
const MemberPageSchema = pageOf(MemberSchema, 'MemberPage');
const memberParams = z.object({ slug: z.string(), userId: z.string() });

export function registerProjectRoutes(app: OpenAPIHono<AppEnv>, s: Services): void {
  const list = defineRoute('project.read', {
    method: 'get',
    path: `${API}/projects`,
    tags: ['projects'],
    summary: 'List the projects you can see (a token sees only its own)',
    description:
      'Admins see every project; other users the projects they are members of and those visible to everyone.',
    responses: { 200: json(ProjectPageSchema, 'Projects'), ...problems(401, 403) },
  });
  app.openapi(list, async (c) => {
    const principal = principalOf(c);
    const items =
      principal.kind === 'token'
        ? [await getProjectById(s.deps, principal.projectId)]
        : (await visibleProjects(s.deps, principal)).map((x) => x.project);
    accessFiltered(c);
    return c.json({ items, nextCursor: null }, 200);
  });

  const create = defineRoute('server.admin', {
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
  app.openapi(get, async (c) => c.json(await getProjectBySlug(s.deps, c.req.valid('param').slug), 200));

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
  app.openapi(update, async (c) => {
    const { slug } = c.req.valid('param');
    return c.json(await updateProject(s.deps, slug, c.req.valid('json')), 200);
  });

  const remove = defineRoute('server.admin', {
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
  app.openapi(listTokens, async (c) => {
    const { slug } = c.req.valid('param');
    return c.json({ items: await listProjectTokens(s.deps, slug), nextCursor: null }, 200);
  });

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
    const { slug } = c.req.valid('param');
    const { token, view } = await createProjectToken(s.deps, slug, c.req.valid('json'));
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

  const members = defineRoute('project.admin', {
    method: 'get',
    path: `${API}/projects/{slug}/members`,
    tags: ['members'],
    summary: "List a project's members (admins have access to every project and are not listed)",
    request: { params: slugParam },
    responses: { 200: json(MemberPageSchema, 'Members'), ...problems(401, 403, 404) },
  });
  app.openapi(members, async (c) => {
    const { slug } = c.req.valid('param');
    return c.json({ items: await listMembers(s.deps, slug), nextCursor: null }, 200);
  });

  const addOne = defineRoute('project.admin', {
    method: 'post',
    path: `${API}/projects/{slug}/members`,
    tags: ['members'],
    summary: 'Give an existing user access to the project',
    description:
      'Roles: `viewer` looks, `reviewer` also approves and rejects, `maintainer` also manages settings, tokens and ' +
      "members. Without `role` the user's global role (viewer or reviewer) is used.",
    request: {
      params: slugParam,
      body: { required: true, content: { 'application/json': { schema: addMemberSchema } } },
    },
    responses: { 201: json(MemberSchema, 'The new member'), ...problems(401, 403, 404, 409, 422) },
  });
  app.openapi(addOne, async (c) => {
    const { slug } = c.req.valid('param');
    return c.json(await addMember(s.deps, slug, c.req.valid('json')), 201);
  });

  const updateOne = defineRoute('project.admin', {
    method: 'patch',
    path: `${API}/projects/{slug}/members/{userId}`,
    tags: ['members'],
    summary: "Change a member's role (not your own: 409 own_membership)",
    request: {
      params: memberParams,
      body: { required: true, content: { 'application/json': { schema: updateMemberSchema } } },
    },
    responses: { 200: json(MemberSchema, 'The member'), ...problems(401, 403, 404, 409, 422) },
  });
  app.openapi(updateOne, async (c) => {
    const { slug, userId } = c.req.valid('param');
    return c.json(await updateMember(s.deps, slug, userId, c.req.valid('json'), principalOf(c).id), 200);
  });

  const removeOne = defineRoute('project.admin', {
    method: 'delete',
    path: `${API}/projects/{slug}/members/{userId}`,
    tags: ['members'],
    summary: 'Remove a member (not yourself: 409 own_membership)',
    request: { params: memberParams },
    responses: { 204: { description: 'Removed' }, ...problems(401, 403, 404, 409) },
  });
  app.openapi(removeOne, async (c) => {
    const { slug, userId } = c.req.valid('param');
    await removeMember(s.deps, slug, userId, principalOf(c).id);
    return c.body(null, 204);
  });
}
