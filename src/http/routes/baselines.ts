import { type OpenAPIHono, z } from '@hono/zod-openapi';
import { baselineHistory, promoteBranch } from '../../domain/baselines';
import { getProjectBySlug } from '../../domain/projects';
import { branchSchema, parseInput } from '../../domain/schemas';
import { allowProject, principalOf } from '../auth';
import { API, type AppEnv, type Services } from '../env';
import { defineRoute } from '../route';
import { BaselineSchema, json, PageQuerySchema, pageOf, problems } from '../schemas';

const BaselinePageSchema = pageOf(BaselineSchema, 'BaselinePage');

export function registerBaselineRoutes(app: OpenAPIHono<AppEnv>, s: Services): void {
  const history = defineRoute('project.read', {
    method: 'get',
    path: `${API}/projects/{slug}/snapshots/{snapshotKey}/baselines`,
    tags: ['baselines'],
    summary: "A snapshot's baseline history, newest first",
    request: {
      params: z.object({ slug: z.string(), snapshotKey: z.string() }),
      query: PageQuerySchema.extend({ branch: z.string().optional() }),
    },
    responses: { 200: json(BaselinePageSchema, 'Baselines'), ...problems(401, 403, 404, 422) },
  });
  app.openapi(history, async (c) => {
    const { slug, snapshotKey } = c.req.valid('param');
    allowProject(c, (await getProjectBySlug(s.deps, slug)).id);
    return c.json(await baselineHistory(s.deps, slug, snapshotKey, c.req.valid('query')), 200);
  });

  const promote = defineRoute('check.write', {
    method: 'post',
    path: `${API}/projects/{slug}/branches/{branch}/promote`,
    tags: ['baselines'],
    summary: "Copy a branch's current baselines to the main branch (after merging)",
    description: 'URL-encode the branch name: `feature%2Flogin`.',
    request: { params: z.object({ slug: z.string(), branch: z.string() }) },
    responses: {
      200: json(z.object({ promoted: z.number().int() }), 'Number of baselines promoted'),
      ...problems(400, 401, 403, 404, 422),
    },
  });
  app.openapi(promote, async (c) => {
    const { slug, branch } = c.req.valid('param');
    allowProject(c, (await getProjectBySlug(s.deps, slug)).id);
    const parsed = parseInput(z.object({ branch: branchSchema }), { branch });
    return c.json(await promoteBranch(s.deps, slug, parsed.branch, principalOf(c).id), 200);
  });
}
