import { type OpenAPIHono, z } from '@hono/zod-openapi';
import { listBranchSummaries } from '../../domain/branches';
import { createBuild, finalizeBuild, getBuild, getBuildRow, listBuilds } from '../../domain/builds';
import { getProjectBySlug } from '../../domain/projects';
import { approveBuild } from '../../domain/reviews';
import { createBuildSchema } from '../../domain/schemas';
import { allowProject, principalOf } from '../auth';
import { API, type AppEnv, type Services } from '../env';
import { defineRoute } from '../route';
import { BranchSummarySchema, BuildSchema, json, PageQuerySchema, pageOf, problems } from '../schemas';

const BuildPageSchema = pageOf(BuildSchema, 'BuildPage');
const idParam = z.object({ id: z.string() });

export function registerBuildRoutes(app: OpenAPIHono<AppEnv>, s: Services): void {
  const create = defineRoute('check.write', {
    method: 'post',
    path: `${API}/projects/{slug}/builds`,
    tags: ['builds'],
    summary: 'Open a build (idempotent on externalId)',
    request: {
      params: z.object({ slug: z.string() }),
      body: { required: true, content: { 'application/json': { schema: createBuildSchema } } },
    },
    responses: {
      200: json(BuildSchema, 'The existing build with this externalId'),
      201: json(BuildSchema, 'The new build'),
      ...problems(401, 403, 404, 422),
    },
  });
  app.openapi(create, async (c) => {
    const { slug } = c.req.valid('param');
    allowProject(c, (await getProjectBySlug(s.deps, slug)).id);
    const { build, created } = await createBuild(s.deps, slug, c.req.valid('json'));
    return created ? c.json(build, 201) : c.json(build, 200);
  });

  const list = defineRoute('project.read', {
    method: 'get',
    path: `${API}/projects/{slug}/builds`,
    tags: ['builds'],
    summary: 'List builds, newest first',
    request: {
      params: z.object({ slug: z.string() }),
      query: PageQuerySchema.extend({ branch: z.string().optional() }),
    },
    responses: { 200: json(BuildPageSchema, 'Builds'), ...problems(401, 403, 404, 422) },
  });
  app.openapi(list, async (c) => {
    const { slug } = c.req.valid('param');
    allowProject(c, (await getProjectBySlug(s.deps, slug)).id);
    return c.json(await listBuilds(s.deps, slug, c.req.valid('query')), 200);
  });

  const branches = defineRoute('project.read', {
    method: 'get',
    path: `${API}/projects/{slug}/branches`,
    tags: ['builds'],
    summary: 'List branches with their latest build: main first, then by latest build (at most 50)',
    request: { params: z.object({ slug: z.string() }) },
    responses: { 200: json(z.array(BranchSummarySchema), 'Branches'), ...problems(401, 403, 404) },
  });
  app.openapi(branches, async (c) => {
    const { slug } = c.req.valid('param');
    allowProject(c, (await getProjectBySlug(s.deps, slug)).id);
    return c.json(await listBranchSummaries(s.deps, slug), 200);
  });

  const get = defineRoute('project.read', {
    method: 'get',
    path: `${API}/builds/{id}`,
    tags: ['builds'],
    summary: 'Get a build with its verdict and counts',
    request: { params: idParam },
    responses: { 200: json(BuildSchema, 'The build'), ...problems(401, 403, 404) },
  });
  app.openapi(get, async (c) => {
    const build = await getBuild(s.deps, c.req.valid('param').id);
    allowProject(c, build.projectId);
    return c.json(build, 200);
  });

  const finalize = defineRoute('check.write', {
    method: 'post',
    path: `${API}/builds/{id}/finalize`,
    tags: ['builds'],
    summary: 'Finalize a build and get its verdict (CI gate: only "passed" is success)',
    request: { params: idParam },
    responses: { 200: json(BuildSchema, 'The finalized build'), ...problems(401, 403, 404) },
  });
  app.openapi(finalize, async (c) => {
    const { id } = c.req.valid('param');
    allowProject(c, (await getBuildRow(s.deps, id)).projectId);
    return c.json(await finalizeBuild(s.deps, id), 200);
  });

  const approveAll = defineRoute('check.review', {
    method: 'post',
    path: `${API}/builds/{id}/approve`,
    tags: ['reviews'],
    summary: 'Approve every pending check in the build',
    request: { params: idParam },
    responses: {
      200: json(z.object({ approved: z.number().int() }), 'Number of checks approved'),
      ...problems(401, 403, 404),
    },
  });
  app.openapi(approveAll, async (c) => {
    const { id } = c.req.valid('param');
    allowProject(c, (await getBuildRow(s.deps, id)).projectId);
    return c.json(await approveBuild(s.deps, id, principalOf(c).id), 200);
  });
}
